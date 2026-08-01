/**
 * Calibrate the turn cost model against the validation set. `npm run experiment:turns`.
 *
 * NOT against another router's constants. OSRM's turn penalty is tuned for OSRM's speed profile
 * and OSRM's road network; copying the number would import a decision nobody here examined. These
 * values are swept over the same 56 pairs `npm run validate` uses, and each is judged on what it
 * does to the delta distribution.
 *
 * TERMS ARE ISOLATED, not only tuned together. A candidate that turns off every term but one says
 * which term is doing the work. Sweeping all four at once produces a winning combination and no
 * understanding, and the next person to touch it has nothing to reason from.
 *
 * SHAPE IS MEASURED, NOT ONLY THE NUMBER. A distance delta can fall to zero while the route runs
 * down a completely different road, which would mean the model got the right answer by accident.
 * `overlap` is the fraction of OUR route's length that lies within `OVERLAP_TOL_M` of OSRM's line.
 * Convergence in shape AND number means the gap was real; an unchanged shape with a better number
 * means the metric moved and the route did not.
 *
 * THE SPEED TABLE IS HELD FIXED THROUGHOUT. Two variables in motion at once makes neither result
 * attributable, and the speed table was already shown to be locally grounded.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUILD_AREA, SNAP_DESTINATION_M, TURN_COST } from '../config/city.ts';
import { ROUTING_FIXTURES } from '../config/fixtures/routing.ts';
import { SnapIndex } from '../packages/engine/snap.ts';
import { Router } from '../packages/engine/dijkstra.ts';
import { parseGraphArtifact } from '../packages/engine/graphfile.ts';
import { haversineM } from '../packages/shared/geo.ts';
import type { LngLat, TurnCostConfig } from '../packages/shared/index.ts';

const DATA = resolve(import.meta.dirname, '../data');
const OSRM = 'https://router.project-osrm.org';
const REQUEST_INTERVAL_MS = 1_100;
const SEED = 20260731;
const RANDOM_PAIRS = 50;
const MEDIAN_MAX = 0.03;
const P95_MAX = 0.07;

/** Same tolerance the divergence diagnosis uses, for the same reason: both lines come from OSM. */
const OVERLAP_TOL_M = 25;

const ZERO: TurnCostConfig = {
  straightDeg: 25, turnS: 0, crossTrafficS: 0, crossMinDeg: 40,
  classDropS: 0, uTurnS: 0, drivesOnLeft: true,
};

const CANDIDATES: readonly { name: string; cfg: TurnCostConfig }[] = [
  { name: 'off', cfg: ZERO },
  { name: 'severity-only', cfg: { ...ZERO, turnS: 5 } },
  { name: 'crossing-only', cfg: { ...ZERO, crossTrafficS: 6 } },
  { name: 'classdrop-only', cfg: { ...ZERO, classDropS: 4 } },
  { name: 'uturn-only', cfg: { ...ZERO, uTurnS: 40 } },
  { name: 'shipped', cfg: TURN_COST },
  { name: 'gentle', cfg: { ...TURN_COST, turnS: 3, crossTrafficS: 3, classDropS: 2, uTurnS: 20 } },
  { name: 'class-heavy', cfg: { ...TURN_COST, turnS: 3, crossTrafficS: 4, classDropS: 10 } },
  { name: 'strong', cfg: { ...TURN_COST, turnS: 8, crossTrafficS: 10, classDropS: 8, uTurnS: 60 } },
];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo] as number;
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (i - lo);
}

/**
 * Fraction of `ours` (by length) running within `tolM` of the polyline `theirs`.
 *
 * A grid over `theirs`'s segments, because the naive form is quadratic and both lines can carry a
 * few thousand points. Cells are about 110 m so a 25 m tolerance never needs more than the
 * immediate ring.
 */
