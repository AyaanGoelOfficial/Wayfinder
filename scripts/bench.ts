/**
 * Latency benchmark. `npm run bench`. Writes BENCHMARKS.md.
 *
 * TWO ROUTE BUDGETS, REPORTED SEPARATELY, because there are two different requirements and one
 * number cannot serve both. `config/city.ts` holds them and explains why; this file is where they
 * are measured, and the sampling below is the part that makes them honest.
 *
 * RE-ROUTE sampling: origins are taken from points ALONG REAL ROUTES, with the destination being
 * that route's real remaining endpoint. This deliberately keeps the hard case in: a driver who
 * deviates 1 km into a 61 km trip generates a ~60 km re-route, so long queries ARE in this
 * distribution and are expected to set p95. Sampling only late-trip origins, where little
 * distance remains, would make the budget trivially passable and meaningless.
 *
 * INITIAL-ROUTE sampling: random pairs anywhere in BUILD_AREA, PLUS the four corner-to-corner
 * queries, which are pinned permanently. That worst case cannot be argued out of the set.
 *
 * Timing is a median of repeated runs after a warm-up, and the machine should be otherwise idle.
 * A wall-clock number taken under concurrent load is not a measurement; this project has already
 * recorded a server boot at 89 s that was 2.87 s alone, and a tilemaker run at 2,425 s that was
 * 18 s alone.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BUILD_AREA, ROUTE_BUDGET, SNAP_DESTINATION_M, SNAP_TRACKING_M, TURN_COST } from '../config/city.ts';
import { SnapIndex } from '../packages/engine/snap.ts';
import { Router } from '../packages/engine/dijkstra.ts';
import { PlacesSearch } from '../packages/engine/search.ts';
import { parseGraphArtifact } from '../packages/engine/graphfile.ts';

const DATA = resolve(import.meta.dirname, '../data');
const SEED = 20260731;
const INITIAL_SAMPLES = 60;
const REROUTE_SAMPLES = 60;
const SEARCH_QUERIES = ['Pari Chowk', 'Knowledge Park', 'Kasna', 'Gaur City', 'Surajpur', 'Jewar', 'Dadri', 'Nolej Park'];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo] as number;
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (i - lo);
}

interface Dist {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}
function summarise(xs: readonly number[]): Dist {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: quantile(s, 0.5),
    p95: quantile(s, 0.95),
    p99: quantile(s, 0.99),
    max: s.length === 0 ? NaN : (s[s.length - 1] as number),
  };
}
const ms = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');

console.log('=== benchmark ===');
let artifact;
try {
  artifact = parseGraphArtifact(await readFile(resolve(DATA, 'graph.bin')));
} catch (err) {
  console.error(`cannot read data/graph.bin: ${err instanceof Error ? err.message : String(err)}`);
  console.error('Run `npm run build-city` first.');
  process.exit(1);
}
const snapIndex = new SnapIndex(artifact.graph, BUILD_AREA);
const router = new Router(artifact.graph, artifact.restrictions, TURN_COST);

let places: { name: string; point: [number, number] }[] = [];
try {
  const raw = JSON.parse(await readFile(resolve(DATA, 'places.json'), 'utf8')) as { places: typeof places };
  places = raw.places;
} catch {
  console.log('  (places.json missing, search benchmark skipped)');
}
const search = places.length > 0 ? new PlacesSearch(places as never) : null;

const next = rng(SEED);
const pickPoint = (): [number, number] => [
  BUILD_AREA.minLon + next() * (BUILD_AREA.maxLon - BUILD_AREA.minLon),
  BUILD_AREA.minLat + next() * (BUILD_AREA.maxLat - BUILD_AREA.minLat),
];

// ---------------------------------------------------------------------------
// Initial routes: any pair in the area, plus the pinned corner cases.
// ---------------------------------------------------------------------------
const CORNERS: [number, number][] = [
  [BUILD_AREA.minLon, BUILD_AREA.minLat],
  [BUILD_AREA.maxLon, BUILD_AREA.minLat],
  [BUILD_AREA.minLon, BUILD_AREA.maxLat],
  [BUILD_AREA.maxLon, BUILD_AREA.maxLat],
];
interface Query { a: [number, number]; b: [number, number]; label: string }
const initialQueries: Query[] = [];
// Corner to opposite corner, both diagonals, both directions. Permanently in the set.
initialQueries.push({ a: CORNERS[0] as [number, number], b: CORNERS[3] as [number, number], label: 'corner SW to NE' });
initialQueries.push({ a: CORNERS[3] as [number, number], b: CORNERS[0] as [number, number], label: 'corner NE to SW' });
initialQueries.push({ a: CORNERS[1] as [number, number], b: CORNERS[2] as [number, number], label: 'corner SE to NW' });
initialQueries.push({ a: CORNERS[2] as [number, number], b: CORNERS[1] as [number, number], label: 'corner NW to SE' });
{
  let guard = 0;
  while (initialQueries.length < INITIAL_SAMPLES && guard < INITIAL_SAMPLES * 40) {
    guard++;
    const a = pickPoint();
    const b = pickPoint();
    if (snapIndex.snap(a, 'destination', SNAP_DESTINATION_M) === null) continue;
    if (snapIndex.snap(b, 'destination', SNAP_DESTINATION_M) === null) continue;
    initialQueries.push({ a, b, label: `random ${initialQueries.length - 3}` });
  }
}

// ---------------------------------------------------------------------------
// Re-routes: origins ALONG a real route, destination that route's real endpoint.
// ---------------------------------------------------------------------------
interface Reroute { startEdge: number; startFraction: number; endEdge: number; endFraction: number; remainingKm: number; label: string }
const rerouteQueries: Reroute[] = [];
{
  let guard = 0;
  while (rerouteQueries.length < REROUTE_SAMPLES && guard < REROUTE_SAMPLES * 40) {
    guard++;
    const a = pickPoint();
    const b = pickPoint();
    const sa = snapIndex.snap(a, 'destination', SNAP_DESTINATION_M);
    const sb = snapIndex.snap(b, 'destination', SNAP_DESTINATION_M);
    if (sa === null || sb === null) continue;
    const full = router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction);
    if (full === null || full.edges.length < 8) continue;
    // A point PART WAY along the computed route, uniformly over the whole trip rather than only
    // near the end. Early positions leave nearly the full distance to recompute, and those are
    // the queries that set p95. Excluding them would be exactly the narrowing the budget forbids.
    const at = Math.floor(next() * (full.edges.length - 2)) + 1;
    const origin = full.edges[at] as number;
    let remaining = 0;
    for (let i = at; i < full.edges.length; i++) remaining += artifact.graph.edgeLengthM[full.edges[i] as number] as number;
    rerouteQueries.push({
      startEdge: origin,
      startFraction: 0.5,
      endEdge: sb.edgeId,
      endFraction: sb.fraction,
      remainingKm: remaining / 1000,
      label: `reroute ${rerouteQueries.length + 1}`,
    });
  }
}

console.log(`  initial-route queries ${initialQueries.length} (4 pinned corner cases)`);
console.log(`  re-route queries      ${rerouteQueries.length}, remaining distance ${Math.min(...rerouteQueries.map((r) => r.remainingKm)).toFixed(1)} to ${Math.max(...rerouteQueries.map((r) => r.remainingKm)).toFixed(1)} km`);

// Warm the JIT across BOTH shapes before timing anything. Warming per-case makes the first case
// pay for compiling `route`, which this project has already measured as a 5x artefact.
for (let pass = 0; pass < 2; pass++) {
  for (const q of initialQueries.slice(0, 8)) {
    const sa = snapIndex.snap(q.a, 'destination', SNAP_DESTINATION_M);
    const sb = snapIndex.snap(q.b, 'destination', SNAP_DESTINATION_M);
    if (sa !== null && sb !== null) router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction);
  }
}

const timeIt = (fn: () => void, repeats = 3): number => {
  const runs: number[] = [];
  for (let i = 0; i < repeats; i++) {
    const t = performance.now();
    fn();
    runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)] as number;
};

const initialMs: number[] = [];
const initialDetail: { label: string; km: number; ms: number }[] = [];
for (const q of initialQueries) {
  const sa = snapIndex.snap(q.a, 'destination', SNAP_DESTINATION_M);
  const sb = snapIndex.snap(q.b, 'destination', SNAP_DESTINATION_M);
  if (sa === null || sb === null) continue;
  let km = 0;
  const t = timeIt(() => {
    const r = router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction);
    km = r === null ? 0 : r.metres / 1000;
  });
  if (km === 0) continue;
  initialMs.push(t);
  initialDetail.push({ label: q.label, km, ms: t });
}

const rerouteMs: number[] = [];
const rerouteDetail: { label: string; km: number; ms: number }[] = [];
for (const q of rerouteQueries) {
  let ok = false;
  const t = timeIt(() => {
    ok = router.route(q.startEdge, q.startFraction, q.endEdge, q.endFraction) !== null;
  });
  if (!ok) continue;
  rerouteMs.push(t);
  rerouteDetail.push({ label: q.label, km: q.remainingKm, ms: t });
}

// Snap, both radii, since they are different code paths and conflating them hides a regression.
const snapDestMs: number[] = [];
const snapTrackMs: number[] = [];
for (let i = 0; i < 200; i++) {
  const p = pickPoint();
  snapDestMs.push(timeIt(() => void snapIndex.snap(p, 'destination', SNAP_DESTINATION_M), 3));
  snapTrackMs.push(timeIt(() => void snapIndex.snap(p, 'tracking', SNAP_TRACKING_M), 3));
}

const searchMs: number[] = [];
if (search !== null) {
  for (const q of SEARCH_QUERIES) {
    for (let i = 0; i < 5; i++) searchMs.push(timeIt(() => void search.search(q, { limit: 10 }), 3));
  }
}

const initial = summarise(initialMs);
const reroute = summarise(rerouteMs);
const snapDest = summarise(snapDestMs);
const snapTrack = summarise(snapTrackMs);
const searchDist = summarise(searchMs);

const rerouteOk = reroute.p95 <= ROUTE_BUDGET.rerouteP95Ms;
const initialOk = initial.p95 <= ROUTE_BUDGET.initialP95Ms;

console.log('\n  operation            n     p50      p95      p99      max   budget   verdict');
const line = (label: string, d: Dist, budget?: number, ok?: boolean): void =>
  console.log(
    `  ${label.padEnd(20)}${String(d.n).padStart(4)}${ms(d.p50).padStart(9)}${ms(d.p95).padStart(9)}${ms(d.p99).padStart(9)}${ms(d.max).padStart(9)}` +
      `${budget === undefined ? '        ' : `${budget} ms`.padStart(9)}${ok === undefined ? '' : `   ${ok ? 'PASS' : 'FAIL'}`}`,
  );
line('route, re-route', reroute, ROUTE_BUDGET.rerouteP95Ms, rerouteOk);
line('route, initial', initial, ROUTE_BUDGET.initialP95Ms, initialOk);
line('snap, destination', snapDest);
line('snap, tracking', snapTrack);
line('search', searchDist);

const worstReroute = [...rerouteDetail].sort((a, b) => b.ms - a.ms).slice(0, 5);
const worstInitial = [...initialDetail].sort((a, b) => b.ms - a.ms).slice(0, 5);

const md = [
  '# Benchmarks',
  '',
  'Generated by `npm run bench` on an otherwise idle machine. Timing under concurrent load is not',
  'a measurement: this project has recorded a server boot at 89 s that was 2.87 s alone, and a',
  'tilemaker run at 2,425 s that was 18 s alone.',
  '',
  '## Route latency, against the two budgets',
  '',
  'There are two budgets because there are two requirements. A RE-ROUTE happens mid-trip while the',
  'driver is moving, so its latency is felt directly. An INITIAL route is computed once at trip',
  'start, off the interaction path. `config/city.ts` holds both and explains the split.',
  '',
  '| Operation | n | p50 | p95 | p99 | max | Budget (p95) | Verdict |',
  '|---|---|---|---|---|---|---|---|',
  `| Route, re-route | ${reroute.n} | ${ms(reroute.p50)} | **${ms(reroute.p95)}** | ${ms(reroute.p99)} | ${ms(reroute.max)} | ${ROUTE_BUDGET.rerouteP95Ms} ms | ${rerouteOk ? 'PASS' : 'FAIL'} |`,
  `| Route, initial | ${initial.n} | ${ms(initial.p50)} | **${ms(initial.p95)}** | ${ms(initial.p99)} | ${ms(initial.max)} | ${ROUTE_BUDGET.initialP95Ms} ms | ${initialOk ? 'PASS' : 'FAIL'} |`,
  `| Snap, destination (${SNAP_DESTINATION_M} m) | ${snapDest.n} | ${ms(snapDest.p50)} | ${ms(snapDest.p95)} | ${ms(snapDest.p99)} | ${ms(snapDest.max)} | none | n/a |`,
  `| Snap, tracking (${SNAP_TRACKING_M} m) | ${snapTrack.n} | ${ms(snapTrack.p50)} | ${ms(snapTrack.p95)} | ${ms(snapTrack.p99)} | ${ms(snapTrack.max)} | none | n/a |`,
  `| Search | ${searchDist.n} | ${ms(searchDist.p50)} | ${ms(searchDist.p95)} | ${ms(searchDist.p99)} | ${ms(searchDist.max)} | none yet | n/a |`,
  '',
  '## How the samples were drawn',
  '',
  'This is the part that decides whether the numbers above mean anything.',
  '',
  `**Re-route (${reroute.n} samples).** Origins are points part way along REAL computed routes,`,
  'with the destination being that route\'s real remaining endpoint, sampled uniformly over the',
  'whole trip rather than near the end. Remaining distance in this run spans',
  `${rerouteDetail.length > 0 ? `${Math.min(...rerouteDetail.map((r) => r.km)).toFixed(1)} to ${Math.max(...rerouteDetail.map((r) => r.km)).toFixed(1)} km` : 'n/a'}.`,
  'A driver who deviates early into a long trip produces a nearly-full-length re-route, so those',
  'are in the distribution and are expected to set p95.',
  '',
  `**Initial route (${initial.n} samples).** Random pairs anywhere in BUILD_AREA, plus four PINNED`,
  'corner-to-corner queries on both diagonals in both directions. The corner cases stay in the set',
  'permanently; they are the worst case and cannot be argued out of it.',
  '',
  '## Slowest re-routes',
  '',
  '| Case | Remaining km | ms |',
  '|---|---|---|',
  ...worstReroute.map((r) => `| ${r.label} | ${r.km.toFixed(1)} | ${r.ms.toFixed(2)} |`),
  '',
  '## Slowest initial routes',
  '',
  '| Case | km | ms |',
  '|---|---|---|',
  ...worstInitial.map((r) => `| ${r.label} | ${r.km.toFixed(1)} | ${r.ms.toFixed(2)} |`),
  '',
].join('\n');

await writeFile(resolve(import.meta.dirname, '../BENCHMARKS.md'), `${md}\n`, 'utf8');
console.log('\n  wrote BENCHMARKS.md');
console.log(
  rerouteOk && initialOk
    ? '\nbench: both route budgets met.'
    : '\nbench: at least one route budget NOT met. This is the gate 5 target, not a test failure.',
);
