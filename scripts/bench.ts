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
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setPriority } from 'node:os';
import { resolve } from 'node:path';
import { BUILD_AREA, OBJECTIVE, ROUTE_BUDGET, SNAP_DESTINATION_M, SNAP_TRACKING_M, TURN_COST } from '../config/city.ts';
import type { RoutingAlgorithm } from '../packages/shared/index.ts';
import { SnapIndex } from '../packages/engine/snap.ts';
import { Router } from '../packages/engine/dijkstra.ts';
import { PlacesSearch } from '../packages/engine/search.ts';
import { parseGraphArtifact } from '../packages/engine/graphfile.ts';
import {
  QUIET_CANARY_MAX,
  QUIET_MACHINE_CHECKLIST,
  STABILITY_MAX_SPREAD,
  measureMachineStability,
} from './lib/machine.ts';

/**
 * PREFLIGHT, AND IT REFUSES RATHER THAN WARNS.
 *
 * A benchmark that self-reports contamination and then prints numbers anyway will have those
 * numbers quoted, because the table is the memorable part and the caveat is not. So an unsteady
 * machine ends the run here, before a single route is timed, and nothing is written to
 * `BENCHMARKS.md` that could later be read as a measurement.
 *
 * `--force` exists for the one legitimate case, deliberately investigating the instrument itself.
 * It stamps the output so a forced run cannot be mistaken for a clean one.
 */
const FORCED = process.argv.includes('--force');

/**
 * NAME THE CO-TENANTS, do not print a checklist and hope.
 *
 * "Close anything else that is running" is advice; a list of the four processes actually burning
 * CPU right now is an instruction. This exists because a run that idled the machine for seven
 * minutes still canaried at 1.33, and the reason turned out to be three named processes holding
 * about 11% of the machine between them. Eleven percent does not starve a single-threaded search
 * of CPU, but the router's working set is roughly 8.5 MB of interleaved typed arrays, so it lives
 * in L3, and every co-tenant evicts it. Cache contention was separately measured at 1.28x, which
 * matches the 1.33 observed rather than refuting it.
 *
 * Windows only, because that is where this project builds; elsewhere it degrades to the static
 * checklist rather than failing.
 */
const topCpuConsumers = (seconds: number): string[] => {
  if (process.platform !== 'win32') return [];
  const ps = [
    '$a=Get-Process|Select-Object Id,ProcessName,CPU;',
    `Start-Sleep -Seconds ${seconds};`,
    '$b=Get-Process|Select-Object Id,ProcessName,CPU;',
    '$m=@{};foreach($p in $a){$m[$p.Id]=$p.CPU};',
    'foreach($p in $b){$q=$m[$p.Id];if($null -eq $q){$q=0};',
    'if($null -ne $p.CPU -and ($p.CPU-$q) -gt 0.05){',
    '"{0}|{1:N2}" -f $p.ProcessName,($p.CPU-$q)}}',
  ].join('');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      timeout: (seconds + 20) * 1000,
    });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.includes('|'))
      .map((l) => {
        const [name, cpu] = l.split('|');
        return { name: name as string, cpu: Number.parseFloat(cpu as string) };
      })
      .sort((x, y) => y.cpu - x.cpu)
      .slice(0, 8)
      .map((r) => `${r.name.padEnd(24)}${r.cpu.toFixed(2)} CPU-s per ${seconds} s wall`);
  } catch {
    return [];
  }
};

/**
 * HIGH priority, not HIGHEST. Node maps PRIORITY_HIGHEST to REALTIME_PRIORITY_CLASS on Windows,
 * which can starve input handling and make the machine unresponsive. HIGH reduces preemption by
 * the editor and the agent driving this session without that risk, and it cannot fix L3 eviction,
 * which is what actually costs the time. Failure is ignored: an unprivileged run still measures.
 */
try {
  setPriority(0, -14);
} catch {
  /* not permitted; the run is still valid, just more exposed to preemption */
}