function overlapFraction(ours: readonly LngLat[], theirs: readonly LngLat[], tolM: number): number {
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

// ---------------------------------------------------------------------------

console.log('=== turn cost calibration ===');
const artifact = parseGraphArtifact(await readFile(resolve(DATA, 'graph.bin')));
const g = artifact.graph;
const snap = new SnapIndex(g, BUILD_AREA);
console.log(`  graph     ${g.edgeFrom.length.toLocaleString('en-US')} directed edges`);

interface Pair {
  readonly label: string;
  readonly kind: 'landmark' | 'random';
  readonly a: [number, number];
  readonly b: [number, number];
}
const pairs: Pair[] = [];
for (let i = 0; i < ROUTING_FIXTURES.length; i++) {
  const f = ROUTING_FIXTURES[i] as (typeof ROUTING_FIXTURES)[number];
  const h = ROUTING_FIXTURES[(i + 1) % ROUTING_FIXTURES.length] as (typeof ROUTING_FIXTURES)[number];
  pairs.push({ label: `${f.id} to ${h.id}`, kind: 'landmark', a: [f.lon, f.lat], b: [h.lon, h.lat] });
}
{
  const next = rng(SEED);
  let attempts = 0;
  while (pairs.filter((p) => p.kind === 'random').length < RANDOM_PAIRS && attempts < RANDOM_PAIRS * 40) {
    attempts++;
    const pick = (): [number, number] => [
      BUILD_AREA.minLon + next() * (BUILD_AREA.maxLon - BUILD_AREA.minLon),
      BUILD_AREA.minLat + next() * (BUILD_AREA.maxLat - BUILD_AREA.minLat),
    ];
    const a = pick();
    const b = pick();
    if (snap.snap(a, 'destination', SNAP_DESTINATION_M) === null) continue;
    if (snap.snap(b, 'destination', SNAP_DESTINATION_M) === null) continue;
    pairs.push({ label: `random ${pairs.filter((p) => p.kind === 'random').length + 1}`, kind: 'random', a, b });
  }
}

// ---- OSRM reference WITH geometry, fetched once. Shape convergence needs the line, not the total.
const CACHE = resolve(DATA, 'osrm-geom.json');
type Cache = Record<string, { distance: number; duration: number; coords: [number, number][] }>;
let cache: Cache = {};
if (existsSync(CACHE)) cache = JSON.parse(await readFile(CACHE, 'utf8')) as Cache;
let fetched = 0;
for (const p of pairs) {
  if (cache[p.label] !== undefined) continue;
  const url = `${OSRM}/route/v1/driving/${p.a[0]},${p.a[1]};${p.b[0]},${p.b[1]}?overview=full&geometries=geojson`;
  const res = await fetch(url, { headers: { 'user-agent': 'wayfinder-gn turn calibration (single developer, throttled)' } });
  await sleep(REQUEST_INTERVAL_MS);
  if (!res.ok) continue;
  const body = (await res.json()) as {
    code?: string;
    routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[];
  };
  if (body.code !== 'Ok' || body.routes === undefined || body.routes.length === 0) continue;
  const r = body.routes[0] as NonNullable<typeof body.routes>[number];
  cache[p.label] = { distance: r.distance, duration: r.duration, coords: r.geometry.coordinates };
  fetched++;
}
if (fetched > 0) await writeFile(CACHE, JSON.stringify(cache), 'utf8');
console.log(`  osrm      ${Object.keys(cache).length} pairs with geometry (${fetched} fetched this run)\n`);

const causesPath = resolve(DATA, 'divergence-causes.json');
const causes: Record<string, string> = existsSync(causesPath)
  ? (JSON.parse(await readFile(causesPath, 'utf8')) as Record<string, string>)
  : {};

const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
const LANDMARK = 'gautam-buddha-university to jewar';

console.log(
  `  ${'candidate'.padEnd(16)}${'dist med'.padStart(10)}${'dist p95'.padStart(10)}${'dur med'.padStart(10)}` +
    `${'overlap'.padStart(10)}${'GBU-Jewar'.padStart(12)}${'turn min'.padStart(10)}${'verdict'.padStart(9)}`,
);

interface Outcome {
  readonly name: string;
  readonly medianDist: number;
  readonly p95Dist: number;
  readonly overlap: number;
  readonly landmark: number;
  readonly perPair: ReadonlyMap<string, number>;
}
const outcomes: Outcome[] = [];

for (const cand of CANDIDATES) {
  const router = new Router(g, artifact.restrictions, cand.cfg);
  const deltas: number[] = [];
  const durDeltas: number[] = [];
  const overlaps: number[] = [];
  const perPair = new Map<string, number>();
  let landmark = NaN;
  let turnTotal = 0;

  for (const p of pairs) {
    const ref = cache[p.label];
    if (ref === undefined) continue;
    const sa = snap.snap(p.a, 'destination', SNAP_DESTINATION_M);
    const sb = snap.snap(p.b, 'destination', SNAP_DESTINATION_M);
    if (sa === null || sb === null) continue;
    const r = router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction);
    if (r === null) continue;
    const d = (r.metres - ref.distance) / ref.distance;
    deltas.push(Math.abs(d));
    // Duration compared on DRIVE TIME only. Turn penalties are our modelling choice and OSRM's
    // duration does not contain ours, so leaving them in would compare a model against a
    // measurement and make every candidate look worse the more it penalises.
    durDeltas.push(Math.abs((r.seconds - r.turnSeconds - ref.duration) / ref.duration));
    perPair.set(p.label, d);
    turnTotal += r.turnSeconds;
    // Shape convergence only where the comparison is meaningful: on a pair OSRM answered by
    // leaving BUILD_AREA, its line runs down roads we do not have and overlap can never reach 1.
    if (causes[p.label] !== 'OUTSIDE AREA') overlaps.push(overlapFraction(r.geometry, ref.coords, OVERLAP_TOL_M));
    if (p.label === LANDMARK) landmark = d;
  }

  const sd = [...deltas].sort((x, y) => x - y);
  const su = [...durDeltas].sort((x, y) => x - y);
  const medianDist = quantile(sd, 0.5);
  const p95Dist = quantile(sd, 0.95);
  const overlap = overlaps.length === 0 ? 0 : overlaps.reduce((a, b) => a + b, 0) / overlaps.length;
  const ok = medianDist <= MEDIAN_MAX && p95Dist <= P95_MAX;
  console.log(
    `  ${cand.name.padEnd(16)}${pct(medianDist).padStart(10)}${pct(p95Dist).padStart(10)}` +
      `${pct(quantile(su, 0.5)).padStart(10)}${pct(overlap).padStart(10)}${pct(landmark).padStart(12)}` +
      `${(turnTotal / 60).toFixed(1).padStart(10)}${(ok ? 'PASS' : 'FAIL').padStart(9)}`,
  );
  outcomes.push({ name: cand.name, medianDist, p95Dist, overlap, landmark, perPair });
}

console.log('\n  overlap is the share of OUR route length within 25 m of OSRM\'s line, averaged over the');
console.log('  40 pairs that stayed inside BUILD_AREA. It answers whether the SHAPE converged or only');
console.log('  the number. "turn min" is the total turn penalty charged across all 56 routes.\n');

const base = outcomes.find((o) => o.name === 'off');
if (base !== undefined) {
  for (const o of outcomes) {
    if (o.name === 'off') continue;
    const moved = [...o.perPair]
      .map(([label, d]) => ({ label, d, was: base.perPair.get(label) ?? 0 }))
      .filter((x) => Math.abs(x.d - x.was) > 0.02);
    const helped = moved.filter((x) => Math.abs(x.d) < Math.abs(x.was)).length;
    const hurt = moved.filter((x) => Math.abs(x.d) > Math.abs(x.was)).length;
    console.log(
      `  ${o.name.padEnd(16)} ${moved.length} pairs moved over 2 points: ${helped} improved, ${hurt} worsened. ` +
        `overlap ${pct(base.overlap)} -> ${pct(o.overlap)}`,
    );
  }
}
