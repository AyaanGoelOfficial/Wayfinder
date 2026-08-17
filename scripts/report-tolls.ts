/**
 * What does the toll model actually charge, and what did changing it do? `npm run report:tolls`.
 *
 * MEASUREMENT ONLY. Reads the built artifacts and reports; changes no constant and no model.
 *
 * WHY A SCRIPT AND NOT A ONE-OFF. Every number here has to be re-checked whenever a tariff, a rate
 * board, or the cost of an hour of driving moves, and a figure produced once by hand is a figure
 * nobody can reproduce. Same 56 pairs as `npm run validate`, same seed, so the rows line up.
 *
 * THE A/B IS REAL, NOT REMEMBERED. The cost-of-driving comparison runs both objectives over the
 * same graph in the same process, so "toll roads became more attractive" is measured rather than
 * asserted. `hard-rules.md` forbids reporting a negative result without a positive control, and
 * the same logic applies to a claimed shift: a comparison against a number recalled from an
 * earlier session is not a measurement.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  BUILD_AREA,
  EPE_PLAZAS,
  OBJECTIVE,
  SNAP_DESTINATION_M,
  TOLL_ROADS,
  TURN_COST,
} from '../config/city.ts';
import { ROUTING_FIXTURES } from '../config/fixtures/routing.ts';
import { Router } from '../packages/engine/dijkstra.ts';
import { parseGraphArtifact } from '../packages/engine/graphfile.ts';
import { SnapIndex } from '../packages/engine/snap.ts';
import { EPE_SEGMENT_NONE, TOLL_GATE_MAINLINE, TOLL_GATE_RAMP } from '../packages/shared/graphfile.ts';

const DATA = resolve(import.meta.dirname, '../data');
const SEED = 20260731;
const RANDOM_PAIRS = 50;
/** The superseded cost of an hour of driving, kept solely so the A/B has something to run against. */
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
const router = new Router(g, artifact.restrictions, TURN_COST, OBJECTIVE);
const oldRouter = new Router(g, artifact.restrictions, TURN_COST, {
  ...OBJECTIVE,
  secondsPerRupee: 3600 / OLD_RUPEES_PER_HOUR,
});
const roadOf = (id: number): (typeof TOLL_ROADS)[number] | undefined => TOLL_ROADS.find((r) => r.id === id);

console.log('=== toll model report ===');
console.log(`  ${(g.edgeFrom.length as number).toLocaleString('en-US')} edges, driving cost ${(3600 / OBJECTIVE.secondsPerRupee).toFixed(0)} rupees/hour, ${OBJECTIVE.secondsPerRupee.toFixed(3)} s per rupee`);

// --- what the graph itself holds ------------------------------------------------------------------

{
  console.log('\n--- tolled network in the graph, per road ---');
  const km = new Map<number, number>();
  const mainGates = new Map<number, number>();
  const rampGates = new Map<number, number>();
  const withSegment = new Map<number, number>();
  for (let e = 0; e < g.edgeFrom.length; e++) {
    const road = g.edgeTollRoad[e] as number;
    if (road === 0) continue;
    km.set(road, (km.get(road) ?? 0) + (g.edgeLengthM[e] as number) / 1000);
    const gate = g.edgeTollGate[e] as number;
    if (gate === TOLL_GATE_MAINLINE) mainGates.set(road, (mainGates.get(road) ?? 0) + 1);
    if (gate === TOLL_GATE_RAMP) rampGates.set(road, (rampGates.get(road) ?? 0) + 1);
    if ((g.edgeTollSegment[e] as number) !== EPE_SEGMENT_NONE) {
      withSegment.set(road, (withSegment.get(road) ?? 0) + 1);
    }
  }
  console.log(`  ${'road'.padEnd(32)}${'km'.padStart(9)}${'mainline'.padStart(10)}${'ramp'.padStart(7)}${'spanned'.padStart(9)}  confidence`);
  for (const r of TOLL_ROADS) {
    console.log(
      `  ${r.label.padEnd(32)}${(km.get(r.id) ?? 0).toFixed(2).padStart(9)}${String(mainGates.get(r.id) ?? 0).padStart(10)}` +
        `${String(rampGates.get(r.id) ?? 0).padStart(7)}${String(withSegment.get(r.id) ?? 0).padStart(9)}  ${r.confidence}`,
    );
  }
  // Both halves of the km total, since "edges" here are directed and every two-way metre is stored
  // twice. Stated so the figure is not read as centreline length.
  const total = [...km.values()].reduce((a, b) => a + b, 0);
  console.log(`  ${'TOTAL (directed edge km, both carriageways)'.padEnd(32)}${total.toFixed(2).padStart(9)}`);
}

// --- the landmark pair ------------------------------------------------------------------------------

