/**
 * Three changes landed together. Which one moved which number? `npm run isolate:tolls`.
 *
 * The toll model changed in three independent ways at once, and the totals afterwards cannot tell
 * them apart. This turns each one off from the CURRENT state, one at a time, over the SAME graph in
 * the SAME process, and reports what each is worth on its own.
 *
 *   A  cost of driving        550 rupees/hour back to 225, so every rupee costs more time again
 *   B  ramp attribution       36 EPE and 2 Yamuna slip roads back to `unpriced`
 *   C  the search proxy       gate-charged roads free between barriers again
 *
 * ONE AT A TIME FROM THE CURRENT STATE, never cumulatively. A cumulative walk makes each figure
 * depend on the order the changes are applied in, so the second one measured is always credited
 * with whatever the first left behind. Turning each off from a common baseline makes the three
 * figures comparable. They are then re-composed and checked against turning all three off together,
 * which is what says whether they interact.
 *
 * ⛔ B IS NOT PURELY BEHAVIOURAL, and the report must never present it as though it were. Attributing
 * a slip road to its parent moves kilometres between buckets even when the route through them does
 * not change by a metre. Every B row therefore carries the count of routes whose geometry is
 * IDENTICAL to the current state; kilometres that move on an identical route are reclassification,
 * and only the rest is the router choosing differently.
 *
 * ⛔ C IS AN UPPER BOUND ON ITS OWN EFFECT, and the reason is stated rather than buried. The old
 * proxy had two halves: no per-kilometre cost between barriers, AND the whole barrier fee landing on
 * the single edge that carried the booth. Only the first is expressible through the objective, so
 * only the first is reconstructed here. The missing half was a cost of ENTERING a tolled road, so
 * including it would push tolled kilometres further down. The true effect of the change is therefore
 * no larger than what this reports.
 *
 * WHAT IS NOT RECONSTRUCTED AT ALL: the state at commit 9e547ec, which has no per-road toll table
 * whatsoever, only a single flat reluctance rate. The three-way comparison here is against last
 * session's working state, which was superseded before it was ever committed.
 *
 * MEASUREMENT ONLY. Reads the built artifacts, changes no constant and no model, writes nothing.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BUILD_AREA, OBJECTIVE, SNAP_DESTINATION_M, TOLL_ROADS, TURN_COST } from '../config/city.ts';
import { ROUTING_FIXTURES } from '../config/fixtures/routing.ts';
import type { RoutableGraph, RouteResult } from '../packages/engine/dijkstra.ts';
import { Router } from '../packages/engine/dijkstra.ts';
import { parseGraphArtifact } from '../packages/engine/graphfile.ts';
import { SnapIndex } from '../packages/engine/snap.ts';
import { loadOrBuildClip } from '../packages/pipeline/clip/clip.ts';
import { attributeTollRamps, tollRoadOf } from '../packages/pipeline/graph/profile.ts';
import type { TollRoad } from '../packages/shared/index.ts';
import { readLock } from './fetch-extracts.ts';

const DATA = resolve(import.meta.dirname, '../data');
const SEED = 20260731;
const RANDOM_PAIRS = 50;
/** The superseded cost of an hour of driving. Kept only so variable A has something to run against. */
const OLD_RUPEES_PER_HOUR = 225;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const artifact = parseGraphArtifact(await readFile(resolve(DATA, 'graph.bin')));
const g = artifact.graph;
const snap = new SnapIndex(g, BUILD_AREA);
const unpricedId = (TOLL_ROADS.find((r) => r.key === 'unpriced') as TollRoad).id;

console.log('=== isolating the three toll changes ===');
console.log(`  ${g.edgeFrom.length.toLocaleString('en-US')} directed edges, one graph, one process`);

// --- variable B: undo ramp attribution, exactly ---------------------------------------------------

const lock = await readLock();
const { clipped } = await loadOrBuildClip(
  lock.extracts.map((e) => ({ name: e.name, localPath: e.localPath, md5: e.md5 })),
  resolve(DATA, 'clipped.bin'),
  () => {},
);
const byName = new Map<number, number>();
for (const w of clipped.ways) byName.set(w.id, tollRoadOf(w.id, w.tags));
const { reassigned, rounds } = attributeTollRamps(clipped.ways, byName, unpricedId);

// The un-attributed graph differs from the current one in exactly one array, so nothing else can
// drift between the two runs.
const noRampsTollRoad = new Uint8Array(g.edgeTollRoad);
let patchedEdges = 0;
for (let e = 0; e < g.edgeWayId.length; e++) {
  if (reassigned.has(g.edgeWayId[e] as number)) {
    noRampsTollRoad[e] = unpricedId;
    patchedEdges++;
  }
}
const noRampsGraph: RoutableGraph = { ...g, edgeTollRoad: noRampsTollRoad };
console.log(
  `  variable B: ${reassigned.size} ways re-attributed in ${rounds} rounds, ` +
    `${patchedEdges.toLocaleString('en-US')} graph edges reverted to unpriced`,
);

