/**
 * Snapping a coordinate onto the road network.
 *
 * TWO RADII, TWO CODE PATHS, and they are not one tunable. `SNAP_TRACKING_M` (40 m) is tight:
 * a GPS fix further than that from any road means the MATCHER is wrong, and widening it hides a
 * broken matcher behind a passing test. `SNAP_DESTINATION_M` (500 m) is generous: a tapped
 * destination may legitimately sit off-road, in the middle of a campus or a field. A tracking
 * call that uses the destination radius is a bug, which is why `purpose` is required rather
 * than defaulted.
 *
 * The projected point is ON the edge, never the input point. Charter item 2: a snapped position
 * that is merely "near" the road is what makes a blue dot swim beside the carriageway.
 *
 * Index is a uniform lat/lon grid over the build area. A grid beats a k-d tree here because
 * edges are line segments, not points: a segment is registered in every cell its bounding box
 * touches, and a query only has to widen its ring until the nearest candidate cannot be beaten.
 */
import { haversineM } from '../shared/geo.ts';
import type { LngLat, SnapPurpose, SnapResult } from '../shared/index.ts';

const COORD_SCALE = 1e7;

export interface SnapGraph {
  readonly edgeFrom: Int32Array;
  readonly edgeShape: Int32Array;
  readonly edgeReversed: Uint8Array;
  readonly edgePrivate: Uint8Array;
  readonly shapeOffset: Int32Array;
  readonly shapeLat: Int32Array;
  readonly shapeLon: Int32Array;
}

export interface SnapIndexStats {
  readonly cells: number;
  readonly occupiedCells: number;
  readonly entries: number;
  readonly maxCellOccupancy: number;
  readonly buildSeconds: number;
}

/** Roughly 500 m of latitude. Small enough that a cell holds few edges, big enough to be sparse. */
const CELL_DEG = 0.0045;

export class SnapIndex {
  private readonly minLat: number;
  private readonly minLon: number;
  private readonly cols: number;
  private readonly rows: number;
  /** CSR-style: cellStart[c]..cellStart[c+1] indexes into cellEdges. */
  private readonly cellStart: Int32Array;
  private readonly cellEdges: Int32Array;
  readonly stats: SnapIndexStats;

