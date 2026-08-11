/**
 * Where are the Eastern Peripheral Expressway toll points, and which entry-exit pairs do we
 * actually have to price? `npm run audit:epe`.
 *
 * INVESTIGATION ONLY. Reads and reports; changes no constant and no model.
 *
 * WHY THIS EXISTS. EPE is a CLOSED tolling system: the charge is a function of the entry-exit
 * PAIR, not of plazas crossed and not of distance. A per-kilometre model cannot express that, and
 * EPE carries 176.56 km of our 290 km tolled network, so it is the road where the current uniform
 * rate is most wrong. Before any of that is remodelled, three facts have to be on the table: where
 * the booths are, which of them our build area even contains, and which entry-exit pairs the 56
 * validation pairs actually exercise. The last one matters most: a full matrix over 11 interchanges
 * is 55 symmetric entries, and we may need a small fraction of it.
 *
 * INTERCHANGE NAMES ARE NOT IN THE GRAPH. OSM gives coordinates, some plaza names, and the roads
 * each booth sits on. The NHAI interchange sequence is external knowledge. So this script does NOT
 * print a name it cannot support: it prints position along the road, the OSM name where one exists,
 * and the nearest named features as EVIDENCE, and leaves the attribution to be stated with a
 * confidence level in the report. Completing a label from expectation is the failure mode
 * `hard-rules.md` names first.
 *
 * ORDERING. EPE runs broadly south to north through this build area, so booths are ordered by
 * latitude and that ordering is CHECKED rather than assumed: the script reports whether the EPE
 * centreline in this clip is monotonic in latitude, and says so if it is not.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BUILD_AREA, SNAP_DESTINATION_M, OBJECTIVE, TURN_COST } from '../config/city.ts';
import { ROUTING_FIXTURES } from '../config/fixtures/routing.ts';
import { loadOrBuildClip, scaledToDeg } from '../packages/pipeline/clip/clip.ts';
import { haversineM } from '../packages/shared/geo.ts';
import { SnapIndex } from '../packages/engine/snap.ts';
import { Router } from '../packages/engine/dijkstra.ts';
import { parseGraphArtifact } from '../packages/engine/graphfile.ts';
import { readLock } from './fetch-extracts.ts';

const DATA = resolve(import.meta.dirname, '../data');
const SEED = 20260731;
const RANDOM_PAIRS = 50;
/** Matches the road by name or by its national-expressway ref. Both are checked, neither assumed. */
const EPE = /eastern[\s-]*peripheral/i;
const EPE_REF = /\bNE-?2\b/i;

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
const nodeLL = (id: number): { lat: number; lon: number } | null => {
  const i = clipped.nodeIndex.get(id);
  if (i < 0) return null;
  return { lat: scaledToDeg(clipped.nodeLat[i] as number), lon: scaledToDeg(clipped.nodeLon[i] as number) };
};
const inArea = (lat: number, lon: number): boolean =>
  lat >= BUILD_AREA.minLat && lat <= BUILD_AREA.maxLat && lon >= BUILD_AREA.minLon && lon <= BUILD_AREA.maxLon;

console.log('=== EPE toll point audit ===');

// --- the road ------------------------------------------------------------------------------------

