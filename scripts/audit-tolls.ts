/**
 * What do we actually charge a toll on, and is any of it wrong? `npm run audit:tolls`.
 *
 * INVESTIGATION ONLY. This script reads and reports; it changes no constant and no model. It
 * exists because the objective prices tolls at a uniform rate per kilometre, and that model is
 * known to be wrong on at least one road: the Yamuna Expressway is GATE CHARGED, a flat fee per
 * plaza crossed, not a rate per kilometre. Before any of that is remodelled, the road-level facts
 * have to be on the table, because `toll=yes` on 920 individual way segments says nothing about
 * which ROADS carry the charge or whether any of them charge nothing at all.
 *
 * THREE QUESTIONS, and the third has a positive control built in.
 *
 *   1. Every tolled way, grouped by name or ref, kilometres per group, sorted descending. Segments
 *      are noise; roads are the unit a toll is levied on.
 *   2. Is the Noida to Greater Noida Expressway tagged as tolled? It is free for cars in reality,
 *      so a `toll=yes` on it is a live defect: we would be steering drivers off a free road they
 *      use constantly. Reported with the validation pairs that traverse it.
 *   3. Toll booth and toll gantry NODES. A gate-charged road is modelled from its gates, so their
 *      presence or absence decides whether a per-crossing model is even expressible from this
 *      data. ZERO IS A FINDING, not a failure, and is reported as one.
 *
 * Tag semantics come from `tollOf` and `classifyWay` in the pipeline, imported rather than
 * reimplemented, so this audit cannot drift from what the graph builder actually did.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BUILD_AREA, SNAP_DESTINATION_M, OBJECTIVE, TURN_COST } from '../config/city.ts';
import { ROUTING_FIXTURES } from '../config/fixtures/routing.ts';
import { loadOrBuildClip, scaledToDeg } from '../packages/pipeline/clip/clip.ts';
import { classifyWay, tollOf } from '../packages/pipeline/graph/profile.ts';
import { haversineM } from '../packages/shared/geo.ts';
import { SnapIndex } from '../packages/engine/snap.ts';
import { Router } from '../packages/engine/dijkstra.ts';
import { parseGraphArtifact } from '../packages/engine/graphfile.ts';
import { readLock } from './fetch-extracts.ts';

const DATA = resolve(import.meta.dirname, '../data');
/** Same seed and count as `validate-osrm.ts`, so "the 56 pairs" means the same 56 pairs. */
const SEED = 20260731;
const RANDOM_PAIRS = 50;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lock = await readLock();
const { clipped } = await loadOrBuildClip(
  lock.extracts.map((e) => ({ name: e.name, localPath: e.localPath, md5: e.md5 })),
  resolve(DATA, 'clipped.bin'),
  () => {},
);

const lengthOf = (refs: readonly number[]): number => {
  let m = 0;
  for (let i = 0; i + 1 < refs.length; i++) {
    const ia = clipped.nodeIndex.get(refs[i] as number);
    const ib = clipped.nodeIndex.get(refs[i + 1] as number);
    if (ia < 0 || ib < 0) continue;
    m += haversineM(
      scaledToDeg(clipped.nodeLat[ia] as number),
      scaledToDeg(clipped.nodeLon[ia] as number),
      scaledToDeg(clipped.nodeLat[ib] as number),
      scaledToDeg(clipped.nodeLon[ib] as number),
    );
  }
  return m;
};

console.log('=== toll audit ===');
console.log(`  clip   ${clipped.ways.length.toLocaleString('en-US')} ways, ${clipped.nodeIds.length.toLocaleString('en-US')} nodes`);

// --- 1. tolled ways, grouped by road ------------------------------------------------------------

interface Group {
  name: string;
  ref: string;
  metres: number;
  ways: number;
  classes: Map<string, number>;
  ids: number[];
}
const groups = new Map<string, Group>();
let tolledWays = 0;
let tolledDrivable = 0;
let tolledMetres = 0;
/** Every distinct toll-ish key seen, so a re-clip that starts carrying a new spelling is visible. */
const tollKeys = new Map<string, number>();

