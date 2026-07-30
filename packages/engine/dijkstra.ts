/**
 * Edge-based Dijkstra with turn-restriction support.
 *
 * WHY EDGE-BASED AND NOT VERTEX-BASED: a turn restriction is a statement about the edge you
 * ARRIVED on, so the search state has to be "which directed edge am I on", not "which vertex am
 * I at". A vertex-based search physically cannot express `no_left_turn`, because by the time it
 * is at the junction it has forgotten how it got there. That is the cost of the via-node table
 * chosen at gate 1, and it is paid here.
 *
 * VIA-WAY RESTRICTIONS need one more hop of memory: the banned triple is
 * (from edge, via edge, to edge). The search reads its own predecessor array to recover the
 * from edge, so no extra state is carried per queue entry.
 *
 * HOT PATH: restriction support costs ONE Uint8Array read per expansion. `edgeRestricted` is 1
 * for the 51 edges out of 532,951 that carry any ban, so the branch is predicted false and no
 * Map is touched for the other 99.99%. Both tables are consulted only inside that branch.
 *
 * ALLOCATION: none per query. Distances, parents and the heap are preallocated once and reused,
 * with a GENERATION counter instead of clearing. Clearing a 533k-entry Float64Array per request
 * would cost more than most searches.
 *
 * DETERMINISM: equal-cost ties break on the lower edge index, so a route never changes between
 * runs for heap-ordering reasons. Golden routes depend on this.
 */
import { haversineM } from '../shared/geo.ts';
import type { LngLat } from '../shared/index.ts';

/**
 * The sub-polyline between two fractions of a polyline's total length, endpoints interpolated.
 *
 * Fractions are by LENGTH, not by point index, because shape points are unevenly spaced: a long
 * straight run may be two points and a tight curve twenty. Indexing by point would put the
 * snapped start metres away from where the snap actually landed.
 */
function clipPolyline(pts: readonly LngLat[], from: number, to: number): LngLat[] {
  if (pts.length < 2) return [...pts];
  if (from <= 0 && to >= 1) return [...pts];

  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i] as LngLat;
    const b = pts[i + 1] as LngLat;
    const d = haversineM(a[1], a[0], b[1], b[0]);
    seg.push(d);
    total += d;
  }
  if (total === 0) return [pts[0] as LngLat];

  const startM = Math.max(0, Math.min(1, from)) * total;
  const endM = Math.max(0, Math.min(1, to)) * total;
  if (endM <= startM) {
    return [pointAt(pts, seg, startM)];
  }

  const out: LngLat[] = [pointAt(pts, seg, startM)];
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const next = acc + (seg[i] as number);
    if (next > startM && next < endM) out.push(pts[i + 1] as LngLat);
    acc = next;
  }
  out.push(pointAt(pts, seg, endM));
  return out;
}

/** The point a given distance along a polyline, interpolating within the containing segment. */
function pointAt(pts: readonly LngLat[], seg: readonly number[], distM: number): LngLat {
  let acc = 0;
  for (let i = 0; i < seg.length; i++) {
    const d = seg[i] as number;
    if (acc + d >= distM) {
      const t = d === 0 ? 0 : (distM - acc) / d;
      const a = pts[i] as LngLat;
      const b = pts[i + 1] as LngLat;
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    }
    acc += d;
  }
  return pts[pts.length - 1] as LngLat;
}

const KMH_TO_MS = 1 / 3.6;

export interface RoutableGraph {
  readonly csrOffset: Int32Array;
  readonly csrEdge: Int32Array;
  readonly edgeFrom: Int32Array;
  readonly edgeTo: Int32Array;
  readonly edgeLengthM: Float64Array;
  readonly edgeSpeedKmh: Uint8Array;
  readonly edgeWayId: Float64Array;
  readonly edgeShape: Int32Array;
  readonly edgeReversed: Uint8Array;
  readonly shapeOffset: Int32Array;
  readonly shapeLat: Int32Array;
  readonly shapeLon: Int32Array;
  readonly vertexLat: Float64Array;
}