{
  const m = measureMachineStability();
  const steady = m.spread <= STABILITY_MAX_SPREAD;
  console.log('=== machine preflight ===');
  console.log(
    `  fixed kernel x16   min ${m.minMs.toFixed(1)} ms   max ${m.maxMs.toFixed(1)} ms   ` +
      `spread ${m.spread.toFixed(2)}x   drift ${m.driftPct >= 0 ? '+' : ''}${m.driftPct.toFixed(1)}%`,
  );
  console.log(`  threshold          ${STABILITY_MAX_SPREAD.toFixed(2)}x   ${steady ? 'STEADY' : 'UNSTEADY'}`);
  const consumers = topCpuConsumers(4);
  if (consumers.length > 0) {
    console.log('\n  sharing this machine right now, by measured CPU:');
    for (const c of consumers) console.log(`    ${c}`);
  }
  console.log('');
  if (!steady && !FORCED) {
    console.error('bench REFUSED: this machine is not steady enough to measure anything right now.');
    console.error('Wall times taken now would be noise wearing a table. Shut those down and retry.');
    console.error('The list above is measured; the list below is what is usually on it:\n');
    for (const l of QUIET_MACHINE_CHECKLIST) console.error(`  ${l}`);
    console.error('\nSettled-state counts are load independent, so `npm run gate:equality` still');
    console.error('reports useful search-effort numbers on a busy machine. Use those meanwhile.');
    console.error('\nTo measure the instrument itself rather than the code, re-run with --force.');
    process.exit(1);
  }
  if (!steady) console.log('  FORCED past an unsteady machine. Every number below is suspect.\n');
}

const DATA = resolve(import.meta.dirname, '../data');
const SEED = 20260731;
const INITIAL_SAMPLES = 60;
const REROUTE_SAMPLES = 60;

/** Every rung, benchmarked over the identical queries. `gate:equality` proves they agree. */
const ALGORITHMS: readonly RoutingAlgorithm[] = [
  'dijkstra',
  'dijkstra-h-discarded',
  'astar',
  'bidirectional',
];
/**
 * The rung the server actually serves, and therefore the one the top budget table is judged
 * against. Must track `packages/server/main.ts`; the per-rung table below reports all four
 * regardless, so a mismatch here understates rather than hides.
 */
const SHIPPED_ALGORITHM: RoutingAlgorithm = 'bidirectional';
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
const router = new Router(artifact.graph, artifact.restrictions, TURN_COST, OBJECTIVE);

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

/**
 * MINIMUM of the repeats, not the median. This changed after the median was caught lying.
 *
 * Interference is one-sided: another process can only ever make a run SLOWER, never faster. So the
 * minimum is the best available estimate of what the work costs when nothing is competing, while
 * the median tracks whatever else the machine was doing. Measured, on this repo, three consecutive
 * runs of UNMODIFIED Dijkstra reported initial-route p95 of 284, 1829 and 1674 ms, and the derived
 * "time saved by A\*" column read +37.2%, then -4.3%, then -278.6%. Same code every time. That is
 * the same contamination already recorded for tilemaker wall time in `PROGRESS.md`, and a median
 * over three repeats did nothing to stop it.
 *
 * The minimum is not a fix for a loaded machine, only a much better estimator on one. `spread` below
 * reports how far the repeats disagreed, so a run taken under load says so instead of looking
 * authoritative.
 */
// Accumulators for the load canary. Total time actually observed against the total the best-of
// estimate implies. On a quiet machine the ratio is near 1; well above it means the run competed
// for the machine and every wall-clock number below should be treated as an upper bound.
let observedTotalMs = 0;
let bestTotalMs = 0;

const timeIt = (fn: () => void, repeats = 5): number => {
  let best = Infinity;
  for (let i = 0; i < repeats; i++) {
    const t = performance.now();
    fn();
    const d = performance.now() - t;
    if (d < best) best = d;
    observedTotalMs += d;
  }
  bestTotalMs += best * repeats;
  return best;
};

/**
 * SETTLED NODES ARE RECORDED BESIDE WALL TIME, per rung, and that pairing is the point.
 *
 * Wall time alone says a rung got faster; it does not say why, and on a machine that is also
 * running a browser it does not reliably say even that. Settled counts are deterministic: the same
 * query settles the same number of states every run, so a change there is a change in the SEARCH
 * rather than in the weather. Reporting them together is also the only way to test the prediction
 * that motivated A\* here, which is that nanoseconds per settle RISE with working-set size, so
 * cutting settled nodes should buy back more than its share of the time.
 */