for (const w of clipped.ways) {
  for (const k of w.tags.keys()) {
    if (k === 'toll' || k.startsWith('toll:')) tollKeys.set(`${k}=${w.tags.get(k) ?? ''}`, (tollKeys.get(`${k}=${w.tags.get(k) ?? ''}`) ?? 0) + 1);
  }
  if (!tollOf(w.tags)) continue;
  tolledWays++;
  const cls = classifyWay(w.tags);
  if (cls === null) continue;
  tolledDrivable++;
  const m = lengthOf(w.refs);
  tolledMetres += m;
  const name = w.tags.get('name') ?? '';
  const ref = w.tags.get('ref') ?? '';
  const key = name !== '' ? `name:${name}` : ref !== '' ? `ref:${ref}` : `unnamed:${w.tags.get('highway') ?? '?'}`;
  let g = groups.get(key);
  if (g === undefined) {
    g = { name, ref, metres: 0, ways: 0, classes: new Map(), ids: [] };
    groups.set(key, g);
  }
  g.metres += m;
  g.ways++;
  g.ids.push(w.id);
  const hw = w.tags.get('highway') ?? '?';
  g.classes.set(hw, (g.classes.get(hw) ?? 0) + 1);
}

console.log(`\n  toll-ish tags present in the clip, with counts:`);
for (const [k, n] of [...tollKeys].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(28)}${n.toLocaleString('en-US')} ways`);
console.log(
  `\n  ${tolledWays.toLocaleString('en-US')} ways carry a toll tag, ${tolledDrivable.toLocaleString('en-US')} of them drivable, ` +
    `${(tolledMetres / 1000).toFixed(1)} km total`,
);

console.log('\n  tolled roads, grouped by name or ref, by kilometres');
console.log(`    ${'km'.padStart(9)}${'ways'.padStart(7)}   ${'classes'.padEnd(22)}road`);
const sorted = [...groups.values()].sort((a, b) => b.metres - a.metres);
for (const g of sorted) {
  const label = g.name !== '' ? `${g.name}${g.ref !== '' ? ` (${g.ref})` : ''}` : g.ref !== '' ? g.ref : '(unnamed)';
  const cls = [...g.classes].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(' ');
  console.log(`    ${(g.metres / 1000).toFixed(2).padStart(9)}${String(g.ways).padStart(7)}   ${cls.padEnd(22)}${label}`);
}

// --- 2. the Noida to Greater Noida Expressway ---------------------------------------------------
//
// Named explicitly rather than pattern-guessed at, then checked. This road is toll FREE for cars,
// verified on the ground, so `toll=yes` here would mean we penalise a free road drivers use daily.

const NGN = /noida[\s-]*(?:to[\s-]*)?greater[\s-]*noida|greater[\s-]*noida[\s-]*(?:to[\s-]*)?noida/i;
interface Named { id: number; name: string; ref: string; hw: string; toll: string; metres: number }
const ngnWays: Named[] = [];
for (const w of clipped.ways) {
  const name = w.tags.get('name') ?? '';
  const ref = w.tags.get('ref') ?? '';
  if (!NGN.test(name) && !NGN.test(ref)) continue;
  ngnWays.push({
    id: w.id,
    name,
    ref,
    hw: w.tags.get('highway') ?? '?',
    toll: w.tags.get('toll') ?? '(absent)',
    metres: lengthOf(w.refs),
  });
}
console.log('\n=== Noida to Greater Noida Expressway ===');
if (ngnWays.length === 0) {
  console.log('  NOT FOUND by name or ref. The road may be tagged under a different name in this');
  console.log('  extract; treat this as unresolved rather than as "not tolled".');
} else {
  const km = ngnWays.reduce((a, b) => a + b.metres, 0) / 1000;
  const tolled = ngnWays.filter((w) => w.toll === 'yes');
  console.log(`  ${ngnWays.length} ways, ${km.toFixed(2)} km, ${tolled.length} tagged toll=yes`);
  const names = new Map<string, number>();
  for (const w of ngnWays) names.set(`${w.name} | ${w.ref} | ${w.hw} | toll=${w.toll}`, (names.get(`${w.name} | ${w.ref} | ${w.hw} | toll=${w.toll}`) ?? 0) + 1);
  for (const [k, n] of [...names].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)} ways   ${k}`);
}

// The validation pairs that traverse it, and the tolled kilometres each contributes. Routed with
// the shipped rung so the answer describes what we actually serve.
const artifact = parseGraphArtifact(await readFile(resolve(DATA, 'graph.bin')));
const g = artifact.graph;
const snap = new SnapIndex(g, BUILD_AREA);
const router = new Router(g, artifact.restrictions, TURN_COST, OBJECTIVE);
const ngnIds = new Set(ngnWays.map((w) => w.id));

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