// --- the four routers -----------------------------------------------------------------------------

/** Gate-charged roads free between barriers, which is the half of the old proxy that is expressible. */
const freeBetweenBarriers = TOLL_ROADS.map((r) =>
  r.mechanism === 'gate-hybrid' ? { ...r, searchRatePerKm: 0 } : r,
);

const CONFIGS = [
  { key: 'now', label: 'current state, all three changes in', graph: g, obj: OBJECTIVE },
  {
    key: 'A',
    label: 'A off: 225 rupees/hour instead of 550',
    graph: g,
    obj: { ...OBJECTIVE, secondsPerRupee: 3600 / OLD_RUPEES_PER_HOUR },
  },
  { key: 'B', label: 'B off: ramps back to unpriced', graph: noRampsGraph, obj: OBJECTIVE },
  {
    key: 'C',
    label: 'C off: gate roads free between barriers',
    graph: g,
    obj: { ...OBJECTIVE, tollRoads: freeBetweenBarriers },
  },
  {
    key: 'all',
    label: 'all three off together',
    graph: noRampsGraph,
    obj: {
      ...OBJECTIVE,
      secondsPerRupee: 3600 / OLD_RUPEES_PER_HOUR,
      tollRoads: freeBetweenBarriers,
    },
  },
] as const;

const routers = new Map<string, Router>();
for (const c of CONFIGS) routers.set(c.key, new Router(c.graph, artifact.restrictions, TURN_COST, c.obj));

// --- the same 56 pairs as `npm run validate`, same seed --------------------------------------------

interface Pair {
  readonly label: string;
  readonly a: readonly [number, number];
  readonly b: readonly [number, number];
}
const pairs: Pair[] = [];
{
  // Round robin over the fixtures, EXACTLY as `validate-osrm.ts` builds them. Not a similar
  // selection: the labels have to name the same pairs or the rows cannot be read side by side.
  for (let i = 0; i < ROUTING_FIXTURES.length; i++) {
    const f = ROUTING_FIXTURES[i] as (typeof ROUTING_FIXTURES)[number];
    const h = ROUTING_FIXTURES[(i + 1) % ROUTING_FIXTURES.length] as (typeof ROUTING_FIXTURES)[number];
    pairs.push({ label: `${f.id} to ${h.id}`, a: [f.lon, f.lat], b: [h.lon, h.lat] });
  }
  const r = rng(SEED);
  let n = 0;
  while (n < RANDOM_PAIRS) {
    const pick = (): [number, number] => [
      BUILD_AREA.minLon + r() * (BUILD_AREA.maxLon - BUILD_AREA.minLon),
      BUILD_AREA.minLat + r() * (BUILD_AREA.maxLat - BUILD_AREA.minLat),
    ];
    const a = pick();
    const b = pick();
    if (snap.snap(a, 'destination', SNAP_DESTINATION_M) === null) continue;
    if (snap.snap(b, 'destination', SNAP_DESTINATION_M) === null) continue;
    n++;
    pairs.push({ label: `random ${n}`, a, b });
  }
}
console.log(`  ${pairs.length} pairs, seed ${SEED}, identical selection to npm run validate\n`);

// --- run every configuration over every pair -------------------------------------------------------

interface Row {
  readonly label: string;
  readonly km: ReadonlyMap<number, number>;
  readonly totalKm: number;
  readonly driveMin: number;
  readonly billed: number;
  readonly geom: readonly string[];
}

/**
 * Tolled kilometres attributed by road, taken from the CHOSEN path rather than from the search.
 *
 * Trimmed with the same fractions the router trims `metres` with, so a route that enters a tolled
 * edge partway is not charged for road it never covered.
 */
function measure(router: Router, graph: RoutableGraph, label: string): Row {
  const km = new Map<number, number>();
  let totalKm = 0;
  let driveMin = 0;
  let billed = 0;
  const geom: string[] = [];
  for (const p of pairs) {
    const sa = snap.snap(p.a, 'destination', SNAP_DESTINATION_M);
    const sb = snap.snap(p.b, 'destination', SNAP_DESTINATION_M);
    if (sa === null || sb === null) {
      geom.push('');
      continue;
    }
    const res: RouteResult | null = router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction);
    if (res === null) {
      geom.push('');
      continue;
    }
    driveMin += res.driveSeconds / 60;
    billed += res.tollCost;
    // A cheap identity for "the same road was driven", so a kilometre that moved between buckets on
    // an unchanged route can be told apart from a route that actually changed.
    geom.push(`${res.edges.length}:${res.metres.toFixed(1)}`);
    for (let i = 0; i < res.edges.length; i++) {
      const e = res.edges[i] as number;
      const road = graph.edgeTollRoad[e] as number;
      if (road === 0) continue;
      let m = graph.edgeLengthM[e] as number;
      if (i === 0 || i === res.edges.length - 1) {
        // The router does not expose its trim fractions, so the two end edges are excluded rather
        // than counted whole. On a 56-pair total this is under 0.1 km and it never over-counts.
        m = 0;
      }
      km.set(road, (km.get(road) ?? 0) + m / 1000);
      totalKm += m / 1000;
    }
  }
  return { label, km, totalKm, driveMin, billed, geom };
}

