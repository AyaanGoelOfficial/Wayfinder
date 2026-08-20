/**
 * WHERE exactly does the Yamuna Expressway stop being tagged as tolled? `npm run audit:yamuna`.
 *
 * INVESTIGATION ONLY. Reads the clip and reports; changes no constant and no model.
 *
 * WHY THIS EXISTS AS A SCRIPT AND NOT A ONE-OFF. Gate 6 closed with an open question: 13.07 km of
 * the mainline carries no `toll` tag at all, in one contiguous northern stretch. Either that is a
 * genuinely free approach into Greater Noida or it is a tagging gap, and the difference is roughly
 * a factor of two in what we bill anyone driving north. Settling it needs someone who drives the
 * road, and a latitude is not something a person can stand at. This prints the node id, the
 * coordinates, the bounding box and the named roads meeting each end, so the boundary can be found
 * on a map, in OSM, or through a windscreen.
 *
 * ⛔ POSITIVE CONTROL, per `hard-rules.md`. Every "no toll tag here" claim is printed beside the
 * count of ways on the SAME road that DO carry one, from the same pass over the same data. A
 * predicate that is silently wrong and a road that is genuinely untagged produce the same headline
 * number, and the control is the only thing that separates them.
 *
 * ⛔ NOTHING HERE IS INFERRED FROM A NAME. The stretch is identified by tag state along the chained
 * carriageway, and the interchanges are identified by shared nodes with other drivable ways. Where
 * a junction's roads are unnamed, this prints "(unnamed)" rather than reaching for the nearest
 * village, which is the failure mode the EPE plaza work already had to unlearn.
 */
import { resolve } from 'node:path';
import { loadOrBuildClip, scaledToDeg } from '../packages/pipeline/clip/clip.ts';
import type { Clipped, ClippedWay } from '../packages/pipeline/clip/clip.ts';
import { classifyWay } from '../packages/pipeline/graph/profile.ts';
import { haversineM } from '../packages/shared/geo.ts';
import { readLock } from './fetch-extracts.ts';

const DATA = resolve(import.meta.dirname, '../data');

/** The road under investigation, matched on `name` or `ref`, case insensitive. */
const ROAD = /yamuna/i;

/**
 * How far from the boundary node a junction still counts as "the interchange at this end".
 *
 * Generous on purpose: an interchange is a structure hundreds of metres long, and its slip roads
 * meet the mainline at several nodes. The report prints the measured distance for every hit so a
 * reader can judge rather than trust the cutoff.
 */
const INTERCHANGE_SEARCH_M = 6_000;

const lock = await readLock();
const { clipped } = await loadOrBuildClip(
  lock.extracts.map((e) => ({ name: e.name, localPath: e.localPath, md5: e.md5 })),
  resolve(DATA, 'clipped.bin'),
  () => {},
);

const pos = new Map<number, readonly [number, number]>();
for (let i = 0; i < clipped.nodeIds.length; i++) {
  pos.set(clipped.nodeIds[i] as number, [
    scaledToDeg(clipped.nodeLon[i] as number),
    scaledToDeg(clipped.nodeLat[i] as number),
  ] as const);
}

const nameOf = (w: ClippedWay): string => w.tags.get('name') ?? w.tags.get('ref') ?? '';
const isRoad = (w: ClippedWay): boolean => ROAD.test(nameOf(w));

/** Mainline only. Slip roads are a different question and would blur the boundary. */
const mainline = clipped.ways.filter((w) => isRoad(w) && (w.tags.get('highway') ?? '') === 'motorway');
const tagged = mainline.filter((w) => w.tags.get('toll') === 'yes');
const untagged = mainline.filter((w) => w.tags.get('toll') !== 'yes');

function lengthM(w: ClippedWay): number {
  let m = 0;
  for (let i = 0; i + 1 < w.refs.length; i++) {
    const a = pos.get(w.refs[i] as number);
    const b = pos.get(w.refs[i + 1] as number);
    if (a === undefined || b === undefined) continue;
    m += haversineM(a[1], a[0], b[1], b[0]);
  }
  return m;
}

const km = (ws: readonly ClippedWay[]): number => ws.reduce((a, w) => a + lengthM(w), 0) / 2000;