interface Priced {
  distanceKm: number;
  driveMin: number;
  tollCost: number;
  confidence: string;
  display: string;
  tollKm: number;
  perRoad: Map<number, number>;
  runs: string[];
}

function priceRoute(r: ReturnType<Router['route']>): Priced | null {
  if (r === null) return null;
  const perRoad = new Map<number, number>();
  const runs: string[] = [];
  let runRoad = 0;
  let runMin = EPE_SEGMENT_NONE;
  let runMax = EPE_SEGMENT_NONE;
  let runKm = 0;
  let runMain = 0;
  let runRamp = 0;
  const close = (): void => {
    const road = roadOf(runRoad);
    if (road !== undefined) {
      const where =
        runMin === EPE_SEGMENT_NONE
          ? 'no plaza span'
          : `${EPE_PLAZAS[runMin]?.label ?? '?'} to ${EPE_PLAZAS[runMax + 1]?.label ?? '?'}`;
      runs.push(`${road.key} ${runKm.toFixed(2)} km, ${runMain} mainline, ${runRamp} ramp, ${where}`);
    }
    runRoad = 0;
    runKm = 0;
    runMain = 0;
    runRamp = 0;
    runMin = EPE_SEGMENT_NONE;
    runMax = EPE_SEGMENT_NONE;
  };
  for (const e of r.edges) {
    const road = g.edgeTollRoad[e] as number;
    if (road !== runRoad) {
      close();
      runRoad = road;
    }
    if (road === 0) continue;
    const m = (g.edgeLengthM[e] as number) / 1000;
    runKm += m;
    perRoad.set(road, (perRoad.get(road) ?? 0) + m);
    const gate = g.edgeTollGate[e] as number;
    if (gate === TOLL_GATE_MAINLINE) runMain++;
    if (gate === TOLL_GATE_RAMP) runRamp++;
    const seg = g.edgeTollSegment[e] as number;
    if (seg !== EPE_SEGMENT_NONE) {
      if (runMin === EPE_SEGMENT_NONE || seg < runMin) runMin = seg;
      if (runMax === EPE_SEGMENT_NONE || seg > runMax) runMax = seg;
    }
  }
  close();
  return {
    distanceKm: r.metres / 1000,
    driveMin: r.driveSeconds / 60,
    tollCost: r.tollCost,
    confidence: r.tollConfidence,
    display: r.tollDisplay,
    tollKm: r.tollMetres / 1000,
    perRoad,
    runs,
  };
}

{
  console.log('\n--- the landmark pair, gautam-buddha-university to jewar ---');
  const a = ROUTING_FIXTURES.find((f) => f.id === 'gautam-buddha-university');
  const b = ROUTING_FIXTURES.find((f) => f.id === 'jewar');
  if (a === undefined || b === undefined) {
    console.log('  fixtures missing; nothing to price');
  } else {
    const sa = snap.snap([a.lon, a.lat], 'destination', SNAP_DESTINATION_M);
    const sb = snap.snap([b.lon, b.lat], 'destination', SNAP_DESTINATION_M);
    if (sa === null || sb === null) {
      console.log('  did not snap');
    } else {
      for (const [label, opts] of [
        ['tolls allowed', undefined],
        ['avoidTolls', { avoidTolls: true }],
      ] as const) {
        const p = priceRoute(router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction, opts));
        if (p === null) {
          console.log(`  ${label.padEnd(14)} no route`);
          continue;
        }
        console.log(
          `  ${label.padEnd(14)} ${p.distanceKm.toFixed(2).padStart(7)} km  ${p.driveMin.toFixed(1).padStart(6)} min  ` +
            `Rs ${p.tollCost.toFixed(2).padStart(7)}  ${p.confidence.padEnd(13)}${p.display.padEnd(10)}${p.tollKm.toFixed(2)} tolled km`,
        );
        for (const run of p.runs) console.log(`                 run: ${run}`);
      }
    }
  }
}

// --- the 56 pairs -------------------------------------------------------------------------------

const pairs: { label: string; a: [number, number]; b: [number, number] }[] = [];
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

interface Row {
  label: string;
  now: Priced;
  then: Priced;
  changed: boolean;
}
const rows: Row[] = [];
for (const p of pairs) {
  const sa = snap.snap(p.a, 'destination', SNAP_DESTINATION_M);
  const sb = snap.snap(p.b, 'destination', SNAP_DESTINATION_M);
  if (sa === null || sb === null) continue;
  const now = router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction);
  const then = oldRouter.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction);
  const pn = priceRoute(now);
  const pt = priceRoute(then);
  if (pn === null || pt === null || now === null || then === null) continue;
  const same =
    now.edges.length === then.edges.length && now.edges.every((e, i) => e === then.edges[i]);
  rows.push({ label: p.label, now: pn, then: pt, changed: !same });
}