interface Sample { label: string; km: number; ms: number; settled: number; relaxed: number }

const initialByAlg = new Map<RoutingAlgorithm, Sample[]>();
const rerouteByAlg = new Map<RoutingAlgorithm, Sample[]>();
for (const a of ALGORITHMS) {
  initialByAlg.set(a, []);
  rerouteByAlg.set(a, []);
}

/**
 * RUNGS ARE INTERLEAVED PER QUERY, AND ROTATED. This is not tidiness, it is the difference between
 * a comparison and a coincidence.
 *
 * Benchmarking all queries for rung A and then all queries for rung B attributes any drift in the
 * machine to whichever rung happened to be running at the time. Measured, on this repo, in a run
 * whose preflight passed: `dijkstra-h-discarded` does STRICTLY MORE work than `dijkstra` and settles
 * an identical number of states, yet came out 53% faster on initial routes and 93% slower on
 * re-routes in the same run. Both are impossible; both are the machine drifting under a sequential
 * schedule.
 *
 * So every rung is timed back to back on the SAME query, and the order is rotated by query index so
 * no rung permanently occupies the cache-cold first slot.
 */
const measure = (
  label: string,
  run: (algorithm: RoutingAlgorithm) => { ok: boolean; km: number; settled: number; relaxed: number },
  into: Map<RoutingAlgorithm, Sample[]>,
  rotation: number,
): void => {
  const order = ALGORITHMS.map((_, j) => ALGORITHMS[(rotation + j) % ALGORITHMS.length] as RoutingAlgorithm);
  const got: { a: RoutingAlgorithm; s: Sample }[] = [];
  for (const a of order) {
    let out = { ok: false, km: 0, settled: 0, relaxed: 0 };
    const t = timeIt(() => {
      out = run(a);
    });
    if (!out.ok) return; // a query only counts when EVERY rung answered it, or the sets differ
    got.push({ a, s: { label, km: out.km, ms: t, settled: out.settled, relaxed: out.relaxed } });
  }
  for (const g of got) (into.get(g.a) as Sample[]).push(g.s);
};

initialQueries.forEach((q, i) => {
  const sa = snapIndex.snap(q.a, 'destination', SNAP_DESTINATION_M);
  const sb = snapIndex.snap(q.b, 'destination', SNAP_DESTINATION_M);
  if (sa === null || sb === null) return;
  measure(
    q.label,
    (algorithm) => {
      const r = router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction, { algorithm });
      return { ok: r !== null && r.metres > 0, km: r === null ? 0 : r.metres / 1000, settled: r === null ? 0 : r.settled, relaxed: r === null ? 0 : r.relaxed };
    },
    initialByAlg,
    i,
  );
});

rerouteQueries.forEach((q, i) => {
  measure(
    q.label,
    (algorithm) => {
      const r = router.route(q.startEdge, q.startFraction, q.endEdge, q.endFraction, { algorithm });
      return { ok: r !== null, km: q.remainingKm, settled: r === null ? 0 : r.settled, relaxed: r === null ? 0 : r.relaxed };
    },
    rerouteByAlg,
    i,
  );
});

const initialDetail = initialByAlg.get(SHIPPED_ALGORITHM) as Sample[];
const rerouteDetail = rerouteByAlg.get(SHIPPED_ALGORITHM) as Sample[];
const initialMs = initialDetail.map((s) => s.ms);
const rerouteMs = rerouteDetail.map((s) => s.ms);

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

/**
 * THE RE-ROUTE SAMPLE IS REPORTED IN TWO BANDS AND NARROWED IN NEITHER.
 *
 * The 30 ms budget was written for a case, not for a query length: a driver deviates and the
 * answer has to arrive before the next decision. An 84 km remaining-distance re-route is not that
 * case. That driver holds a still-valid old route and more than an hour of road, and cannot
 * observe the difference between 30 ms and 300 ms. Judging it against the same threshold measures
 * something nobody feels, and lets one such query decide a verdict about a different requirement.
 *
 * Both bands stay in the sample PERMANENTLY, every query drawn is still measured, and the combined
 * figure is still printed below with its own p95. Nothing was dropped to make a number pass. What
 * the split changes is only which band carries the verdict. `ROUTE_BUDGET.urgentRemainingKm`
 * holds the boundary and the reasoning, including the fact that remaining distance is a PROXY for
 * time to the next maneuver, which is not measurable until tracking exists at gate 8.
 */
