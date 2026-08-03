/**
 * How much of one route runs along another. The SHAPE measure.
 *
 * WHY IT EXISTS. A distance delta can fall to zero while the route runs down a completely
 * different road, which means the model got the right number by accident. Overlap answers the
 * question the delta cannot: did the route converge, or only the metric. Both are reported by
 * every calibration script, and a number that improves while the shape does not is treated as a
 * warning rather than a result.
 *
 * Lives here rather than being copied into each experiment because two copies of a geometric
 * measure drift, and then two scripts disagree about the same pair for reasons nobody can find.
 */
import { haversineM } from '../../packages/shared/geo.ts';
import type { LngLat } from '../../packages/shared/index.ts';

/**
 * Fraction of `ours` (by LENGTH, not by point count) running within `tolM` of the polyline
 * `theirs`.
 *
 * Length weighted on purpose: shape points are unevenly spaced, so counting points would let a
 * tightly curved 100 m stretch outvote a straight 5 km one.
 *
 * A grid over `theirs`'s segments, because the naive form is quadratic and both lines can carry a
 * few thousand points. Cells are about 110 m, so a 25 m tolerance never needs more than the
 * immediate ring.
 */
export function overlapFraction(ours: readonly LngLat[], theirs: readonly LngLat[], tolM: number): number {
  if (ours.length < 2 || theirs.length < 2) return 0;
  const CELL = 0.001;
  const key = (r: number, c: number): number => r * 1_000_000 + c;
  const grid = new Map<number, number[]>();
  const rowOf = (lat: number): number => Math.floor(lat / CELL);
  const colOf = (lon: number): number => Math.floor(lon / CELL);
  for (let i = 0; i + 1 < theirs.length; i++) {
    const a = theirs[i] as LngLat;
    const b = theirs[i + 1] as LngLat;
    const r0 = Math.min(rowOf(a[1]), rowOf(b[1]));
    const r1 = Math.max(rowOf(a[1]), rowOf(b[1]));
    const c0 = Math.min(colOf(a[0]), colOf(b[0]));
    const c1 = Math.max(colOf(a[0]), colOf(b[0]));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = key(r, c);
        const list = grid.get(k);
        if (list) list.push(i);
        else grid.set(k, [i]);
      }
    }
  }

  const distToSeg = (plat: number, plon: number, i: number): number => {
    const a = theirs[i] as LngLat;
    const b = theirs[i + 1] as LngLat;
    const kx = Math.cos((plat * Math.PI) / 180);
    const dx = (b[0] - a[0]) * kx;
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : (((plon - a[0]) * kx * dx + (plat - a[1]) * dy) / len2);
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    return haversineM(plat, plon, a[1] + t * dy, a[0] + t * (b[0] - a[0]));
  };

  let total = 0;
  let covered = 0;
  for (let i = 0; i + 1 < ours.length; i++) {
    const a = ours[i] as LngLat;
    const b = ours[i + 1] as LngLat;
    const segM = haversineM(a[1], a[0], b[1], b[0]);
    if (segM === 0) continue;
    total += segM;
    const plat = (a[1] + b[1]) / 2;
    const plon = (a[0] + b[0]) / 2;
    const r = rowOf(plat);
    const c = colOf(plon);
    let best = Infinity;
    for (let rr = r - 1; rr <= r + 1 && best > tolM; rr++) {
      for (let cc = c - 1; cc <= c + 1 && best > tolM; cc++) {
        const list = grid.get(key(rr, cc));
        if (list === undefined) continue;
        for (const si of list) {
          const d = distToSeg(plat, plon, si);
          if (d < best) best = d;
          if (best <= tolM) break;
        }
      }
    }
    if (best <= tolM) covered += segM;
  }
  return total === 0 ? 0 : covered / total;
}