  constructor(private readonly g: SnapGraph, bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number }) {
    const t0 = performance.now();
    this.minLat = bounds.minLat;
    this.minLon = bounds.minLon;
    this.rows = Math.max(1, Math.ceil((bounds.maxLat - bounds.minLat) / CELL_DEG) + 1);
    this.cols = Math.max(1, Math.ceil((bounds.maxLon - bounds.minLon) / CELL_DEG) + 1);
    const cellCount = this.rows * this.cols;

    const edgeCount = g.edgeFrom.length;
    const counts = new Int32Array(cellCount + 1);
    const touched: number[] = [];

    const cellsOf = (e: number, out: number[]): void => {
      out.length = 0;
      const s = g.edgeShape[e] as number;
      const from = g.shapeOffset[s] as number;
      const to = g.shapeOffset[s + 1] as number;
      let minR = Infinity;
      let maxR = -Infinity;
      let minC = Infinity;
      let maxC = -Infinity;
      for (let i = from; i < to; i++) {
        const r = this.rowOf((g.shapeLat[i] as number) / COORD_SCALE);
        const c = this.colOf((g.shapeLon[i] as number) / COORD_SCALE);
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
      for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) out.push(r * this.cols + c);
      }
    };

    for (let e = 0; e < edgeCount; e++) {
      cellsOf(e, touched);
      for (const c of touched) counts[c + 1] = (counts[c + 1] as number) + 1;
    }
    for (let c = 0; c < cellCount; c++) counts[c + 1] = (counts[c + 1] as number) + (counts[c] as number);
    this.cellStart = counts;
    this.cellEdges = new Int32Array(counts[cellCount] as number);
    const cursor = Int32Array.from(counts.subarray(0, cellCount));
    for (let e = 0; e < edgeCount; e++) {
      cellsOf(e, touched);
      for (const c of touched) {
        this.cellEdges[cursor[c] as number] = e;
        cursor[c] = (cursor[c] as number) + 1;
      }
    }

    let occupied = 0;
    let maxOcc = 0;
    for (let c = 0; c < cellCount; c++) {
      const n = (counts[c + 1] as number) - (counts[c] as number);
      if (n > 0) occupied++;
      if (n > maxOcc) maxOcc = n;
    }
    this.stats = {
      cells: cellCount,
      occupiedCells: occupied,
      entries: this.cellEdges.length,
      maxCellOccupancy: maxOcc,
      buildSeconds: Number(((performance.now() - t0) / 1000).toFixed(2)),
    };
  }

  private rowOf(lat: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((lat - this.minLat) / CELL_DEG)));
  }
  private colOf(lon: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((lon - this.minLon) / CELL_DEG)));
  }

  /**
   * Nearest point on any edge, or null when nothing lies within `maxDistanceM`.
   *
   * Returning null rather than the nearest-at-any-distance is deliberate: the caller must decide
   * what to do about an unsnappable point, and a silent 3 km snap is how a route starts in the
   * wrong village.
   */
  snap(point: LngLat, purpose: SnapPurpose, maxDistanceM: number, opts?: { excludePrivate?: boolean }): SnapResult | null {
    const [lon, lat] = point;
    const excludePrivate = opts?.excludePrivate === true;

    let best: { edge: number; d: number; plat: number; plon: number; frac: number } | null = null;
    // Widen the ring until the best candidate cannot be beaten by anything further out.
    const maxRing = Math.ceil(maxDistanceM / (CELL_DEG * 111_320)) + 1;
    const r0 = this.rowOf(lat);
    const c0 = this.colOf(lon);
    const seen = new Set<number>();

    for (let ring = 0; ring <= maxRing; ring++) {
      if (best !== null && best.d < ring * CELL_DEG * 111_320 * 0.9) break;
      for (let r = r0 - ring; r <= r0 + ring; r++) {
        if (r < 0 || r >= this.rows) continue;
        for (let c = c0 - ring; c <= c0 + ring; c++) {
          if (c < 0 || c >= this.cols) continue;
          // Only the ring's perimeter is new on each pass.
          if (ring > 0 && Math.abs(r - r0) !== ring && Math.abs(c - c0) !== ring) continue;
          const cell = r * this.cols + c;
          const from = this.cellStart[cell] as number;
          const to = this.cellStart[cell + 1] as number;
          for (let i = from; i < to; i++) {
            const e = this.cellEdges[i] as number;
            if (seen.has(e)) continue;
            seen.add(e);
            if (excludePrivate && this.g.edgePrivate[e] === 1) continue;
            const cand = this.projectOntoEdge(e, lat, lon);
            if (best === null || cand.d < best.d) best = { edge: e, ...cand };
          }
        }
      }
    }

    if (best === null || best.d > maxDistanceM) return null;
    return {
      point: [best.plon, best.plat],
      edgeId: best.edge,
      fraction: best.frac,
      distanceM: best.d,
      purpose,
    };
  }

  /** Closest point on one edge's polyline, with the fraction along its full shape. */
  private projectOntoEdge(e: number, lat: number, lon: number): { d: number; plat: number; plon: number; frac: number } {
    const g = this.g;
    const s = g.edgeShape[e] as number;
    const from = g.shapeOffset[s] as number;
    const to = g.shapeOffset[s + 1] as number;

    let bestD = Infinity;
    let bestLat = 0;
    let bestLon = 0;
    let bestSeg = 0;
    let bestT = 0;
    const segLen: number[] = [];
    let total = 0;

    for (let i = from; i < to - 1; i++) {
      const alat = (g.shapeLat[i] as number) / COORD_SCALE;
      const alon = (g.shapeLon[i] as number) / COORD_SCALE;
      const blat = (g.shapeLat[i + 1] as number) / COORD_SCALE;
      const blon = (g.shapeLon[i + 1] as number) / COORD_SCALE;

      // Project in a local equirectangular frame. Over a single road segment, tens of metres,
      // the distortion is far below GPS noise, and it keeps the projection a simple dot product.
      const kx = Math.cos((lat * Math.PI) / 180);
      const dx = (blon - alon) * kx;
      const dy = blat - alat;
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : (((lon - alon) * kx * dx + (lat - alat) * dy) / len2);
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const plat = alat + t * dy;
      const plon = alon + t * (blon - alon);
      const d = haversineM(lat, lon, plat, plon);
      const l = haversineM(alat, alon, blat, blon);
      segLen.push(l);
      total += l;
      if (d < bestD) {
        bestD = d;
        bestLat = plat;
        bestLon = plon;
        bestSeg = i - from;
        bestT = t;
      }
    }

    if (segLen.length === 0) {
      const plat = (g.shapeLat[from] as number) / COORD_SCALE;
      const plon = (g.shapeLon[from] as number) / COORD_SCALE;
      return { d: haversineM(lat, lon, plat, plon), plat, plon, frac: 0 };
    }

    let along = 0;
    for (let i = 0; i < bestSeg; i++) along += segLen[i] as number;
    along += (segLen[bestSeg] as number) * bestT;
    let frac = total === 0 ? 0 : along / total;
    // The two directed edges of one segment share a shape; a reversed edge measures from the
    // other end, or the fraction disagrees with the direction of travel.
    if (g.edgeReversed[e] === 1) frac = 1 - frac;
    return { d: bestD, plat: bestLat, plon: bestLon, frac };
  }
}
