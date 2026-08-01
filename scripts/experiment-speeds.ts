/**
 * Is the speed table actually the cause of the gate 4 divergence? `npm run experiment:speeds`.
 *
 * `diagnose-divergence.ts` sorted all 56 pairs into causes and found ZERO router bugs and ZERO
 * wrongly-excluded roads: every remaining divergence is either OSRM leaving `BUILD_AREA` or a
 * disagreement about how fast a road class goes. That narrows the suspect to one table. It does
 * not prove the table is guilty, and `calibrate-speeds.ts` shows the obvious accusation is false:
 * against posted limits our motorway default is the MOST discounted class, not the least, so
 * "we over-rate motorway" cannot be the story.
 *
 * So test it instead of arguing about it. Re-derive `edgeSpeedKmh` under candidate tables, rebuild
 * the router, and re-run every pair. If a table exists that collapses the distance divergence
 * inside the gate, the table is the whole cause and the only question left is which one is right
 * for this city. If NO table does, the cause is something else and tuning speeds is wasted work.
 *
 * NO REBUILD REQUIRED. `Router` reads `edgeSpeedKmh` once, in its constructor, to precompute
 * per-edge seconds. Swapping in a different speed array over the same graph is therefore exact,
 * not an approximation, and it turns a 20-minute `build-city` per candidate into a few seconds.
 *
 * TAGGED SPEEDS ARE NEVER OVERRIDDEN. A candidate table changes DEFAULTS only. An edge whose way
 * carries a parseable `maxspeed` keeps it under every candidate, exactly as the pipeline does it,
 * or the experiment would be measuring a different graph rather than a different table.
 *
 * OSRM RESULTS ARE CACHED. The pairs are deterministic, so the reference distances are fetched
 * once into `data/osrm-pairs.json` and reused. Re-fetching 56 routes per candidate would hammer a
 * free public server for numbers that cannot have changed.
 *
 * THIS SCRIPT DECIDES NOTHING. It prints what each table does to the distribution. Adopting one is
 * a separate, deliberate change to `profile.ts` with its reasoning recorded in `DESIGN.md`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUILD_AREA, SNAP_DESTINATION_M } from '../config/city.ts';
import { ROUTING_FIXTURES } from '../config/fixtures/routing.ts';
import { SnapIndex } from '../packages/engine/snap.ts';
import { Router } from '../packages/engine/dijkstra.ts';
import { parseGraphArtifact } from '../packages/engine/graphfile.ts';
import { loadOrBuildClip } from '../packages/pipeline/clip/clip.ts';
import { CLASS_SPEED_KMH, parseMaxspeed } from '../packages/pipeline/graph/profile.ts';
import { readLock } from './fetch-extracts.ts';

const DATA = resolve(import.meta.dirname, '../data');
const OSRM = 'https://router.project-osrm.org';
const REQUEST_INTERVAL_MS = 1_100;
const SEED = 20260731;
const RANDOM_PAIRS = 50;
const MEDIAN_MAX = 0.03;
const P95_MAX = 0.07;

type Table = Readonly<Record<string, number>>;

/**
 * The candidates, and why each one is on the list. None of these is a proposal; they are probes
 * chosen to move the answer in a known direction so the RESPONSE tells us what is going on.
 */