export interface Restrictions {
  readonly banned: ReadonlyMap<number, ReadonlySet<number>>;
  readonly bannedSequences: ReadonlyMap<number, readonly { fromEdge: number; toEdge: number }[]>;
  readonly edgeRestricted: Uint8Array;
}

export interface RouteResult {
  /** Directed edges traversed, in order. */
  readonly edges: readonly number[];
  readonly seconds: number;
  readonly metres: number;
  /** Full-fidelity geometry, every shape point, clipped to the snapped start and end. */
  readonly geometry: readonly LngLat[];
  /** Search effort, for the gate 5 budget and for spotting a heuristic regression. */
  readonly settled: number;
  readonly relaxed: number;
  /** Turn manoeuvres rejected because a restriction forbade them. */
  readonly restrictionsApplied: number;
}

const COORD_SCALE = 1e7;

/** Cost of fully traversing an edge, in seconds. */
function edgeSeconds(g: RoutableGraph, e: number): number {
  return (g.edgeLengthM[e] as number) / ((g.edgeSpeedKmh[e] as number) * KMH_TO_MS);
}

/**
 * Preallocated search state, built once per loaded graph and reused for every query.
 * NOT safe for concurrent queries on one instance; the server holds one and routes serially.
 */
export class Router {
  private readonly dist: Float64Array;
  private readonly parent: Int32Array;
  private readonly stamp: Int32Array;
  private readonly settledStamp: Int32Array;
  private generation = 0;

  /** Binary min-heap over edge indices, keyed by tentative cost. */
  private readonly heapEdge: Int32Array;
  private readonly heapCost: Float64Array;
  private heapSize = 0;

  /** Shape id to its (one or two) directed edges, so a snap can seed both directions. */
  private readonly edgesOfShape: Map<number, number[]>;

  constructor(
    private readonly g: RoutableGraph,
    private readonly r: Restrictions,
  ) {
    const n = g.edgeFrom.length;
    this.dist = new Float64Array(n);
    this.parent = new Int32Array(n);
    this.stamp = new Int32Array(n);
    this.settledStamp = new Int32Array(n);
    this.heapEdge = new Int32Array(n + 1);
    this.heapCost = new Float64Array(n + 1);
    this.edgesOfShape = new Map();
    for (let e = 0; e < n; e++) {
      const s = g.edgeShape[e] as number;
      const list = this.edgesOfShape.get(s);
      if (list) list.push(e);
      else this.edgesOfShape.set(s, [e]);
    }
  }

  private push(edge: number, cost: number): void {
    let i = ++this.heapSize;
    this.heapEdge[i] = edge;
    this.heapCost[i] = cost;
    while (i > 1) {
      const p = i >> 1;
      const pc = this.heapCost[p] as number;
      const c = this.heapCost[i] as number;
      // Tie-break on edge index so ordering is total and reproducible.
      if (pc < c || (pc === c && (this.heapEdge[p] as number) <= (this.heapEdge[i] as number))) break;
      const te = this.heapEdge[p] as number;
      const tc = pc;
      this.heapEdge[p] = this.heapEdge[i] as number;
      this.heapCost[p] = c;
      this.heapEdge[i] = te;
      this.heapCost[i] = tc;
      i = p;
    }
  }

