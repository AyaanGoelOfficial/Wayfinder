/**
 * Did the distance preference flatten the class hierarchy, and did the quality weights fix it?
 * `npm run diagnose:flattening`.
 *
 * WHY THIS IS IN THE REPO AND NOT A SCRATCH FILE. It is the evidence for a decision that changed
 * the objective. Two proposals were rejected on the strength of what it measures, and a rejection
 * whose evidence has been deleted is indistinguishable from an opinion.
 *
 * THE THREE QUESTIONS, in the order they have to be asked:
 *
 *   1. WHAT IS THE RATIO. The effective seconds per km of each class, and the motorway to tertiary
 *      ratio under each candidate. A flat rate compresses it; weighting must not.
 *   2. WHAT DID IT DO TO REAL ROUTES. The share of route distance spent on each class across the
 *      56 validation pairs. This is the question the ratio is a proxy for, and it is the one that
 *      matters: "we now prefer village roads" is a claim about routes, not about a table.
 *   3. CAN A DETOUR EVEN BE PRICED SEPARATELY FROM A TRIP. The rejected proposal was to charge
 *      only the distance in EXCESS of the straight line between origin and destination, so that
 *      the unavoidable trip length went unpriced. That is a no-op, and this proves it rather than
 *      arguing it: every route is already longer than the straight line between its own endpoints,
 *      so `max(0, dist - D)` never clips, `D` is a per-query CONSTANT, and subtracting a constant
 *      from every candidate cannot change which one is cheapest. The proof generalises to any
 *      query-constant baseline, the shortest path included.
 *
 * WHY THE SECOND PROPOSAL WAS ALSO REJECTED, since the arithmetic belongs beside the measurement.
 * Preserving the class ratio EXACTLY requires `quality` proportional to seconds-per-km, which
 * makes the distance term `lambda * driveTime` and the whole objective `(1 + lambda) * driveTime`,
 * a scalar on time. The preference would stop having any opinion. So exact preservation and a live
 * distance preference are mutually exclusive, and the shipped answer expands the ratio instead,
 * by making rough kilometres cost more rather than long trips cost more.
 *
 * DOES NOT TOUCH THE NETWORK. Everything here comes from `data/graph.bin`.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUILD_AREA, OBJECTIVE, SNAP_DESTINATION_M, TURN_COST } from '../config/city.ts';
import { ROUTING_FIXTURES } from '../config/fixtures/routing.ts';
import { SnapIndex } from '../packages/engine/snap.ts';
import { Router } from '../packages/engine/dijkstra.ts';
import { parseGraphArtifact } from '../packages/engine/graphfile.ts';
import { haversineM } from '../packages/shared/geo.ts';
import { CLASS_SPEED_KMH } from '../packages/pipeline/graph/profile.ts';
import type { ObjectiveConfig } from '../packages/shared/index.ts';

const DATA = resolve(import.meta.dirname, '../data');
const SEED = 20260731;
const RANDOM_PAIRS = 50;

/** One representative class per `CLASS_RANK`, biggest road first. Index IS the rank. */
const BY_RANK = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service'];

const FLAT: ObjectiveConfig = { secondsPerKm: 24, tollReluctanceSecondsPerKm: 12, avoidTollsByDefault: false };
const TIME_ONLY: ObjectiveConfig = { secondsPerKm: 0, tollReluctanceSecondsPerKm: 0, avoidTollsByDefault: false };

const CANDIDATES: readonly { name: string; cfg: ObjectiveConfig }[] = [
  { name: 'time only', cfg: TIME_ONLY },
  { name: 'flat 24', cfg: FLAT },
  { name: 'SHIPPED', cfg: OBJECTIVE },
];