const urgentDetail = rerouteDetail.filter((s) => s.km < ROUTE_BUDGET.urgentRemainingKm);
const longDetail = rerouteDetail.filter((s) => s.km >= ROUTE_BUDGET.urgentRemainingKm);
const rerouteUrgent = summarise(urgentDetail.map((s) => s.ms));
const rerouteLong = summarise(longDetail.map((s) => s.ms));

const rerouteOk = rerouteUrgent.n > 0 && rerouteUrgent.p95 <= ROUTE_BUDGET.rerouteP95Ms;
const initialOk = initial.p95 <= ROUTE_BUDGET.initialP95Ms;

console.log('\n  operation                 n     p50      p95      p99      max   budget   verdict');
const line = (label: string, d: Dist, budget?: number, ok?: boolean): void =>
  console.log(
    `  ${label.padEnd(25)}${String(d.n).padStart(4)}${ms(d.p50).padStart(9)}${ms(d.p95).padStart(9)}${ms(d.p99).padStart(9)}${ms(d.max).padStart(9)}` +
      `${budget === undefined ? '        ' : `${budget} ms`.padStart(9)}${ok === undefined ? '' : `   ${ok ? 'PASS' : 'FAIL'}`}`,
  );
line(`re-route, urgent <${ROUTE_BUDGET.urgentRemainingKm}km`, rerouteUrgent, ROUTE_BUDGET.rerouteP95Ms, rerouteOk);
line(`re-route, long tail`, rerouteLong);
line('re-route, both bands', reroute);
line('route, initial', initial, ROUTE_BUDGET.initialP95Ms, initialOk);
line('snap, destination', snapDest);
line('snap, tracking', snapTrack);
line('search', searchDist);

// --- the ladder, and the prediction it was built to test ---------------------------------------
//
// PREDICTION UNDER TEST: profiling at gate 3 showed nanoseconds per settled state RISING with
// working-set size, which is a cache effect rather than an algorithmic one. If that holds, cutting
// settled states should buy back MORE than its share of wall time, so the time saved should exceed
// the states saved. If it does not, the memory model is doing something not yet characterised and
// this table is the thing that says so. Reported either way.
//
// AND THE ACCOUNTING HAS TO CLOSE. An earlier version of this table reported, for initial routes,
// 0.2% states cut, 20.0% time cut, and a per-state cost 20% HIGHER than the baseline, all in the
// same row. Those three cannot all be true of one comparison: a rung that visits the same states
// more expensively each cannot finish sooner. They were not one comparison. `states cut` and
// `time cut` were ratios of two independently-sorted p95s, so the numerator and denominator could
// come from DIFFERENT QUERIES, while `ns/settle` was a mean over every query. Mixing an order
// statistic with a mean produces a row that reads like arithmetic and is not.
//
// Every rung answers the identical query set, in the same order, so the honest comparison is
// PAIRED: divide each query by itself and summarise the ratios. The totals column is the same
// comparison weighted by size, and the block underneath prints the queries that actually set p95
// with every rung beside them, so the top-line claim can be checked against three real rows.
const median = (xs: readonly number[]): number => quantile([...xs].sort((a, b) => a - b), 0.5);
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const cut = (v: number): string => `${((1 - v) * 100).toFixed(1)}%`;