  private pop(): number {
    const top = this.heapEdge[1] as number;
    this.heapEdge[1] = this.heapEdge[this.heapSize] as number;
    this.heapCost[1] = this.heapCost[this.heapSize] as number;
    this.heapSize--;
    let i = 1;
    for (;;) {
      const l = i << 1;
      const rr = l + 1;
      let best = i;
      if (l <= this.heapSize) {
        const bc = this.heapCost[best] as number;
        const lc = this.heapCost[l] as number;
        if (lc < bc || (lc === bc && (this.heapEdge[l] as number) < (this.heapEdge[best] as number))) best = l;
      }
      if (rr <= this.heapSize) {
        const bc = this.heapCost[best] as number;
        const rc = this.heapCost[rr] as number;
        if (rc < bc || (rc === bc && (this.heapEdge[rr] as number) < (this.heapEdge[best] as number))) best = rr;
      }
      if (best === i) break;
      const te = this.heapEdge[best] as number;
      const tc = this.heapCost[best] as number;
      this.heapEdge[best] = this.heapEdge[i] as number;
      this.heapCost[best] = this.heapCost[i] as number;
      this.heapEdge[i] = te;
      this.heapCost[i] = tc;
      i = best;
    }
    return top;
  }

  /**
   * True when moving out of `via` onto `to` is forbidden.
   *
   * Only ever called when `edgeRestricted[via]` is set, so the Map lookups are off the hot path.
   * `from` is the predecessor of `via`, or -1 at the start of a search, which matches no
   * recorded triple.
   */
  private forbidden(via: number, to: number, from: number): boolean {
    const pair = this.r.banned.get(via);
    if (pair !== undefined && pair.has(to)) return true;
    const seq = this.r.bannedSequences.get(via);
    if (seq !== undefined) {
      for (const s of seq) {
        if (s.toEdge === to && s.fromEdge === from) return true;
      }
    }
    return false;
  }

  /**
   * Shortest-time route between two snapped points.
   *
   * `startFraction` and `endFraction` run 0..1 along the DIRECTED edge given. Both directed
   * edges of the snapped segment are seeded, because a driver on a two-way road may legally
   * leave in either direction and picking one arbitrarily produces a route that starts with a
   * phantom U-turn.
   */
  route(
    startEdge: number,
    startFraction: number,
    endEdge: number,
    endFraction: number,
  ): RouteResult | null {
    const g = this.g;
    const gen = ++this.generation;
    this.heapSize = 0;
    let settled = 0;
    let relaxed = 0;
    let restrictionsApplied = 0;

    const endShape = g.edgeShape[endEdge] as number;
    const endCandidates = this.edgesOfShape.get(endShape) ?? [endEdge];
    // Fraction is measured along the given directed edge; the opposite edge measures from the
    // other end, so it has to be mirrored rather than reused.
    const endFractionOf = (e: number): number =>
      e === endEdge ? endFraction : 1 - endFraction;

    const startShape = g.edgeShape[startEdge] as number;
    for (const se of this.edgesOfShape.get(startShape) ?? [startEdge]) {
      const frac = se === startEdge ? startFraction : 1 - startFraction;
      const remaining = (1 - frac) * edgeSeconds(g, se);
      this.dist[se] = remaining;
      this.parent[se] = -1;
      this.stamp[se] = gen;
      this.push(se, remaining);
    }

    let bestEnd = -1;
    let bestTotal = Infinity;

    while (this.heapSize > 0) {
      const e = this.pop();
      if (this.settledStamp[e] === gen) continue;
      this.settledStamp[e] = gen;
      settled++;
      const de = this.dist[e] as number;

      // Reaching the end segment: stop partway along it rather than at its far vertex.
      for (const ec of endCandidates) {
        if (ec !== e) continue;
        // If this is the seeded start edge, the destination is only reachable without leaving it
        // when it lies FURTHER along the direction of travel. Otherwise the driver must go round,
        // and the search finds that path by arriving on this edge again from elsewhere.
        const seededFrac = e === startEdge ? startFraction : (g.edgeShape[e] === startShape ? 1 - startFraction : -1);
        if (seededFrac >= 0 && (this.parent[e] as number) === -1 && endFractionOf(e) < seededFrac) continue;
        const total = de - (1 - endFractionOf(e)) * edgeSeconds(g, e);
        if (total < bestTotal) {
          bestTotal = total;
          bestEnd = e;
        }
      }
      // Everything still queued costs at least `de`, so once the best completion is cheaper
      // than the frontier there is nothing left that can improve it.
      if (bestEnd !== -1 && de >= bestTotal) break;

      const v = g.edgeTo[e] as number;
      const from = this.parent[e] as number;
      const restricted = this.r.edgeRestricted[e] === 1;
      const start = g.csrOffset[v] as number;
      const end = g.csrOffset[v + 1] as number;

      for (let i = start; i < end; i++) {
        const f = g.csrEdge[i] as number;
        if (restricted && this.forbidden(e, f, from)) {
          restrictionsApplied++;
          continue;
        }
        const nd = de + edgeSeconds(g, f);
        relaxed++;
        if (this.stamp[f] !== gen) {
          this.stamp[f] = gen;
          this.dist[f] = nd;
          this.parent[f] = e;
          this.push(f, nd);
        } else if (nd < (this.dist[f] as number)) {
          this.dist[f] = nd;
          this.parent[f] = e;
          this.push(f, nd);
        }
      }
    }

    if (bestEnd === -1) return null;

    const edges: number[] = [];
    for (let e = bestEnd; e !== -1; e = this.parent[e] as number) edges.push(e);
    edges.reverse();

    const firstEdge = edges[0] as number;
    const firstFraction =
      (this.parent[firstEdge] as number) === -1
        ? (firstEdge === startEdge ? startFraction : 1 - startFraction)
        : 0;
    const geometry = this.buildGeometry(edges, firstFraction, endFractionOf(bestEnd));
    let metres = 0;
    for (const e of edges) metres += g.edgeLengthM[e] as number;
    metres -= firstFraction * (g.edgeLengthM[firstEdge] as number);
    metres -= (1 - endFractionOf(bestEnd)) * (g.edgeLengthM[bestEnd] as number);

    return {
      edges,
      seconds: bestTotal,
      metres,
      geometry,
      settled,
      relaxed,
      restrictionsApplied,
    };
  }