const graphPath = resolve(DATA, 'graph.bin');
if (!existsSync(graphPath)) {
  console.error('data/graph.bin is missing. Run `npm run build-city` first.');
  process.exit(1);
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const secPerKm = (rank: number): number => 3600 / (CLASS_SPEED_KMH[BY_RANK[rank] as string] as number);
const effective = (rank: number, cfg: ObjectiveConfig): number =>
  secPerKm(rank) + cfg.secondsPerKm * (cfg.qualityByRank?.[rank] ?? 1);

// --- 1. the ratio ---------------------------------------------------------------------------

console.log('=== 1. effective seconds per km, by class ===\n');
console.log(`  ${'class'.padEnd(14)}${'km/h'.padStart(6)}${CANDIDATES.map((c) => c.name.padStart(11)).join('')}`);
for (let rank = 0; rank < BY_RANK.length; rank++) {
  console.log(
    `  ${(BY_RANK[rank] as string).padEnd(14)}${String(CLASS_SPEED_KMH[BY_RANK[rank] as string]).padStart(6)}` +
      CANDIDATES.map((c) => effective(rank, c.cfg).toFixed(2).padStart(11)).join(''),
  );
}
const baseline = effective(4, TIME_ONLY) / effective(0, TIME_ONLY);
console.log(`\n  motorway to tertiary ratio, against a time-only baseline of ${baseline.toFixed(3)}:`);
for (const c of CANDIDATES) {
  const r = effective(4, c.cfg) / effective(0, c.cfg);
  const verdict = r < baseline - 1e-9 ? 'COMPRESSED' : r > baseline + 1e-9 ? 'expanded' : 'preserved';
  console.log(`    ${c.name.padEnd(12)}${r.toFixed(3).padStart(7)}   ${verdict}`);
}

// --- setup ----------------------------------------------------------------------------------

const artifact = parseGraphArtifact(await readFile(graphPath));
const g = artifact.graph;
const snap = new SnapIndex(g, BUILD_AREA);

interface Pair { readonly label: string; readonly a: [number, number]; readonly b: [number, number] }
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

// --- 2. what it did to real routes -----------------------------------------------------------

console.log(`\n=== 2. share of route distance by class, across ${pairs.length} pairs ===\n`);
console.log(
  `  ${'candidate'.padEnd(12)}${BY_RANK.map((n) => n.slice(0, 6).padStart(8)).join('')}${'slow%'.padStart(9)}${'km'.padStart(10)}`,
);

let clipBinds = 0;
let routesChecked = 0;
let minRatio = Infinity;
const slowShare: number[] = [];

for (const cand of CANDIDATES) {
  const router = new Router(g, artifact.restrictions, TURN_COST, cand.cfg);
  const byRank = new Array<number>(BY_RANK.length).fill(0);
  let total = 0;
  for (const p of pairs) {
    const sa = snap.snap(p.a, 'destination', SNAP_DESTINATION_M);
    const sb = snap.snap(p.b, 'destination', SNAP_DESTINATION_M);
    if (sa === null || sb === null) continue;
    const r = router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction);
    if (r === null) continue;
    for (const e of r.edges) {
      const rank = g.edgeClassRank[e] as number;
      byRank[rank] = (byRank[rank] as number) + (g.edgeLengthM[e] as number);
      total += g.edgeLengthM[e] as number;
    }
    // Question 3, gathered in the same pass. Does the straight-line clip ever bind?
    const straight = haversineM(sa.point[1], sa.point[0], sb.point[1], sb.point[0]);
    routesChecked++;
    if (r.metres < straight) clipBinds++;
    if (straight > 0) minRatio = Math.min(minRatio, r.metres / straight);
  }
  const share = byRank.map((m) => (m / total) * 100);
  // Tertiary and below: the roads the complaint was actually about.
  const slow = share.slice(4).reduce((a, b) => a + b, 0);
  slowShare.push(slow);
  console.log(
    `  ${cand.name.padEnd(12)}${share.map((s) => s.toFixed(1).padStart(8)).join('')}` +
      `${slow.toFixed(1).padStart(9)}${(total / 1000).toFixed(0).padStart(10)}`,
  );
}

const [timeOnlySlow, flatSlow, shippedSlow] = slowShare as [number, number, number];
console.log(`\n  tertiary and below, which is the share the complaint was about:`);
console.log(`    time only  ${timeOnlySlow.toFixed(1)}%   the baseline, no distance preference at all`);
console.log(`    flat 24    ${flatSlow.toFixed(1)}%   ${(flatSlow - timeOnlySlow >= 0 ? '+' : '')}${(flatSlow - timeOnlySlow).toFixed(1)} points, the defect`);
console.log(`    SHIPPED    ${shippedSlow.toFixed(1)}%   ${(shippedSlow - timeOnlySlow >= 0 ? '+' : '')}${(shippedSlow - timeOnlySlow).toFixed(1)} points against baseline`);
const recovered = flatSlow === timeOnlySlow ? 0 : ((flatSlow - shippedSlow) / (flatSlow - timeOnlySlow)) * 100;
console.log(`\n  the weights recovered ${recovered.toFixed(0)}% of the drift the flat rate introduced.`);

// --- 3. the rejected proposal ----------------------------------------------------------------

console.log('\n=== 3. can a detour be priced separately from the trip? ===\n');
console.log(`  routes checked                          ${routesChecked}`);
console.log(`  routes SHORTER than their straight line ${clipBinds}`);
console.log(`  smallest route to straight-line ratio   ${minRatio.toFixed(4)}`);
console.log('\n  Zero means max(0, dist - D) never clips, so it equals dist - D for every candidate');
console.log('  route in every query. D is fixed per query, so this subtracts the same constant from');
console.log('  every candidate and cannot change which one wins. Charging only the excess over the');
console.log('  straight line is not a weaker distance preference, it is the identical preference.');