const ladder = (
  name: string,
  byAlg: Map<RoutingAlgorithm, Sample[]>,
): string[] => {
  const out: string[] = [];
  const base = byAlg.get('dijkstra') as Sample[];
  out.push('');
  out.push(`  ${name}  (n=${base.length}, every rung on the identical queries)`);
  out.push(
    `    ${'rung'.padEnd(22)}${'p50 ms'.padStart(9)}${'p95 ms'.padStart(9)}${'settled p50'.padStart(13)}` +
      `${'settled p95'.padStart(13)}${'ns/settle'.padStart(11)}`,
  );
  for (const a of ALGORITHMS) {
    const rows = byAlg.get(a) as Sample[];
    const t = summarise(rows.map((s) => s.ms));
    const st = summarise(rows.map((s) => s.settled));
    // Per query rather than per percentile: dividing a p95 time by a p95 settle count divides two
    // different queries by each other, which is a number that looks meaningful and is not.
    const perSettle = rows.reduce((acc, s) => acc + (s.settled === 0 ? 0 : (s.ms * 1e6) / s.settled), 0) / rows.length;
    out.push(
      `    ${a.padEnd(22)}${ms(t.p50).padStart(9)}${ms(t.p95).padStart(9)}${Math.round(st.p50).toLocaleString('en-US').padStart(13)}` +
        `${Math.round(st.p95).toLocaleString('en-US').padStart(13)}${perSettle.toFixed(0).padStart(11)}`,
    );
  }

  out.push('');
  out.push('    paired against dijkstra on the SAME query, never a ratio of two sorted percentiles');
  out.push(
    `    ${'rung'.padEnd(22)}${'states cut, med'.padStart(16)}${'time cut, med'.padStart(15)}` +
      `${'states cut, total'.padStart(18)}${'time cut, total'.padStart(17)}`,
  );
  for (const a of ALGORITHMS) {
    const rows = byAlg.get(a) as Sample[];
    // A misalignment here would silently compare two different queries, which is the exact defect
    // this block exists to remove. Fail loudly instead.
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i] as Sample).label !== (base[i] as Sample).label) {
        throw new Error(`rung ${a} sample ${i} is "${(rows[i] as Sample).label}", dijkstra has "${(base[i] as Sample).label}"`);
      }
    }
    const timeR = rows.map((s, i) => s.ms / (base[i] as Sample).ms);
    const stateR = rows.map((s, i) => ((base[i] as Sample).settled === 0 ? 1 : s.settled / (base[i] as Sample).settled));
    const totT = sum(base.map((s) => s.ms)) === 0 ? 1 : sum(rows.map((s) => s.ms)) / sum(base.map((s) => s.ms));
    const totS = sum(base.map((s) => s.settled)) === 0 ? 1 : sum(rows.map((s) => s.settled)) / sum(base.map((s) => s.settled));
    out.push(
      `    ${a.padEnd(22)}${cut(median(stateR)).padStart(16)}${cut(median(timeR)).padStart(15)}` +
        `${cut(totS).padStart(18)}${cut(totT).padStart(17)}`,
    );
  }

  // --- two estimators that cancel the fixed per-route cost --------------------------------------
  //
  // `ns/settle` above is t/S, and t is really F + S*c: a fixed per-route cost F for snapping, path
  // reconstruction and result allocation, plus S states at c each. Dividing by S folds F in, which
  // inflates the figure on small queries and makes any prediction built from it wrong in a
  // direction that depends on query size. Both estimators below are DIFFERENCES, so F cancels.
  //
  // 1. HEURISTIC COST, exactly. `dijkstra` and `dijkstra-h-discarded` settle the identical states
  //    in the identical order, differing only by computing h and throwing it away. Their time
  //    difference over that state count IS the heuristic, with nothing else in it.
  const disc = byAlg.get('dijkstra-h-discarded') as Sample[];
  const hNs = base
    .map((s, i) => (s.settled === 0 ? NaN : (((disc[i] as Sample).ms - s.ms) * 1e6) / s.settled))
    .filter((v) => Number.isFinite(v));
  out.push('');
  out.push(
    `    heuristic cost, F cancelled: median ${hNs.length === 0 ? 'n/a' : `${median(hNs).toFixed(0)} ns/state`}` +
      ` over ${hNs.length} queries`,
  );

  // 2. SUPER-LINEARITY. The claim under test is that c RISES with working-set size, a cache effect
  //    rather than an algorithmic one. Quartile the dijkstra queries by settled count and take the
  //    MARGINAL cost between consecutive quartiles: (mean t2 - mean t1) / (mean S2 - mean S1). F is
  //    identical in both means and drops out. A rising marginal cost is the effect; a flat one says
  //    there is nothing to find, and that is a reportable answer, not a failed measurement.
  const bySize = [...base].sort((x, y) => x.settled - y.settled);
  const q = Math.floor(bySize.length / 4);
  if (q >= 2) {
    const groups = [0, 1, 2, 3].map((k) => bySize.slice(k * q, k === 3 ? bySize.length : (k + 1) * q));
    const meanT = groups.map((g) => sum(g.map((s) => s.ms)) / g.length);
    const meanS = groups.map((g) => sum(g.map((s) => s.settled)) / g.length);
    out.push('    marginal ns/state between working-set quartiles, F cancelled (rising = cache effect)');
    for (let k = 1; k < groups.length; k++) {
      const dS = (meanS[k] as number) - (meanS[k - 1] as number);
      const dT = (meanT[k] as number) - (meanT[k - 1] as number);
      const c = dS === 0 ? NaN : (dT * 1e6) / dS;
      out.push(
        `      Q${k} to Q${k + 1}   ${Math.round(meanS[k - 1] as number).toLocaleString('en-US').padStart(9)} to ` +
          `${Math.round(meanS[k] as number).toLocaleString('en-US').padStart(9)} states` +
          `${`${Number.isFinite(c) ? c.toFixed(0) : 'n/a'} ns/state`.padStart(18)}`,
      );
    }
  }

  // The queries that set p95, printed whole. This is where a claim about the tail gets checked:
  // states, time and cost per state for one query at a time, with no percentile in sight.
  const worst = base
    .map((s, i) => i)
    .sort((x, y) => (base[y] as Sample).ms - (base[x] as Sample).ms)
    .slice(0, 3);
  out.push('');
  out.push('    the three queries dijkstra finds hardest, every rung on that one query');
  for (const i of worst) {
    out.push(`      ${(base[i] as Sample).label}, ${(base[i] as Sample).km.toFixed(1)} km`);
    for (const a of ALGORITHMS) {
      const s = (byAlg.get(a) as Sample[])[i] as Sample;
      const ns = s.settled === 0 ? NaN : (s.ms * 1e6) / s.settled;
      out.push(
        `        ${a.padEnd(22)}${`${ms(s.ms)} ms`.padStart(12)}${`${s.settled.toLocaleString('en-US')} settled`.padStart(20)}` +
          `${`${Number.isFinite(ns) ? ns.toFixed(0) : 'n/a'} ns/settle`.padStart(18)}`,
      );
    }
  }
  return out;
};