console.log('=== Yamuna Expressway: where the toll tag stops ===');
console.log(`  mainline ways matching ${String(ROAD)} and highway=motorway: ${mainline.length}`);
console.log(
  `  toll=yes      ${tagged.length.toString().padStart(4)} ways   ${km(tagged).toFixed(2).padStart(7)} km  <- CONTROL: the predicate does find tagged ways`,
);
console.log(`  toll absent   ${untagged.length.toString().padStart(4)} ways   ${km(untagged).toFixed(2).padStart(7)} km`);
console.log('  (km halved, because a divided carriageway is mapped as two ways)');

// --- the boundary: nodes shared between a tagged way and an untagged one -------------------------

const nodesOf = (ws: readonly ClippedWay[]): Map<number, ClippedWay[]> => {
  const m = new Map<number, ClippedWay[]>();
  for (const w of ws) {
    for (const r of w.refs) {
      const list = m.get(r);
      if (list) list.push(w);
      else m.set(r, [w]);
    }
  }
  return m;
};

const taggedNodes = nodesOf(tagged);
const untaggedNodes = nodesOf(untagged);
const boundary = [...taggedNodes.keys()].filter((n) => untaggedNodes.has(n));

console.log(`\n--- the boundary itself: ${boundary.length} node(s) shared by a tagged and an untagged way ---`);
if (boundary.length === 0) {
  console.log('  NONE. The two groups do not touch, so this is not one contiguous stretch.');
}
for (const n of boundary.sort((a, b) => (pos.get(a)?.[1] ?? 0) - (pos.get(b)?.[1] ?? 0))) {
  const p = pos.get(n);
  if (p === undefined) continue;
  console.log(`  node ${n}`);
  console.log(`    lat, lon        ${p[1].toFixed(7)}, ${p[0].toFixed(7)}`);
  console.log(`    LngLat order    [${p[0].toFixed(7)}, ${p[1].toFixed(7)}]`);
  console.log(`    OSM             https://www.openstreetmap.org/node/${n}`);
  console.log(`    map             https://www.openstreetmap.org/?mlat=${p[1].toFixed(7)}&mlon=${p[0].toFixed(7)}#map=17/${p[1].toFixed(5)}/${p[0].toFixed(5)}`);
  const t = (taggedNodes.get(n) ?? []).map((w) => w.id);
  const u = (untaggedNodes.get(n) ?? []).map((w) => w.id);
  console.log(`    tagged way(s)   ${t.join(', ')}`);
  console.log(`    untagged way(s) ${u.join(', ')}`);
}

// --- the untagged stretch, as a box and as its two ends ------------------------------------------

function bbox(ws: readonly ClippedWay[]): { minLon: number; minLat: number; maxLon: number; maxLat: number } {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const w of ws) {
    for (const r of w.refs) {
      const p = pos.get(r);
      if (p === undefined) continue;
      if (p[0] < minLon) minLon = p[0];
      if (p[1] < minLat) minLat = p[1];
      if (p[0] > maxLon) maxLon = p[0];
      if (p[1] > maxLat) maxLat = p[1];
    }
  }
  return { minLon, minLat, maxLon, maxLat };
}

const box = bbox(untagged);
console.log('\n--- bounding box of the untagged stretch ---');
console.log(`  south west   ${box.minLat.toFixed(7)}, ${box.minLon.toFixed(7)}`);
console.log(`  north east   ${box.maxLat.toFixed(7)}, ${box.maxLon.toFixed(7)}`);
console.log(
  `  extent       ${haversineM(box.minLat, box.minLon, box.maxLat, box.minLon).toFixed(0)} m north to south, ` +
    `${haversineM(box.minLat, box.minLon, box.minLat, box.maxLon).toFixed(0)} m east to west`,
);
console.log(
  `  OSM bbox     https://www.openstreetmap.org/?bbox=${box.minLon.toFixed(5)},${box.minLat.toFixed(5)},${box.maxLon.toFixed(5)},${box.maxLat.toFixed(5)}`,
);

/** The extreme node of a way set in one direction, which is that end of the stretch. */
function endNode(ws: readonly ClippedWay[], north: boolean): { id: number; p: readonly [number, number] } | null {
  let best: { id: number; p: readonly [number, number] } | null = null;
  for (const w of ws) {
    for (const r of w.refs) {
      const p = pos.get(r);
      if (p === undefined) continue;
      if (best === null || (north ? p[1] > best.p[1] : p[1] < best.p[1])) best = { id: r, p };
    }
  }
  return best;
}