console.log(`\n--- ${rows.length} pairs, tolls under the shipped model ---`);
{
  const perRoad = new Map<number, number>();
  const conf = new Map<string, number>();
  const disp = new Map<string, number>();
  let cost = 0;
  let touching = 0;
  for (const r of rows) {
    for (const [road, km] of r.now.perRoad) perRoad.set(road, (perRoad.get(road) ?? 0) + km);
    cost += r.now.tollCost;
    if (r.now.tollKm > 0) {
      touching++;
      conf.set(r.now.confidence, (conf.get(r.now.confidence) ?? 0) + 1);
      disp.set(r.now.display, (disp.get(r.now.display) ?? 0) + 1);
    }
  }
  console.log(`  ${'road'.padEnd(32)}${'route km'.padStart(10)}`);
  for (const r of TOLL_ROADS) {
    console.log(`  ${r.label.padEnd(32)}${(perRoad.get(r.id) ?? 0).toFixed(1).padStart(10)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(32)}${[...perRoad.values()].reduce((a, b) => a + b, 0).toFixed(1).padStart(10)}`);
  console.log(`  ${touching} of ${rows.length} pairs touch a tolled road; total billed Rs ${cost.toFixed(2)}`);
  console.log(`  confidence: ${[...conf].map(([k, v]) => `${k} ${v}`).join(', ') || '(none)'}`);
  console.log(`  display:    ${[...disp].map(([k, v]) => `${k} ${v}`).join(', ') || '(none)'}`);
}

console.log('\n--- pairs on the closed-system road, priced from the published matrix ---');
{
  const epeId = TOLL_ROADS.find((r) => r.key === 'eastern-peripheral')?.id ?? -1;
  let n = 0;
  for (const r of rows) {
    const km = r.now.perRoad.get(epeId);
    if (km === undefined || km === 0) continue;
    n++;
    const run = r.now.runs.find((s) => s.startsWith('eastern-peripheral')) ?? '';
    console.log(`  ${r.label.padEnd(22)}${km.toFixed(2).padStart(7)} km driven  Rs ${r.now.tollCost.toFixed(0).padStart(4)}  ${r.now.confidence.padEnd(13)}${run}`);
  }
  console.log(`  ${n} pair(s) use it`);
}

console.log(`\n--- A/B: cost of driving ${OLD_RUPEES_PER_HOUR} vs ${(3600 / OBJECTIVE.secondsPerRupee).toFixed(0)} rupees/hour, same graph ---`);
{
  const changed = rows.filter((r) => r.changed);
  const sum = (f: (p: Priced) => number, k: 'now' | 'then'): number => rows.reduce((a, r) => a + f(r[k]), 0);
  const tollKmNow = sum((p) => p.tollKm, 'now');
  const tollKmThen = sum((p) => p.tollKm, 'then');
  const distNow = sum((p) => p.distanceKm, 'now');
  const distThen = sum((p) => p.distanceKm, 'then');
  const costNow = sum((p) => p.tollCost, 'now');
  const costThen = sum((p) => p.tollCost, 'then');
  const driveNow = sum((p) => p.driveMin, 'now');
  const driveThen = sum((p) => p.driveMin, 'then');
  console.log(`  routes that changed:      ${changed.length} of ${rows.length}`);
  console.log(`  tolled km, all pairs:     ${tollKmThen.toFixed(1)} -> ${tollKmNow.toFixed(1)}  (${(((tollKmNow - tollKmThen) / Math.max(tollKmThen, 1e-9)) * 100).toFixed(1)}%)`);
  console.log(`  total distance:           ${distThen.toFixed(1)} -> ${distNow.toFixed(1)} km  (${(((distNow - distThen) / distThen) * 100).toFixed(2)}%)`);
  console.log(`  total drive time:         ${driveThen.toFixed(1)} -> ${driveNow.toFixed(1)} min  (${(((driveNow - driveThen) / driveThen) * 100).toFixed(2)}%)`);
  console.log(`  total billed tolls:       Rs ${costThen.toFixed(0)} -> Rs ${costNow.toFixed(0)}`);
  for (const r of changed) {
    console.log(
      `    ${r.label.padEnd(22)} ${r.then.distanceKm.toFixed(2).padStart(7)} -> ${r.now.distanceKm.toFixed(2).padStart(7)} km   ` +
        `tolled ${r.then.tollKm.toFixed(2).padStart(6)} -> ${r.now.tollKm.toFixed(2).padStart(6)} km   ` +
        `Rs ${r.then.tollCost.toFixed(0).padStart(4)} -> ${r.now.tollCost.toFixed(0).padStart(4)}`,
    );
  }
}

console.log('\nreport complete. No constant and no model was changed by this script.');