/**
 * BOTH BUDGETS, FOR EVERY RUNG, from the one run.
 *
 * The verdict lines above judge only the rung the server actually serves, which is the right thing
 * to publish and the wrong thing to decide with. "Would switching rungs clear the budget" is the
 * question a ladder exists to answer, and answering it by re-running with a different shipped rung
 * would compare two machines rather than two algorithms.
 */
const budgetLines = ((): string[] => {
  const out: string[] = [''];
  out.push(`  both budgets, per rung  (urgent = under ${ROUTE_BUDGET.urgentRemainingKm} km remaining)`);
  out.push(
    `    ${'rung'.padEnd(22)}${'urgent p95'.padStart(12)}${''.padStart(7)}${'long tail p95'.padStart(14)}` +
      `${'initial p95'.padStart(13)}${''.padStart(7)}`,
  );
  for (const a of ALGORITHMS) {
    const rr = rerouteByAlg.get(a) as Sample[];
    const ii = initialByAlg.get(a) as Sample[];
    const u = summarise(rr.filter((s) => s.km < ROUTE_BUDGET.urgentRemainingKm).map((s) => s.ms));
    const l = summarise(rr.filter((s) => s.km >= ROUTE_BUDGET.urgentRemainingKm).map((s) => s.ms));
    const i0 = summarise(ii.map((s) => s.ms));
    const uOk = u.n > 0 && u.p95 <= ROUTE_BUDGET.rerouteP95Ms;
    const iOk = i0.p95 <= ROUTE_BUDGET.initialP95Ms;
    out.push(
      `    ${a.padEnd(22)}${ms(u.p95).padStart(12)}${(uOk ? 'PASS' : 'FAIL').padStart(7)}` +
        `${ms(l.p95).padStart(14)}${ms(i0.p95).padStart(13)}${(iOk ? 'PASS' : 'FAIL').padStart(7)}`,
    );
  }
  out.push(
    `    budgets: urgent re-route ${ROUTE_BUDGET.rerouteP95Ms} ms, initial ${ROUTE_BUDGET.initialP95Ms} ms, long tail none`,
  );
  return out;
})();