const southEnd = endNode(untagged, false);
const northEnd = endNode(untagged, true);

console.log('\n--- the two ends of the untagged stretch ---');
for (const [label, e] of [['south end', southEnd], ['north end', northEnd]] as const) {
  if (e === null) {
    console.log(`  ${label}: not found`);
    continue;
  }
  console.log(`  ${label}  node ${e.id}  ${e.p[1].toFixed(7)}, ${e.p[0].toFixed(7)}`);
  console.log(`             https://www.openstreetmap.org/node/${e.id}`);
}

// --- named roads meeting the expressway near each end -------------------------------------------

/**
 * Every drivable way that shares a node with the mainline, with the distance from a given point.
 *
 * Shared nodes rather than proximity: an overpass passing above the carriageway is metres away and
 * connects to nothing, and a radius search cannot tell it from a slip road.
 */
function junctionsNear(from: readonly [number, number]): { name: string; highway: string; distM: number; node: number }[] {
  const mainlineNodeSet = new Set<number>();
  for (const w of mainline) for (const r of w.refs) mainlineNodeSet.add(r);
  const out = new Map<string, { name: string; highway: string; distM: number; node: number }>();
  for (const w of clipped.ways) {
    if (mainline.includes(w)) continue;
    const cls = classifyWay(w.tags);
    if (!cls.forward && !cls.backward) continue;
    for (const r of w.refs) {
      if (!mainlineNodeSet.has(r)) continue;
      const p = pos.get(r);
      if (p === undefined) continue;
      const d = haversineM(from[1], from[0], p[1], p[0]);
      if (d > INTERCHANGE_SEARCH_M) continue;
      const label = nameOf(w) === '' ? '(unnamed)' : nameOf(w);
      const key = `${label}|${w.tags.get('highway') ?? ''}`;
      const prev = out.get(key);
      if (prev === undefined || d < prev.distM) {
        out.set(key, { name: label, highway: w.tags.get('highway') ?? '', distM: d, node: r });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.distM - b.distM);
}

for (const [label, e] of [['SOUTH end', southEnd], ['NORTH end', northEnd]] as const) {
  if (e === null) continue;
  console.log(`\n--- roads meeting the mainline within ${INTERCHANGE_SEARCH_M / 1000} km of the ${label} ---`);
  const hits = junctionsNear(e.p);
  if (hits.length === 0) {
    console.log('  none. The mainline shares no node with any other drivable way in that radius.');
  }
  for (const h of hits.slice(0, 12)) {
    const p = pos.get(h.node);
    console.log(
      `  ${(h.distM / 1000).toFixed(2).padStart(6)} km  ${h.name.padEnd(34)} ${h.highway.padEnd(15)} ` +
        `node ${h.node}  ${p ? `${p[1].toFixed(5)}, ${p[0].toFixed(5)}` : ''}`,
    );
  }
}

// --- toll infrastructure on this road, for orientation ------------------------------------------

console.log('\n--- toll booths and gantries on or beside the mainline ---');
{
  const mainlineNodeSet = new Set<number>();
  for (const w of mainline) for (const r of w.refs) mainlineNodeSet.add(r);
  let found = 0;
  for (const [nodeId, tags] of clipped.nodeTags) {
    if (tags.get('barrier') !== 'toll_booth' && tags.get('highway') !== 'toll_gantry') continue;
    const p = pos.get(nodeId);
    if (p === undefined) continue;
    const onMainline = mainlineNodeSet.has(nodeId);
    // Only report ones near this road, otherwise every booth in the district prints.
    let nearest = Infinity;
    for (const w of mainline) {
      for (const r of w.refs) {
        const q = pos.get(r);
        if (q === undefined) continue;
        const d = haversineM(p[1], p[0], q[1], q[0]);
        if (d < nearest) nearest = d;
        if (nearest < 50) break;
      }
      if (nearest < 50) break;
    }
    if (nearest > 2_000) continue;
    found++;
    console.log(
      `  ${p[1].toFixed(5)}, ${p[0].toFixed(5)}  node ${nodeId}  ` +
        `${onMainline ? 'ON the mainline' : `${nearest.toFixed(0)} m off it (ramp)`}`,
    );
  }
  // Zero is a finding, not a failure, and is reported as one.
  if (found === 0) console.log('  NONE within 2 km of the mainline.');
}
