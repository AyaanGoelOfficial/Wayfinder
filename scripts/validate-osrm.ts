/**
 * Gate 4: measure our routes against OSRM. `npm run validate`.
 *
 * OSRM is a REFERENCE, not an oracle. It has its own speed profile, its own turn penalties and a
 * different OSM snapshot, so exact agreement is neither expected nor desirable. What this
 * measures is whether we are in the same distribution: a route 3% longer is a different but
 * reasonable choice, a route 40% longer is a bug in legality, speeds, or the graph.
 *
 * DISTANCE IS ASSERTED, DURATION IS REPORTED. Only 1,773 of 121,084 drivable ways here carry a
 * parseable `maxspeed`, so 98.5% of our durations come from the class-default table. Gating on
 * duration would therefore be gating on that table rather than on the router, and it would go red
 * for a reason gate 6 exists to fix. Duration is printed in full so the gap is visible rather
 * than hidden.
 *
 * PAIR SELECTION IS DETERMINISTIC. The report is committed, so a reader must be able to
 * regenerate the same 50 pairs; a fresh `Math.random()` per run would make every diff noise. The
 * seed is a constant below.
 *
 * NETWORK EGRESS lives here on purpose: `scripts/` is the only place allowed it, and this is
 * throttled to roughly one request per second against a free public demo server that owes us
 * nothing.
 */
import { writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BUILD_AREA, SNAP_DESTINATION_M, TURN_COST } from '../config/city.ts';
import { ROUTING_FIXTURES } from '../config/fixtures/routing.ts';
import { SnapIndex } from '../packages/engine/snap.ts';
import { Router } from '../packages/engine/dijkstra.ts';
import { parseGraphArtifact } from '../packages/engine/graphfile.ts';

const DATA = resolve(import.meta.dirname, '../data');
const OSRM = 'https://router.project-osrm.org';
const RANDOM_PAIRS = 50;
const REQUEST_INTERVAL_MS = 1_100;
const SEED = 20260731;

/** Gate thresholds, on DISTANCE. Stated in the plan and not moved to fit a result. */
const MEDIAN_MAX = 0.03;
const P95_MAX = 0.07;

/**
 * Mulberry32. A seeded PRNG in six lines, so the 50 "random" pairs are the same 50 every run and
 * a change in the committed report means a change in the ROUTER, not a change in the dice.
 */
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

interface OsrmRoute {
  readonly distance: number;
  readonly duration: number;
}

async function osrmRoute(a: readonly [number, number], b: readonly [number, number]): Promise<OsrmRoute | null> {
  const url = `${OSRM}/route/v1/driving/${a[0]},${a[1]};${b[0]},${b[1]}?overview=false`;
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'wayfinder-gn validation (single developer, throttled)' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { code?: string; routes?: { distance: number; duration: number }[] };
    if (body.code !== 'Ok' || body.routes === undefined || body.routes.length === 0) return null;
    const r = body.routes[0] as { distance: number; duration: number };
    return { distance: r.distance, duration: r.duration };
  } catch {
    return null;
  }
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return sorted[lo] as number;
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (i - lo);
}

/** An OSM link showing the same pair routed by OSRM, so a divergence can be looked at, not argued about. */
function mapLink(a: readonly [number, number], b: readonly [number, number]): string {
  return `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${a[1].toFixed(5)}%2C${a[0].toFixed(5)}%3B${b[1].toFixed(5)}%2C${b[0].toFixed(5)}`;
}

// ---------------------------------------------------------------------------

console.log('=== gate 4: validation against OSRM ===');
let artifact;
try {
  artifact = parseGraphArtifact(await readFile(resolve(DATA, 'graph.bin')));
} catch (err) {
  console.error(`cannot read data/graph.bin: ${err instanceof Error ? err.message : String(err)}`);
  console.error('Run `npm run build-city` first.');
  process.exit(1);
}
const snap = new SnapIndex(artifact.graph, BUILD_AREA);
const router = new Router(artifact.graph, artifact.restrictions, TURN_COST);
console.log(`  graph  ${artifact.graph.edgeFrom.length.toLocaleString('en-US')} directed edges`);

// ---- Pair selection ----
interface Pair {
  readonly label: string;
  readonly kind: 'landmark' | 'random';
  readonly a: [number, number];
  readonly b: [number, number];
}
const pairs: Pair[] = [];

// Landmarks: every ordered fixture pair is overkill, so take each fixture to the next one round
// robin, which touches all of them and keeps the request count honest against a public server.
for (let i = 0; i < ROUTING_FIXTURES.length; i++) {
  const f = ROUTING_FIXTURES[i] as (typeof ROUTING_FIXTURES)[number];
  const g = ROUTING_FIXTURES[(i + 1) % ROUTING_FIXTURES.length] as (typeof ROUTING_FIXTURES)[number];
  pairs.push({ label: `${f.id} to ${g.id}`, kind: 'landmark', a: [f.lon, f.lat], b: [g.lon, g.lat] });
}