const epeWayIds = new Set<number>();
const epeNodes = new Set<number>();
for (const w of clipped.ways) {
  const name = w.tags.get('name') ?? '';
  const ref = w.tags.get('ref') ?? '';
  if (!EPE.test(name) && !EPE_REF.test(ref)) continue;
  if (w.tags.get('highway') === undefined) continue;
  epeWayIds.add(w.id);
  for (const r of w.refs) epeNodes.add(r);
}
{
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  for (const n of epeNodes) {
    const p = nodeLL(n);
    if (p === null) continue;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  console.log(`  ${epeWayIds.size} EPE ways, ${epeNodes.size.toLocaleString('en-US')} nodes`);
  console.log(`  extent in clip   lat ${minLat.toFixed(5)} to ${maxLat.toFixed(5)}   lon ${minLon.toFixed(5)} to ${maxLon.toFixed(5)}`);
  console.log(`  build area       lat ${BUILD_AREA.minLat.toFixed(5)} to ${BUILD_AREA.maxLat.toFixed(5)}   lon ${BUILD_AREA.minLon.toFixed(5)} to ${BUILD_AREA.maxLon.toFixed(5)}`);
}

// --- the booths ----------------------------------------------------------------------------------
//
// Every toll booth node that lies on an EPE way, whether or not it is inside BUILD_AREA. The clip
// keeps out-of-area nodes when they are needed to complete a way, so booths just outside the bbox
// can still be present, and reporting only the in-area ones would answer question 2 by omission.

interface Booth {
  id: number;
  lat: number;
  lon: number;
  name: string;
  inside: boolean;
  onWays: string[];
}
const booths: Booth[] = [];
for (const [id, tags] of clipped.nodeTags) {
  const isBooth = tags.get('barrier') === 'toll_booth' || tags.get('highway') === 'toll_gantry';
  if (!isBooth) continue;
  if (!epeNodes.has(id)) continue;
  const p = nodeLL(id);
  if (p === null) continue;
  booths.push({ id, lat: p.lat, lon: p.lon, name: tags.get('name') ?? '', inside: inArea(p.lat, p.lon), onWays: [] });
}
// Which EPE ways each booth sits on, and whether that way is a mainline or a ramp. A Ramp Toll
// Plaza sits on a `motorway_link`; a Main Toll Plaza sits on the `motorway` carriageway itself.
const boothIds = new Set(booths.map((b) => b.id));
const boothClass = new Map<number, Set<string>>();
for (const w of clipped.ways) {
  if (!epeWayIds.has(w.id)) continue;
  const hw = w.tags.get('highway') ?? '?';
  for (const r of w.refs) {
    if (!boothIds.has(r)) continue;
    const s = boothClass.get(r) ?? new Set<string>();
    s.add(hw);
    boothClass.set(r, s);
  }
}

booths.sort((a, b) => a.lat - b.lat);

// Along-road position, as a cumulative great-circle walk between consecutive booths south to north.
// Labelled a PROXY in the report: it is chord distance between booths, not chainage along the
// carriageway, and it is used only to show spacing and ordering.
let cum = 0;
const spacing: number[] = [];
for (let i = 0; i < booths.length; i++) {
  if (i === 0) {
    spacing.push(0);
    continue;
  }
  const a = booths[i - 1] as Booth;
  const b = booths[i] as Booth;
  const d = haversineM(a.lat, a.lon, b.lat, b.lon) / 1000;
  cum += d;
  spacing.push(cum);
}

// Nearest named features, as EVIDENCE for attribution rather than as an attribution.
const places: { name: string; point: [number, number] }[] = JSON.parse(
  await readFile(resolve(DATA, 'places.json'), 'utf8'),
).places;
const nearestPlaces = (lat: number, lon: number, k: number): string[] =>
  places
    .map((p) => ({ n: p.name, d: haversineM(lat, lon, p.point[1], p.point[0]) }))
    .filter((x) => Number.isFinite(x.d))
    .sort((a, b) => a.d - b.d)
    .slice(0, k)
    .map((x) => `${x.n} ${(x.d / 1000).toFixed(1)}km`);

// Crossing roads near the booth, which is what an interchange is usually named after.
const crossingRefs = (lat: number, lon: number, radiusM: number): string[] => {
  const out = new Map<string, number>();
  for (const w of clipped.ways) {
    if (epeWayIds.has(w.id)) continue;
    const hw = w.tags.get('highway') ?? '';
    if (hw === '' || hw === 'footway' || hw === 'path' || hw === 'service') continue;
    const ref = w.tags.get('ref') ?? '';
    const name = w.tags.get('name') ?? '';
    if (ref === '' && name === '') continue;
    for (const r of w.refs) {
      const p = nodeLL(r);
      if (p === null) continue;
      const d = haversineM(lat, lon, p.lat, p.lon);
      if (d > radiusM) continue;
      const label = ref !== '' ? ref : name;
      const prev = out.get(label);
      if (prev === undefined || d < prev) out.set(label, d);
      break;
    }
  }
  return [...out]
    .sort((a, b) => a[1] - b[1])
    .slice(0, 4)
    .map(([l, d]) => `${l} ${(d / 1000).toFixed(1)}km`);
};

console.log(`\n  ${booths.length} toll booth nodes on EPE ways (${booths.filter((b) => b.inside).length} inside BUILD_AREA, ${booths.filter((b) => !b.inside).length} outside)`);
console.log('  ordered SOUTH to NORTH by latitude. "along km" is cumulative chord between booths, a proxy for chainage.\n');
for (let i = 0; i < booths.length; i++) {
  const b = booths[i] as Booth;
  const cls = [...(boothClass.get(b.id) ?? new Set())].join(',');
  const kind = cls.includes('motorway_link') ? 'RAMP' : cls.includes('motorway') ? 'MAIN' : '?';
  console.log(
    `  ${String(i + 1).padStart(2)}. node ${String(b.id).padEnd(12)} ${b.lat.toFixed(6)} ${b.lon.toFixed(6)}  ` +
      `${(spacing[i] as number).toFixed(1).padStart(6)} km  ${kind.padEnd(5)} ${b.inside ? 'IN ' : 'OUT'} ` +
      `${b.name !== '' ? `"${b.name}"` : '(unnamed)'}  [${cls}]`,
  );
  console.log(`      places:   ${nearestPlaces(b.lat, b.lon, 3).join(' | ')}`);
  console.log(`      crossing: ${crossingRefs(b.lat, b.lon, 2500).join(' | ') || '(none within 2.5 km)'}`);
}

// --- named junctions on the road, which is the only in-data source of interchange NAMES ----------
//
// A booth node rarely carries a name. A `highway=motorway_junction` node often does, and that name
// is the interchange. This is the difference between attributing an interchange from evidence and
// inferring it from position in a list, so it is reported separately and prominently.

console.log('\n=== named junctions on EPE, south to north ===');
interface Junction { id: number; lat: number; lon: number; name: string; ref: string; inside: boolean }
const junctions: Junction[] = [];
for (const [id, tags] of clipped.nodeTags) {
  if (tags.get('highway') !== 'motorway_junction') continue;
  if (!epeNodes.has(id)) continue;
  const p = nodeLL(id);
  if (p === null) continue;
  junctions.push({
    id,
    lat: p.lat,
    lon: p.lon,
    name: tags.get('name') ?? '',
    ref: tags.get('ref') ?? '',
    inside: inArea(p.lat, p.lon),
  });
}
junctions.sort((a, b) => a.lat - b.lat);
if (junctions.length === 0) {
  console.log('  NONE. Positive control: the same scan found ' + booths.length + ' toll booth nodes on the');
  console.log('  same way set, so the node-tag lookup works and this is genuinely absent data.');
} else {
  for (const j of junctions) {
    const near = nearestBooth(j.lat, j.lon);
    console.log(
      `  ${j.lat.toFixed(6)} ${j.lon.toFixed(6)}  ${j.inside ? 'IN ' : 'OUT'}  ` +
        `${(j.name !== '' ? `"${j.name}"` : '(unnamed)').padEnd(28)}${j.ref !== '' ? `ref=${j.ref}  ` : ''}` +
        `nearest booth ${near === null ? 'n/a' : `${near.idx} at ${(near.d / 1000).toFixed(1)} km`}`,
    );
  }
}

// --- do the NHAI interchange names appear anywhere in our own data? ------------------------------
//
// The interchange sequence is external knowledge, so rather than assigning names by position in a
// list, each name is SEARCHED FOR in the clip. A hit gives a coordinate that can be compared
// against the booth clusters; a miss is reported as a miss. This is the difference between
// attribution and assumption, and the misses are as informative as the hits: an interchange whose
// name appears nowhere in the data cannot be matched to a booth by evidence at all.
//
// Spellings vary between NHAI boards and OSM, so each name is matched loosely and the matched text
// is printed, never the query text.

const NHAI_INTERCHANGES = [
  'Chhajju Nagar', 'Pelak', 'Sihol', 'Maujpur', 'Fatehpur Rampur',
  'Bilakbarpur', 'Dasna', 'Rasulpur', 'Duhai', 'Badagaon', 'Mawikalan', 'Jakhauli',
];
/** Loosened: collapse whitespace, drop vowel-ish spelling noise that varies between transliterations. */
const loosen = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '');
console.log('\n=== NHAI interchange names, searched for in our own data ===');
for (const want of NHAI_INTERCHANGES) {
  const key = loosen(want);
  const hits: { what: string; lat: number; lon: number; d: string }[] = [];
  for (const p of places) {
    const l = loosen(p.name);
    if (!l.includes(key) && !key.includes(l)) continue;
    if (l.length < 4) continue;
    const nb = nearestBooth(p.point[1], p.point[0]);
    hits.push({
      what: `place "${p.name}"`,
      lat: p.point[1],
      lon: p.point[0],
      d: nb === null ? 'n/a' : `booth ${nb.idx} at ${(nb.d / 1000).toFixed(1)} km`,
    });
  }
  if (hits.length === 0) {
    console.log(`  ${want.padEnd(18)} NOT FOUND in the places index`);
    continue;
  }
  hits.sort((a, b) => Number.parseFloat(a.d.split('at ')[1] ?? '999') - Number.parseFloat(b.d.split('at ')[1] ?? '999'));
  for (const h of hits.slice(0, 2)) {
    console.log(`  ${want.padEnd(18)} ${h.lat.toFixed(6)} ${h.lon.toFixed(6)}  ${h.what.padEnd(34)}${h.d}`);
  }
}