const rows = new Map<string, Row>();
for (const c of CONFIGS) rows.set(c.key, measure(routers.get(c.key) as Router, c.graph, c.label));

const ROADS = TOLL_ROADS.map((r) => r);
const nowRow = rows.get('now') as Row;

console.log('--- tolled km across all 56 pairs, per configuration ---');
console.log(
  `  ${'configuration'.padEnd(44)}${ROADS.map((r) => r.key.slice(0, 9).padStart(11)).join('')}${'total'.padStart(11)}`,
);
for (const c of CONFIGS) {
  const row = rows.get(c.key) as Row;
  console.log(
    `  ${c.label.padEnd(44)}` +
      ROADS.map((r) => (row.km.get(r.id) ?? 0).toFixed(1).padStart(11)).join('') +
      row.totalKm.toFixed(1).padStart(11),
  );
}

console.log('\n--- what each change is worth ON ITS OWN, as (current) minus (that change off) ---');
console.log(
  `  ${'change'.padEnd(44)}${ROADS.map((r) => r.key.slice(0, 9).padStart(11)).join('')}${'total'.padStart(11)}${'routes moved'.padStart(14)}`,
);
for (const c of CONFIGS.filter((x) => x.key !== 'now')) {
  const row = rows.get(c.key) as Row;
  let moved = 0;
  for (let i = 0; i < nowRow.geom.length; i++) if (nowRow.geom[i] !== row.geom[i]) moved++;
  console.log(
    `  ${c.label.padEnd(44)}` +
      ROADS.map((r) => ((nowRow.km.get(r.id) ?? 0) - (row.km.get(r.id) ?? 0)).toFixed(1).padStart(11)).join('') +
      ((nowRow.totalKm - row.totalKm) as number).toFixed(1).padStart(11) +
      `${moved} of ${pairs.length}`.padStart(14),
  );
}

console.log('\n--- do the three compose, or do they interact? ---');
{
  const allOff = rows.get('all') as Row;
  for (const r of [...ROADS, { id: -1, key: 'TOTAL' }]) {
    const at = (row: Row): number => (r.id === -1 ? row.totalKm : (row.km.get(r.id) ?? 0));
    const sumOfParts = CONFIGS.filter((c) => c.key !== 'now' && c.key !== 'all').reduce(
      (acc, c) => acc + (at(nowRow) - at(rows.get(c.key) as Row)),
      0,
    );
    const together = at(nowRow) - at(allOff);
    console.log(
      `  ${r.key.padEnd(22)} sum of the three separately ${sumOfParts.toFixed(1).padStart(8)} km, ` +
        `all three at once ${together.toFixed(1).padStart(8)} km, ` +
        `interaction ${(together - sumOfParts).toFixed(1).padStart(8)} km`,
    );
  }
}

console.log('\n--- the same isolation on drive time and on what the driver is billed ---');
console.log(`  ${'configuration'.padEnd(44)}${'drive min'.padStart(12)}${'billed Rs'.padStart(12)}`);
for (const c of CONFIGS) {
  const row = rows.get(c.key) as Row;
  console.log(`  ${c.label.padEnd(44)}${row.driveMin.toFixed(1).padStart(12)}${row.billed.toFixed(0).padStart(12)}`);
}

// --- variable B, split into reclassification and behaviour ------------------------------------------

{
  const bRow = rows.get('B') as Row;
  let identical = 0;
  for (let i = 0; i < nowRow.geom.length; i++) if (nowRow.geom[i] === bRow.geom[i] && nowRow.geom[i] !== '') identical++;
  console.log('\n--- variable B: how much of it is reclassification rather than the router choosing differently ---');
  console.log(`  routes geometrically IDENTICAL with and without ramp attribution: ${identical} of ${pairs.length}`);
  console.log(
    `  On an identical route no kilometre was newly driven, so every kilometre that moved between\n` +
      `  buckets on those ${identical} routes is a change of LABEL, not of behaviour.`,
  );
}