// Random: rejection-sampled inside BUILD_AREA and required to snap, so a pair in the middle of a
// field does not become a "failure" that is really an unsnappable point.
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
console.log(`  pairs  ${pairs.filter((p) => p.kind === 'landmark').length} landmark, ${pairs.filter((p) => p.kind === 'random').length} random`);
console.log(`  OSRM   ${OSRM}, throttled to one request per ${REQUEST_INTERVAL_MS} ms\n`);

interface Row {
  readonly label: string;
  readonly kind: string;
  readonly a: [number, number];
  readonly b: [number, number];
  readonly oursM: number;
  readonly osrmM: number;
  readonly oursS: number;
  readonly osrmS: number;
  readonly distDelta: number;
  readonly durDelta: number;
}
const rows: Row[] = [];
const skipped: string[] = [];

for (const p of pairs) {
  const sa = snap.snap(p.a, 'destination', SNAP_DESTINATION_M);
  const sb = snap.snap(p.b, 'destination', SNAP_DESTINATION_M);
  if (sa === null || sb === null) {
    skipped.push(`${p.label}: unsnappable within ${SNAP_DESTINATION_M} m`);
    continue;
  }
  const ours = router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction);
  if (ours === null) {
    skipped.push(`${p.label}: WE found no route`);
    continue;
  }
  const theirs = await osrmRoute(p.a, p.b);
  await sleep(REQUEST_INTERVAL_MS);
  if (theirs === null) {
    skipped.push(`${p.label}: OSRM returned no route or was unreachable`);
    continue;
  }
  const distDelta = (ours.metres - theirs.distance) / theirs.distance;
  // DRIVE TIME ONLY. `ours.seconds` is the modelled cost and includes our turn penalties, which
  // OSRM's duration does not contain and never will. Comparing the two directly would charge our
  // modelling choice to the reference and make the router look worse the more carefully it prices
  // turns. Subtracting `turnSeconds` compares the two quantities that actually mean the same thing.
  const oursDriveS = ours.seconds - ours.turnSeconds;
  const durDelta = (oursDriveS - theirs.duration) / theirs.duration;
  rows.push({
    label: p.label, kind: p.kind, a: p.a, b: p.b,
    oursM: ours.metres, osrmM: theirs.distance, oursS: oursDriveS, osrmS: theirs.duration,
    distDelta, durDelta,
  });
  console.log(
    `  ${p.label.padEnd(28)} ours ${(ours.metres / 1000).toFixed(2)} km  osrm ${(theirs.distance / 1000).toFixed(2)} km  ` +
      `dist ${(distDelta * 100).toFixed(1).padStart(6)}%  dur ${(durDelta * 100).toFixed(1).padStart(6)}%`,
  );
}

if (rows.length === 0) {
  console.error('\nNo pair produced a comparison. Nothing is validated; this is not a pass.');
  process.exit(1);
}

const absDist = rows.map((r) => Math.abs(r.distDelta)).sort((x, y) => x - y);
const absDur = rows.map((r) => Math.abs(r.durDelta)).sort((x, y) => x - y);
const medianDist = quantile(absDist, 0.5);
const p95Dist = quantile(absDist, 0.95);
const medianDur = quantile(absDur, 0.5);
const p95Dur = quantile(absDur, 0.95);

const worst = [...rows].sort((x, y) => Math.abs(y.distDelta) - Math.abs(x.distDelta)).slice(0, 10);

const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
console.log(`\n  compared        ${rows.length} pairs, ${skipped.length} skipped`);
console.log(`  DISTANCE median ${pct(medianDist)}  (threshold ${pct(MEDIAN_MAX)})`);
console.log(`  DISTANCE p95    ${pct(p95Dist)}  (threshold ${pct(P95_MAX)})`);
console.log(`  duration median ${pct(medianDur)}  (reported, not asserted)`);
console.log(`  duration p95    ${pct(p95Dur)}  (reported, not asserted)`);

const distOk = medianDist <= MEDIAN_MAX && p95Dist <= P95_MAX;