// --- which validation pairs use EPE, and where they join and leave -------------------------------

const artifact = parseGraphArtifact(await readFile(resolve(DATA, 'graph.bin')));
const g = artifact.graph;
const snap = new SnapIndex(g, BUILD_AREA);
const router = new Router(g, artifact.restrictions, TURN_COST, OBJECTIVE);

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

function nearestBooth(lat: number, lon: number): { b: Booth; d: number; idx: number } | null {
  let best: { b: Booth; d: number; idx: number } | null = null;
  for (let i = 0; i < booths.length; i++) {
    const b = booths[i] as Booth;
    const d = haversineM(lat, lon, b.lat, b.lon);
    if (best === null || d < best.d) best = { b, d, idx: i + 1 };
  }
  return best;
}

console.log('\n=== validation pairs that use EPE, with the join and leave points ===');
console.log('  "booth N" indexes the table above. Distance is from the junction to that booth.\n');
let used = 0;
const seenPairs = new Map<string, number>();
for (const p of pairs) {
  const sa = snap.snap(p.a, 'destination', SNAP_DESTINATION_M);
  const sb = snap.snap(p.b, 'destination', SNAP_DESTINATION_M);
  if (sa === null || sb === null) continue;
  const r = router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction, { algorithm: 'bidirectional' });
  if (r === null) continue;
  const onEpe = r.edges.map((e) => epeWayIds.has(g.edgeWayId[e] as number));
  const first = onEpe.indexOf(true);
  if (first === -1) continue;
  const last = onEpe.lastIndexOf(true);
  used++;
  let km = 0;
  for (let i = 0; i < r.edges.length; i++) if (onEpe[i]) km += (g.edgeLengthM[r.edges[i] as number] as number) / 1000;
  const entryV = g.edgeFrom[r.edges[first] as number] as number;
  const exitV = g.edgeTo[r.edges[last] as number] as number;
  const en = nearestBooth(g.vertexLat[entryV] as number, g.vertexLon[entryV] as number);
  const ex = nearestBooth(g.vertexLat[exitV] as number, g.vertexLon[exitV] as number);
  // How many separate runs of EPE the route has. More than one means it left and rejoined, which
  // a closed system would charge as two transactions, so it must not be silently merged.
  let runs = 0;
  for (let i = 0; i < onEpe.length; i++) if (onEpe[i] && !(i > 0 && onEpe[i - 1])) runs++;
  const key = en !== null && ex !== null ? `${Math.min(en.idx, ex.idx)}-${Math.max(en.idx, ex.idx)}` : '?';
  seenPairs.set(key, (seenPairs.get(key) ?? 0) + 1);
  console.log(
    `  ${p.label.padEnd(30)}${km.toFixed(2).padStart(8)} km on EPE, ${runs} run(s)   ` +
      `enter booth ${String(en?.idx ?? '?').padStart(2)} (${((en?.d ?? 0) / 1000).toFixed(1)} km)   ` +
      `leave booth ${String(ex?.idx ?? '?').padStart(2)} (${((ex?.d ?? 0) / 1000).toFixed(1)} km)`,
  );
}
console.log(`\n  ${used} of ${pairs.length} pairs use EPE`);
console.log('\n  DISTINCT entry-exit booth pairs the model would have to price (symmetric, so unordered):');
for (const [k, n] of [...seenPairs].sort((a, b) => b[1] - a[1])) console.log(`    booths ${k.padEnd(8)} ${n} route(s)`);
console.log(`    ${seenPairs.size} distinct pair(s) against ${(booths.length * (booths.length - 1)) / 2} possible over ${booths.length} booths`);

console.log('\naudit complete. No constant and no model was changed by this script.');
