/**
 * What the distance and toll preferences do to real routes. `npm run experiment:objective`.
 *
 * THIS SCRIPT DOES NOT PICK THE CONSTANT, AND MUST NOT BE USED TO. `OBJECTIVE.secondsPerKm` is
 * derived in `config/city.ts` from a stated exchange rate a person can argue with: roughly one
 * minute saved per 2 to 3 extra kilometres. Selecting the value that minimises divergence from
 * OSRM instead would be parity chasing wearing a different hat, and would produce a number
 * defensible only by pointing at the number.
 *
 * What it IS for: showing how sensitive the routes are to the preference, so the stated value can
 * be judged rather than assumed, and so a future change is made against measurement instead of
 * intuition. The shipped value is marked in the output; the surrounding rows are context.
 *
 * ROUTE SANITY BEFORE DIVERGENCE. The columns are ordered accordingly. `overlap` (does our line
 * run along OSRM's) and `tolled km` (are we using the expressway network at all) say whether the
 * routes are sensible. `dist med` and `dist p95` say whether they agree with a reference that has
 * no distance preference at all, which is a different and lesser question.
 *
 * A KNOWN STRUCTURAL EFFECT, stated so it is not rediscovered as a surprise: a per-kilometre cost
 * is a larger FRACTION of a fast road's cost than a slow one's. At 24 s/km a motorway edge goes
 * from 40 to 64 s/km and a tertiary from 103 to 127, so the effective speed ratio between them
 * compresses from 2.57 to 1.98. The distance preference therefore also flattens the class
 * hierarchy by about a quarter. That is real and arguably correct, since fuel and wear do not care
 * how fast you are going, but it means this constant moves routes off fast roads generally and not
 * only on the near-ties it was introduced for.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUILD_AREA, OBJECTIVE, SNAP_DESTINATION_M, TURN_COST } from '../config/city.ts';
import { ROUTING_FIXTURES } from '../config/fixtures/routing.ts';
import { SnapIndex } from '../packages/engine/snap.ts';
import { Router } from '../packages/engine/dijkstra.ts';
import { parseGraphArtifact } from '../packages/engine/graphfile.ts';
import type { ObjectiveConfig } from '../packages/shared/index.ts';
import { overlapFraction } from './lib/overlap.ts';

const DATA = resolve(import.meta.dirname, '../data');
const OSRM = 'https://router.project-osrm.org';
const REQUEST_INTERVAL_MS = 1_100;
const SEED = 20260731;
const RANDOM_PAIRS = 50;
const MEDIAN_MAX = 0.03;
const P95_MAX = 0.07;
const OVERLAP_TOL_M = 25;

const base = { avoidTollsByDefault: false } as const;

const Q = OBJECTIVE.qualityByRank;

const CANDIDATES: readonly { name: string; cfg: ObjectiveConfig; note: string }[] = [
  { name: 'none', cfg: { ...base, secondsPerKm: 0, secondsPerRupee: 0 }, note: 'time only, the objective before any of this' },
  { name: 'dist-12', cfg: { ...base, secondsPerKm: 12, secondsPerRupee: 0 }, note: '1 min per 5 km, weaker than the stated band' },
  { name: 'dist-20', cfg: { ...base, secondsPerKm: 20, secondsPerRupee: 0 }, note: 'the 3 km/min end of the stated band, flat' },
  { name: 'dist-24', cfg: { ...base, secondsPerKm: 24, secondsPerRupee: 0 }, note: 'the 2.5 km/min midpoint, flat, no toll term' },
  { name: 'dist-30', cfg: { ...base, secondsPerKm: 30, secondsPerRupee: 0 }, note: 'the 2 km/min end of the stated band, flat' },
  { name: 'flat-24+12', cfg: { ...base, secondsPerKm: 24, secondsPerRupee: 3600 / 795 }, note: 'the pre-derivation objective: 12 s/km of toll implies a 795 rupees/hour value of time' },
  { name: 'qual-24', cfg: { ...base, secondsPerKm: 24, secondsPerRupee: 0, qualityByRank: Q }, note: 'quality weights with no toll term, to isolate the weights' },
  { name: 'toll-vot300', cfg: { ...OBJECTIVE, secondsPerRupee: 3600 / 300 }, note: 'the time-RICH end of the value-of-time band, 300 rupees/hour, 12 s per rupee' },
  { name: 'SHIPPED', cfg: OBJECTIVE, note: 'the stated preference: 24 s/km, class quality weights, tolls priced per road' },
  { name: 'toll-vot150', cfg: { ...OBJECTIVE, secondsPerRupee: 3600 / 150 }, note: 'the time-POOR end of the value-of-time band, 150 rupees/hour, 24 s per rupee' },
  { name: 'avoid-tolls', cfg: { ...OBJECTIVE, avoidTollsByDefault: true }, note: 'the opt-in mode, to prove it is reachable and produces routes' },
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

// ---------------------------------------------------------------------------

console.log('=== objective experiment: distance and toll preferences ===');
const artifact = parseGraphArtifact(await readFile(resolve(DATA, 'graph.bin')));
const g = artifact.graph;
const snap = new SnapIndex(g, BUILD_AREA);
let tolledEdges = 0;
for (let e = 0; e < g.edgeToll.length; e++) if (g.edgeToll[e] === 1) tolledEdges++;
console.log(
  `  graph     ${g.edgeFrom.length.toLocaleString('en-US')} edges, ${tolledEdges.toLocaleString('en-US')} tolled`,
);

interface Pair {
  readonly label: string;
  readonly a: [number, number];
  readonly b: [number, number];
}
const pairs: Pair[] = [];
for (let i = 0; i < ROUTING_FIXTURES.length; i++) {
  const f = ROUTING_FIXTURES[i] as (typeof ROUTING_FIXTURES)[number];
  const h = ROUTING_FIXTURES[(i + 1) % ROUTING_FIXTURES.length] as (typeof ROUTING_FIXTURES)[number];
  pairs.push({ label: `${f.id} to ${h.id}`, a: [f.lon, f.lat], b: [h.lon, h.lat] });
}
{
  const next = rng(SEED);
  let attempts = 0;
  let made = 0;
  while (made < RANDOM_PAIRS && attempts < RANDOM_PAIRS * 40) {
    attempts++;
    const pick = (): [number, number] => [
      BUILD_AREA.minLon + next() * (BUILD_AREA.maxLon - BUILD_AREA.minLon),
      BUILD_AREA.minLat + next() * (BUILD_AREA.maxLat - BUILD_AREA.minLat),
    ];
    const a = pick();
    const b = pick();
    if (snap.snap(a, 'destination', SNAP_DESTINATION_M) === null) continue;
    if (snap.snap(b, 'destination', SNAP_DESTINATION_M) === null) continue;
    made++;
    pairs.push({ label: `random ${made}`, a, b });
  }
}

const CACHE = resolve(DATA, 'osrm-geom.json');
type Cache = Record<string, { distance: number; duration: number; coords: [number, number][] }>;
let cache: Cache = {};
if (existsSync(CACHE)) cache = JSON.parse(await readFile(CACHE, 'utf8')) as Cache;
let fetched = 0;
for (const p of pairs) {
  if (cache[p.label] !== undefined) continue;
  const url = `${OSRM}/route/v1/driving/${p.a[0]},${p.a[1]};${p.b[0]},${p.b[1]}?overview=full&geometries=geojson`;
  const res = await fetch(url, { headers: { 'user-agent': 'wayfinder-gn objective experiment (single developer, throttled)' } });
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

const causesPath = resolve(DATA, 'divergence-causes.json');
const causes: Record<string, string> = existsSync(causesPath)
  ? (JSON.parse(await readFile(causesPath, 'utf8')) as Record<string, string>)
  : {};
console.log(`  osrm      ${Object.keys(cache).length} pairs with geometry (${fetched} fetched this run)\n`);

const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
const LANDMARK = 'gautam-buddha-university to jewar';

console.log('  ROUTE SANITY FIRST, divergence second. overlap and tolled km say whether the routes');
console.log('  are sensible; the deltas say whether they match a reference with no distance preference.\n');
console.log(
  `  ${'candidate'.padEnd(13)}${'overlap'.padStart(9)}${'slow%'.padStart(8)}${'tolled km'.padStart(11)}${'unrouted'.padStart(10)}` +
    `${'dist med'.padStart(10)}${'dist p95'.padStart(10)}${'dur med'.padStart(9)}${'GBU-Jewar'.padStart(11)}${'verdict'.padStart(9)}`,
);

for (const cand of CANDIDATES) {
  const router = new Router(g, artifact.restrictions, TURN_COST, cand.cfg);
  const deltas: number[] = [];
  const durDeltas: number[] = [];
  const overlaps: number[] = [];
  let tolledKm = 0;
  let unrouted = 0;
  let landmark = NaN;
  // Share of route distance on tertiary and below. The class hierarchy question, measured on
  // routes rather than on a table: "we now prefer village roads" is a claim about routes.
  let slowM = 0;
  let allM = 0;

  for (const p of pairs) {
    const ref = cache[p.label];
    if (ref === undefined) continue;
    const sa = snap.snap(p.a, 'destination', SNAP_DESTINATION_M);
    const sb = snap.snap(p.b, 'destination', SNAP_DESTINATION_M);
    if (sa === null || sb === null) continue;
    const r = router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction);
    // Counted, never silently skipped: "avoid tolls" can genuinely disconnect a pair, and a
    // candidate that quietly routes fewer pairs would otherwise look better than one that routes
    // them all.
    if (r === null) {
      unrouted++;
      continue;
    }
    for (const e of r.edges) {
      const len = g.edgeLengthM[e] as number;
      allM += len;
      if ((g.edgeClassRank[e] as number) >= 4) slowM += len;
    }
    const d = (r.metres - ref.distance) / ref.distance;
    deltas.push(Math.abs(d));
    durDeltas.push(Math.abs((r.driveSeconds - ref.duration) / ref.duration));
    tolledKm += r.tollMetres / 1000;
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
    `  ${cand.name.padEnd(13)}${pct(overlap).padStart(9)}${pct(allM === 0 ? 0 : slowM / allM).padStart(8)}` +
      `${tolledKm.toFixed(1).padStart(11)}${unrouted.toString().padStart(10)}` +
      `${pct(medianDist).padStart(10)}${pct(p95Dist).padStart(10)}${pct(quantile(su, 0.5)).padStart(9)}` +
      `${pct(landmark).padStart(11)}${(ok ? 'PASS' : 'FAIL').padStart(9)}`,
  );
}

console.log('\n  what each row is:');
for (const c of CANDIDATES) console.log(`    ${c.name.padEnd(13)} ${c.note}`);
console.log('\n  The shipped value is DERIVED in config/city.ts from a stated exchange rate, not chosen');
console.log('  from this table. Picking the best row here would be fitting to OSRM by another name.');