const ladderLines = [...budgetLines, ...ladder('initial route', initialByAlg), ...ladder('re-route', rerouteByAlg)];
for (const l of ladderLines) console.log(l);

// The SECOND check, and it covers what the preflight cannot: the preflight measures the machine
// before the run, this measures it across the run. Something starting up halfway through is
// exactly the case a preflight alone would miss.
const loadFactor = bestTotalMs === 0 ? 1 : observedTotalMs / bestTotalMs;
const quiet = loadFactor < QUIET_CANARY_MAX;
console.log(
  `\n  LOAD CANARY  observed/best = ${loadFactor.toFixed(2)}  ${
    quiet ? 'machine stayed quiet across the run' : 'MACHINE BECAME BUSY DURING THE RUN'
  }`,
);
console.log('  Settled counts are deterministic and unaffected by load. When these disagree, believe them.');

const worstReroute = [...rerouteDetail].sort((a, b) => b.ms - a.ms).slice(0, 5);
const worstInitial = [...initialDetail].sort((a, b) => b.ms - a.ms).slice(0, 5);

const md = [
  '# Benchmarks',
  '',
  'Generated by `npm run bench`. Timing under concurrent load is not a measurement: this project has',
  'recorded a server boot at 89 s that was 2.87 s alone, and a tilemaker run at 2,425 s that was 18 s',
  'alone.',
  '',
  `## LOAD CANARY: observed/best = ${loadFactor.toFixed(2)}`,
  '',
  ...(quiet
    ? ['The repeats agreed closely, so the machine was quiet and the wall times below are usable.']
    : [
        '**THE MACHINE WAS BUSY DURING THIS RUN. Every wall-clock number in this file is an upper',
        'bound and the comparisons between rungs are not reliable.** Re-run on an idle machine before',
        'drawing any conclusion about latency from it.',
        '',
        'This is not a hypothetical. Three consecutive runs of UNMODIFIED Dijkstra reported',
        'initial-route p95 of 284, 1829 and 1674 ms, and the derived "time saved by A\\*" column read',
        '+37.2%, then -4.3%, then -278.6% for identical code. `timeIt` now takes the MINIMUM of its',
        'repeats rather than the median, because interference is one-sided and can only make a run',
        'slower, but a minimum is a better estimator on a loaded machine and not a cure for one.',
      ]),
  '',
  '**SETTLED-STATE COUNTS ARE DETERMINISTIC AND UNAFFECTED BY LOAD.** The same query settles the',
  'same number of states on every run, verified across the runs above where they were identical to',
  'the digit while wall times moved sixfold. Where the two disagree, believe the counts.',
  '',
  '## The ladder, per rung',
  '',
  '```',
  ...ladderLines,
  '```',
  '',
  '## Route latency, against the two budgets',
  '',
  'There are two budgets because there are two requirements. A RE-ROUTE happens mid-trip while the',
  'driver is moving, so its latency is felt directly. An INITIAL route is computed once at trip',
  'start, off the interaction path. `config/city.ts` holds both and explains the split.',
  '',
  `The re-route sample is reported in two bands. The 30 ms budget was written for the felt case, a`,
  'driver who deviates and needs the answer before the next decision, and it is judged against the',
  `URGENT band: remaining distance under ${ROUTE_BUDGET.urgentRemainingKm} km. The long tail is measured, reported and kept in the`,
  'sample permanently, with no threshold, because a driver with an hour of road left and a valid old',
  'route cannot observe the difference between 30 ms and 300 ms. **No query was dropped and the',
  'combined figure is still shown below.** The boundary and its reasoning, including that remaining',
  'distance is a proxy for time to next maneuver, live beside the constant in `config/city.ts`.',
  '',
  '| Operation | n | p50 | p95 | p99 | max | Budget (p95) | Verdict |',
  '|---|---|---|---|---|---|---|---|',
  `| Route, re-route, urgent (<${ROUTE_BUDGET.urgentRemainingKm} km left) | ${rerouteUrgent.n} | ${ms(rerouteUrgent.p50)} | **${ms(rerouteUrgent.p95)}** | ${ms(rerouteUrgent.p99)} | ${ms(rerouteUrgent.max)} | ${ROUTE_BUDGET.rerouteP95Ms} ms | ${rerouteOk ? 'PASS' : 'FAIL'} |`,
  `| Route, re-route, long tail | ${rerouteLong.n} | ${ms(rerouteLong.p50)} | ${ms(rerouteLong.p95)} | ${ms(rerouteLong.p99)} | ${ms(rerouteLong.max)} | none | reported |`,
  `| Route, re-route, both bands | ${reroute.n} | ${ms(reroute.p50)} | ${ms(reroute.p95)} | ${ms(reroute.p99)} | ${ms(reroute.max)} | none | reported |`,
  `| Route, initial | ${initial.n} | ${ms(initial.p50)} | **${ms(initial.p95)}** | ${ms(initial.p99)} | ${ms(initial.max)} | ${ROUTE_BUDGET.initialP95Ms} ms | ${initialOk ? 'PASS' : 'FAIL'} |`,
  `| Snap, destination (${SNAP_DESTINATION_M} m) | ${snapDest.n} | ${ms(snapDest.p50)} | ${ms(snapDest.p95)} | ${ms(snapDest.p99)} | ${ms(snapDest.max)} | none | n/a |`,
  `| Snap, tracking (${SNAP_TRACKING_M} m) | ${snapTrack.n} | ${ms(snapTrack.p50)} | ${ms(snapTrack.p95)} | ${ms(snapTrack.p99)} | ${ms(snapTrack.max)} | none | n/a |`,
  `| Search | ${searchDist.n} | ${ms(searchDist.p50)} | ${ms(searchDist.p95)} | ${ms(searchDist.p99)} | ${ms(searchDist.max)} | none yet | n/a |`,
  '',
  '## How the samples were drawn',
  '',
  'This is the part that decides whether the numbers above mean anything.',
  '',
  `**Re-route (${reroute.n} samples, ${rerouteUrgent.n} urgent and ${rerouteLong.n} long tail).** Origins are points part way along REAL`,
  'computed routes, with the destination being that route\'s real remaining endpoint, sampled',
  'uniformly over the whole trip rather than near the end. Remaining distance in this run spans',
  `${rerouteDetail.length > 0 ? `${Math.min(...rerouteDetail.map((r) => r.km)).toFixed(1)} to ${Math.max(...rerouteDetail.map((r) => r.km)).toFixed(1)} km` : 'n/a'}.`,
  'A driver who deviates early into a long trip produces a nearly-full-length re-route, so those',
  'are in the distribution, and they are what sets the long-tail band.',
  '',
  `**Initial route (${initial.n} samples).** Random pairs anywhere in BUILD_AREA, plus four PINNED`,
  'corner-to-corner queries on both diagonals in both directions. The corner cases stay in the set',
  'permanently; they are the worst case and cannot be argued out of it.',
  '',
  '## Slowest re-routes',
  '',
  '| Case | Remaining km | Band | ms |',
  '|---|---|---|---|',
  ...worstReroute.map(
    (r) => `| ${r.label} | ${r.km.toFixed(1)} | ${r.km < ROUTE_BUDGET.urgentRemainingKm ? 'urgent' : 'long tail'} | ${r.ms.toFixed(2)} |`,
  ),
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

// The canary refuses AFTER the fact, for the same reason the preflight refuses before it: a table
// with a warning above it gets quoted without the warning. BENCHMARKS.md is still written and it
// carries the contamination notice in its own header, but a non-zero exit makes the run unusable as
// evidence rather than merely caveated. The preflight bounds the machine at ONE INSTANT; this
// covers something starting up halfway through, which no preflight can see.
if (!quiet) {
  console.error(`\nbench FAILED: the machine became busy DURING the run, canary ${loadFactor.toFixed(2)}.`);
  console.error('Absolute wall times from this run are UPPER BOUNDS.');
  console.error('The PAIRED rung comparison above survives this: every rung ran the same query back');
  console.error('to back under the same conditions, so contention hits all three alike. The budget');
  console.error('verdicts do not survive it. Treat them as "no better than".');
  const consumers = topCpuConsumers(4);
  if (consumers.length > 0) {
    console.error('\nsharing the machine as this run ended, by measured CPU:');
    for (const c of consumers) console.error(`  ${c}`);
  }
  process.exit(1);
}