console.log(`\n  validation pairs traversing it (${pairs.length} pairs, same seed as validate)`);
let hits = 0;
let ngnKmTotal = 0;
let tolledKmTotal = 0;
for (const p of pairs) {
  const sa = snap.snap(p.a, 'destination', SNAP_DESTINATION_M);
  const sb = snap.snap(p.b, 'destination', SNAP_DESTINATION_M);
  if (sa === null || sb === null) continue;
  const r = router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction, { algorithm: 'bidirectional' });
  if (r === null) continue;
  let ngnM = 0;
  for (const e of r.edges) if (ngnIds.has(g.edgeWayId[e] as number)) ngnM += g.edgeLengthM[e] as number;
  tolledKmTotal += r.tollMetres / 1000;
  if (ngnM <= 0) continue;
  hits++;
  ngnKmTotal += ngnM / 1000;
  console.log(
    `    ${p.label.padEnd(34)}${(ngnM / 1000).toFixed(2).padStart(8)} km on it` +
      `${(r.tollMetres / 1000).toFixed(2).padStart(10)} km tolled of ${(r.metres / 1000).toFixed(1)} km total`,
  );
}
console.log(`    ${hits} of ${pairs.length} pairs traverse it, ${ngnKmTotal.toFixed(2)} km total`);
console.log(`    tolled km across ALL pairs, for scale: ${tolledKmTotal.toFixed(1)} km`);

// --- 3. toll booths and gantries ----------------------------------------------------------------
//
// Reported even when the count is zero. A zero here is the finding that decides whether a
// gate-charged model can be built from this data at all, and a script that prints nothing when it
// finds nothing is indistinguishable from a script that did not run.

console.log('\n=== toll booth and gantry nodes ===');
interface Gate { id: number; lat: number; lon: number; kind: string; name: string }
const gates: Gate[] = [];
for (const [id, tags] of clipped.nodeTags) {
  const barrier = tags.get('barrier') ?? '';
  const hw = tags.get('highway') ?? '';
  if (barrier !== 'toll_booth' && hw !== 'toll_gantry') continue;
  const i = clipped.nodeIndex.get(id);
  if (i < 0) continue;
  const lat = scaledToDeg(clipped.nodeLat[i] as number);
  const lon = scaledToDeg(clipped.nodeLon[i] as number);
  if (lat < BUILD_AREA.minLat || lat > BUILD_AREA.maxLat || lon < BUILD_AREA.minLon || lon > BUILD_AREA.maxLon) continue;
  gates.push({ id, lat, lon, kind: barrier !== '' ? `barrier=${barrier}` : `highway=${hw}`, name: tags.get('name') ?? '' });
}
console.log(`  ${gates.length} node(s) inside BUILD_AREA` + (gates.length === 0 ? '. ZERO IS THE FINDING: see the report.' : ''));

if (gates.length > 0) {
  // Which road each sits on, by finding the ways that reference the node.
  const gateIds = new Set(gates.map((x) => x.id));
  const onWay = new Map<number, string[]>();
  for (const w of clipped.ways) {
    if (w.tags.get('highway') === undefined) continue;
    for (const ref of w.refs) {
      if (!gateIds.has(ref)) continue;
      const label = w.tags.get('name') ?? w.tags.get('ref') ?? `way ${w.id}`;
      const list = onWay.get(ref) ?? [];
      if (!list.includes(label)) list.push(label);
      onWay.set(ref, list);
    }
  }
  console.log(`    ${'node'.padEnd(12)}${'lat'.padStart(11)}${'lon'.padStart(11)}   ${'kind'.padEnd(20)}road`);
  for (const x of gates.sort((a, b) => a.lat - b.lat)) {
    const roads = (onWay.get(x.id) ?? ['(on no highway way)']).join(' / ');
    console.log(
      `    ${String(x.id).padEnd(12)}${x.lat.toFixed(6).padStart(11)}${x.lon.toFixed(6).padStart(11)}   ${x.kind.padEnd(20)}${roads}${x.name !== '' ? `  "${x.name}"` : ''}`,
    );
  }
}

console.log('\naudit complete. No constant and no model was changed by this script.');