const md = [
  '# Validation against OSRM',
  '',
  'Generated by `npm run validate`. OSRM is a REFERENCE, not an oracle: it has its own speed',
  'profile, its own turn penalties and a different OSM snapshot, so exact agreement is neither',
  'expected nor wanted. What is being measured is whether we sit in the same distribution.',
  '',
  `Reference: \`${OSRM}\`, throttled to one request per ${REQUEST_INTERVAL_MS} ms.`,
  `Pair selection is deterministic (seed ${SEED}), so a change in this file means a change in the`,
  'router, not a change in the dice.',
  '',
  '## Result',
  '',
  '| Metric | Value | Threshold | Verdict |',
  '|---|---|---|---|',
  `| Distance, median absolute delta | ${pct(medianDist)} | ${pct(MEDIAN_MAX)} | ${medianDist <= MEDIAN_MAX ? 'PASS' : 'FAIL'} |`,
  `| Distance, p95 absolute delta | ${pct(p95Dist)} | ${pct(P95_MAX)} | ${p95Dist <= P95_MAX ? 'PASS' : 'FAIL'} |`,
  `| Duration, median absolute delta | ${pct(medianDur)} | reported only | n/a |`,
  `| Duration, p95 absolute delta | ${pct(p95Dur)} | reported only | n/a |`,
  '',
  `Compared ${rows.length} pairs (${rows.filter((r) => r.kind === 'landmark').length} landmark, ${rows.filter((r) => r.kind === 'random').length} random). Skipped ${skipped.length}.`,
  '',
  '**Duration is reported and not asserted, on purpose.** Only 1,773 of 121,084 drivable ways in',
  'this area carry a parseable `maxspeed`, so 98.5% of our durations come from the class-default',
  'table. Asserting on duration would assert on that table rather than on the router. Closing that',
  'gap is gate 6.',
  '',
  '**Duration here is DRIVE TIME, with our turn penalties subtracted.** Our modelled cost includes',
  "them and OSRM's duration does not, so leaving them in would compare a model against a",
  'measurement and make the router look worse the more carefully it prices turns.',
  '',
  '## How to read a divergence',
  '',
  'Sign matters, and the two directions have different candidate causes.',
  '',
  '**We are LONGER than OSRM.** Either we are missing a road OSRM has, or we are over-restricting',
  '(a turn ban applied too widely, an access tag read too strictly), or OSRM used a road OUTSIDE',
  '`BUILD_AREA` that our clipped graph does not contain at all.',
  '',
  '**We are SHORTER than OSRM.** More concerning: it suggests we permit something OSRM does not.',
  'An illegal turn, a road class OSRM excludes for cars, or a one-way taken the wrong way.',
  '',
  '**This file says WHICH pairs diverge. `DIVERGENCE.md` says WHY**, per pair, grouped by cause,',
  'from `npm run diagnose:route -- --all`. Read that one before drawing a conclusion from this one:',
  'ten worst cases sharing a single root cause is one bug, and a ranking by percentage hides it.',
  '',
  '**The near-edge caveat is now MEASURED, not hypothesised.** Random pairs are drawn uniformly',
  'from the BUILD_AREA bounding box, so some land within a few km of its edge. Our graph stops at',
  'that boundary plus a 3 km buffer while OSRM has all of India. Counting the OSM nodes on OSRM\'s',
  'route that our clip does not contain shows 16 of these 56 pairs are answered by leaving the',
  'area. Those pairs measure the clip boundary rather than the router. They are NOT excluded from',
  'the statistics here, and excluding them would not help anyway: median improves to 2.44% while',
  'p95 worsens to 28.27%. Landmark pairs sit well inside the area and carry no such excuse, which',
  'is why `gautam-buddha-university to jewar` is the pair that matters most below.',
  '',
  '## Ten worst divergences by distance',
  '',
  'Each link routes the same pair on openstreetmap.org with the OSRM car engine, so a divergence',
  'can be looked at rather than argued about.',
  '',
  '| Pair | Ours | OSRM | Distance delta | Duration delta | Map |',
  '|---|---|---|---|---|---|',
  ...worst.map(
    (r) =>
      `| ${r.label} | ${(r.oursM / 1000).toFixed(2)} km | ${(r.osrmM / 1000).toFixed(2)} km | ${pct(r.distDelta)} | ${pct(r.durDelta)} | [view](${mapLink(r.a, r.b)}) |`,
  ),
  '',
  '## Every comparison',
  '',
  '| Pair | Kind | Ours km | OSRM km | Dist delta | Ours min | OSRM min | Dur delta |',
  '|---|---|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.label} | ${r.kind} | ${(r.oursM / 1000).toFixed(2)} | ${(r.osrmM / 1000).toFixed(2)} | ${pct(r.distDelta)} | ${(r.oursS / 60).toFixed(1)} | ${(r.osrmS / 60).toFixed(1)} | ${pct(r.durDelta)} |`,
  ),
  '',
  ...(skipped.length > 0
    ? ['## Skipped, and why', '', 'Named rather than silently dropped: a shrinking comparison set is how a', 'validation quietly stops validating.', '', ...skipped.map((s) => `- ${s}`), '']
    : []),
].join('\n');

await writeFile(resolve(import.meta.dirname, '../VALIDATION.md'), `${md}\n`, 'utf8');
console.log('\n  wrote VALIDATION.md');

if (!distOk) {
  console.error('\nvalidation FAIL: distance divergence is outside the threshold.');
  process.exit(1);
}
console.log('\nvalidation PASS: distance median and p95 are inside the thresholds.');