const CANDIDATES: readonly { name: string; why: string; table: Table }[] = [
  {
    name: 'current',
    why: 'the baseline in profile.ts. Everything else is read against this.',
    table: CLASS_SPEED_KMH,
  },
  {
    name: 'osrm-car',
    why: "OSRM's own car.lua defaults. Not a proposal: it is the probe that says whether the table alone explains the gap.",
    table: {
      motorway: 90, motorway_link: 45, trunk: 85, trunk_link: 40, primary: 65, primary_link: 30,
      secondary: 55, secondary_link: 25, tertiary: 40, tertiary_link: 20, unclassified: 25,
      residential: 25, living_street: 10, service: 15, road: 25,
    },
  },
  {
    name: 'posted-x0.8',
    why: 'median POSTED limit per class from our own clip, uniformly discounted 20% for real conditions. Classes with under 20 tagged ways keep the current default, since a median of two is not evidence.',
    table: {
      motorway: 96, motorway_link: 45, trunk: 56, trunk_link: 40, primary: 48, primary_link: 30,
      secondary: 36, secondary_link: 25, tertiary: 32, tertiary_link: 25, unclassified: 30,
      residential: 16, living_street: 10, service: 16, road: 25,
    },
  },
  {
    name: 'local-fix',
    why: 'current table with ONLY the two numbers local posted limits contradict: trunk took no discount at all while every other class took 10 to 25 percent, and residential sat ABOVE its own posted limit. Nothing else moves, so whatever this changes is attributable to those two.',
    table: {
      motorway: 90, motorway_link: 45, trunk: 60, trunk_link: 35, primary: 50, primary_link: 30,
      secondary: 40, secondary_link: 25, tertiary: 35, tertiary_link: 25, unclassified: 30,
      residential: 20, living_street: 10, service: 15, road: 25,
    },
  },
  {
    name: 'flatter',
    why: 'current table with the gap between motorway and the mid classes narrowed. Probes whether the divergence is sensitive to the RATIO rather than the absolute speeds.',
    table: {
      motorway: 80, motorway_link: 45, trunk: 70, trunk_link: 40, primary: 55, primary_link: 30,
      secondary: 48, secondary_link: 25, tertiary: 42, tertiary_link: 25, unclassified: 30,
      residential: 25, living_street: 10, service: 15, road: 25,
    },
  },
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

console.log('=== speed table experiment ===');
const artifact = parseGraphArtifact(await readFile(resolve(DATA, 'graph.bin')));
const g = artifact.graph;
const snap = new SnapIndex(g, BUILD_AREA);

const lock = await readLock();
const { clipped } = await loadOrBuildClip(
  lock.extracts.map((e) => ({ name: e.name, localPath: e.localPath, md5: e.md5 })),
  resolve(DATA, 'clipped.bin'),
  () => {},
);

/** Per way: its highway class, and its tagged maxspeed when it has one. */
const wayClass = new Map<number, string>();
const wayTagged = new Map<number, number>();
for (const w of clipped.ways) {
  const h = w.tags.get('highway');
  if (h === undefined) continue;
  wayClass.set(w.id, h);
  const t = parseMaxspeed(w.tags.get('maxspeed'));
  if (t !== undefined) wayTagged.set(w.id, t);
}

const E = g.edgeFrom.length;
/** Precomputed per edge so each candidate is one pass over typed arrays, not a Map lookup storm. */
const edgeClass: string[] = new Array<string>(E);
const edgeTagged = new Float64Array(E);
for (let e = 0; e < E; e++) {
  const wid = g.edgeWayId[e] as number;
  edgeClass[e] = wayClass.get(wid) ?? '';
  edgeTagged[e] = wayTagged.get(wid) ?? 0;
}
let taggedEdges = 0;
for (let e = 0; e < E; e++) if ((edgeTagged[e] as number) > 0) taggedEdges++;
console.log(`  graph     ${E.toLocaleString('en-US')} edges, ${taggedEdges.toLocaleString('en-US')} carry a tagged maxspeed`);

// ---- Pairs, identical to validate-osrm.ts.
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

// ---- OSRM reference, fetched once and cached.
const CACHE = resolve(DATA, 'osrm-pairs.json');
type Cache = Record<string, { distance: number; duration: number }>;
let cache: Cache = {};
if (existsSync(CACHE)) cache = JSON.parse(await readFile(CACHE, 'utf8')) as Cache;
let fetched = 0;
for (const p of pairs) {
  if (cache[p.label] !== undefined) continue;
  const url = `${OSRM}/route/v1/driving/${p.a[0]},${p.a[1]};${p.b[0]},${p.b[1]}?overview=false`;
  const res = await fetch(url, { headers: { 'user-agent': 'wayfinder-gn speed experiment (single developer, throttled)' } });
  await sleep(REQUEST_INTERVAL_MS);
  if (!res.ok) continue;
  const body = (await res.json()) as { code?: string; routes?: { distance: number; duration: number }[] };
  if (body.code !== 'Ok' || body.routes === undefined || body.routes.length === 0) continue;
  const r = body.routes[0] as { distance: number; duration: number };
  cache[p.label] = { distance: r.distance, duration: r.duration };
  fetched++;
}
if (fetched > 0) await writeFile(CACHE, JSON.stringify(cache, null, 2), 'utf8');
console.log(`  osrm      ${Object.keys(cache).length} pairs cached (${fetched} fetched this run)\n`);

/**
 * Which pairs OSRM answered by leaving `BUILD_AREA`, from `npm run diagnose:route -- --all`.
 *
 * Reported as a SECOND column, never as a replacement for the full set. On those pairs the
 * reference drove through roads our graph does not contain and was never meant to, so the
 * comparison measures the clip boundary rather than the router. Both numbers are printed because
 * dropping the hard pairs silently is how a validation stops validating, and because the choice
 * of which set the gate asserts on is not this script's to make.
 */
const causesPath = resolve(DATA, 'divergence-causes.json');
const causes: Record<string, string> = existsSync(causesPath)
  ? (JSON.parse(await readFile(causesPath, 'utf8')) as Record<string, string>)
  : {};
const insideOnly = (label: string): boolean => causes[label] !== 'OUTSIDE AREA';
const knownCauses = Object.keys(causes).length;
console.log(
  knownCauses === 0
    ? '  causes    none on disk; run `npm run diagnose:route -- --all` for the inside-area split\n'
    : `  causes    ${knownCauses} pairs classified, ${Object.values(causes).filter((c) => c === 'OUTSIDE AREA').length} of them left BUILD_AREA\n`,
);

// ---- Run every candidate over every pair.
const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
console.log(
  `  ${'table'.padEnd(14)}${'dist med'.padStart(10)}${'dist p95'.padStart(10)}${'dur med'.padStart(10)}` +
    `${'dur p95'.padStart(10)}${'verdict'.padStart(10)}${'  inside med'.padStart(13)}${'inside p95'.padStart(12)}`,
);

interface Outcome {
  readonly name: string;
  readonly medianDist: number;
  readonly p95Dist: number;
  readonly perPair: ReadonlyMap<string, number>;
}
const outcomes: Outcome[] = [];

for (const cand of CANDIDATES) {
  const speeds = new Uint8Array(E);
  for (let e = 0; e < E; e++) {
    const tagged = edgeTagged[e] as number;
    if (tagged > 0) {
      speeds[e] = Math.max(1, Math.min(255, Math.round(tagged)));
      continue;
    }
    const def = cand.table[edgeClass[e] as string];
    // An edge whose class is not in the candidate keeps whatever the artifact already had, so a
    // gap in a candidate table can never silently zero an edge and sever the graph.
    speeds[e] = def === undefined ? (g.edgeSpeedKmh[e] as number) : Math.max(1, Math.min(255, Math.round(def)));
  }
  const router = new Router({ ...g, edgeSpeedKmh: speeds }, artifact.restrictions);

  const deltas: number[] = [];
  const durDeltas: number[] = [];
  const inside: number[] = [];
  const perPair = new Map<string, number>();
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
    durDeltas.push(Math.abs((r.seconds - ref.duration) / ref.duration));
    if (insideOnly(p.label)) inside.push(Math.abs(d));
    perPair.set(p.label, d);
  }
  const sd = [...deltas].sort((x, y) => x - y);
  const su = [...durDeltas].sort((x, y) => x - y);
  const si = [...inside].sort((x, y) => x - y);
  const medianDist = quantile(sd, 0.5);
  const p95Dist = quantile(sd, 0.95);
  const ok = medianDist <= MEDIAN_MAX && p95Dist <= P95_MAX;
  console.log(
    `  ${cand.name.padEnd(14)}${pct(medianDist).padStart(10)}${pct(p95Dist).padStart(10)}` +
      `${pct(quantile(su, 0.5)).padStart(10)}${pct(quantile(su, 0.95)).padStart(10)}${(ok ? 'PASS' : 'FAIL').padStart(10)}` +
      `${(knownCauses === 0 ? '-' : pct(quantile(si, 0.5))).padStart(13)}` +
      `${(knownCauses === 0 ? '-' : pct(quantile(si, 0.95))).padStart(12)}`,
  );
  outcomes.push({ name: cand.name, medianDist, p95Dist, perPair });
}

console.log('\n  why each candidate is in the list:');
for (const c of CANDIDATES) console.log(`    ${c.name.padEnd(14)} ${c.why}`);

// ---- Where the candidates disagree most, so a table change is never adopted blind.
const base = outcomes.find((o) => o.name === 'current');
if (base !== undefined) {
  for (const o of outcomes) {
    if (o.name === 'current') continue;
    const moved = [...o.perPair]
      .map(([label, d]) => ({ label, d, was: base.perPair.get(label) ?? 0 }))
      .filter((x) => Math.abs(x.d - x.was) > 0.02)
      .sort((x, y) => Math.abs(y.d - y.was) - Math.abs(x.d - x.was));
    const helped = moved.filter((x) => Math.abs(x.d) < Math.abs(x.was)).length;
    const hurt = moved.filter((x) => Math.abs(x.d) > Math.abs(x.was)).length;
    console.log(`\n  ${o.name}: ${moved.length} pairs moved more than 2 points. ${helped} improved, ${hurt} worsened.`);
    for (const m of moved.slice(0, 6)) {
      console.log(`    ${m.label.padEnd(34)} ${pct(m.was)} -> ${pct(m.d)}`);
    }
  }
}