  /**
   * Every shape point of every edge, in travel order, trimmed at both ends.
   *
   * Charter item 1: the route line must lie exactly on the drawn road, so the geometry is the
   * road's own shape points, never the straight vertex-to-vertex chords. A reversed edge shares
   * the forward edge's shape and must be walked backwards.
   */
  private buildGeometry(
    edges: readonly number[],
    firstFraction: number,
    lastFraction: number,
  ): LngLat[] {
    const g = this.g;
    const out: LngLat[] = [];

    for (let idx = 0; idx < edges.length; idx++) {
      const e = edges[idx] as number;
      const pts = this.shapeInTravelOrder(e);
      const isFirst = idx === 0;
      const isLast = idx === edges.length - 1;

      // Trim to the snapped positions. Without this the line starts at the road's nearest
      // junction rather than beside the car, which is exactly the "route line does not match
      // where I am" defect charter item 1 forbids.
      const from = isFirst ? firstFraction : 0;
      const to = isLast ? lastFraction : 1;
      const clipped = clipPolyline(pts, from, to);

      for (const p of clipped) {
        // Consecutive edges share a vertex; emitting it twice leaves a zero-length segment,
        // which some renderers turn into a visible spike at every junction.
        const last = out[out.length - 1];
        if (last !== undefined && last[0] === p[0] && last[1] === p[1]) continue;
        out.push(p);
      }
    }
    return out;
  }

  /** An edge's shape points ordered along the direction of travel. */
  private shapeInTravelOrder(e: number): LngLat[] {
    const g = this.g;
    const s = g.edgeShape[e] as number;
    const from = g.shapeOffset[s] as number;
    const to = g.shapeOffset[s + 1] as number;
    const reversed = g.edgeReversed[e] === 1;
    const pts: LngLat[] = [];
    const count = to - from;
    for (let k = 0; k < count; k++) {
      const i = reversed ? to - 1 - k : from + k;
      pts.push([(g.shapeLon[i] as number) / COORD_SCALE, (g.shapeLat[i] as number) / COORD_SCALE]);
    }
    return pts;
  }
}
