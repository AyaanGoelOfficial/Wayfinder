/**
 * Why did we choose THIS road on ONE pair? `npm run diagnose:pair -- jewar gaur-city`.
 *
 * `diagnose:route` sorts all 56 pairs into causes. This does the opposite: one pair, every term of
 * the objective on both paths, so a single verdict can be argued rather than ranked.
 *
 * THE QUESTION IT ANSWERS is the one a percentage cannot: our route is longer AND slower than
 * OSRM's, so under our own objective SOMETHING has to be paying for it. The objective has exactly
 * four terms, and the report prints all four for both lines:
 *
 *     seconds = driveSeconds + distanceSeconds + tollSeconds + turnSeconds
 *
 * `distanceSeconds` is split further into the neutral rate and the quality surcharge, because they
 * are the same product in the engine and different preferences in the design. Neutral is
 * `km * secondsPerKm`, what a tertiary road costs. The surcharge is what the class weight adds or
 * removes on top, and it is the only term that can pay for a longer, slower route. Reported per
 * road class so "quality is carrying it" can be checked against WHICH roads rather than accepted
 * as a total.
 *
 * OUR OWN PATH IS PRICED TWICE, and that is the positive control `hard-rules.md` requires. Once by
 * the router, which is exact, and once by the estimator that has to be used on OSRM's line, which
 * only has geometry to work from. The difference is this instrument's error ON THIS PAIR, printed
 * beside every verdict. A margin smaller than that error is not a finding.
 *
 * TURNS ARE ESTIMATED ON BOTH LINES BY THE SAME METHOD for the same reason. The router's exact
 * turn total is known for our path and printed too, but the comparison uses the estimate on both
 * sides, because an exact figure against an estimated one measures the instrument rather than the
 * routes.
 *
 * NETWORK EGRESS: `scripts/` is the only place allowed it. One request per run.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BUILD_AREA, OBJECTIVE, SNAP_DESTINATION_M, TOLL_ROADS, TURN_COST } from '../config/city.ts';
import { ROUTING_FIXTURES } from '../config/fixtures/routing.ts';
import { Router } from '../packages/engine/dijkstra.ts';
import type { RouteResult } from '../packages/engine/dijkstra.ts';
import { parseGraphArtifact } from '../packages/engine/graphfile.ts';
import { SnapIndex } from '../packages/engine/snap.ts';
import { bearingDelta, manoeuvreSeconds } from '../packages/engine/turncost.ts';
import { CLASS_RANK } from '../packages/pipeline/graph/profile.ts';
import { haversineM } from '../packages/shared/geo.ts';

const DATA = resolve(import.meta.dirname, '../data');
const OSRM = 'https://router.project-osrm.org';
const KMH_TO_MS = 1 / 3.6;

/**
 * How close a road must be to count as carrying a point of a line. Same value and same reasoning as
 * `diagnose-divergence.ts`: both lines are built from the same OSM geometry, so agreement should be
 * metres, and 25 m is tight enough that a service road one carriageway away does not count.
 */
const COVERAGE_SNAP_M = 25;

/**
 * How far back and forward a bearing is measured across an edge change, in metres.
 *
 * A manoeuvre's angle read from two adjacent shape points is dominated by how finely the corner
 * happens to be mapped, which is a property of the survey and not of the turn. Averaging over a
 * fixed ground distance makes the angle a property of the road.
 */
const BEARING_WINDOW_M = 30;

const RANK_NAME = Object.entries(CLASS_RANK)
  .sort((a, b) => (a[1] as number) - (b[1] as number))
  .reduce<Map<number, string>>((m, [name, rank]) => {
    if (!m.has(rank as number)) m.set(rank as number, name);
    return m;
  }, new Map());

const artifact = parseGraphArtifact(await readFile(resolve(DATA, 'graph.bin')));
const g = artifact.graph;
const snap = new SnapIndex(g, BUILD_AREA);
const router = new Router(g, artifact.restrictions, TURN_COST, OBJECTIVE);

const searchRupeesPerKm = new Float64Array(256);
for (const r of TOLL_ROADS) searchRupeesPerKm[r.id] = r.searchRatePerKm;

function bearingDeg(a: readonly [number, number], b: readonly [number, number]): number {
  const dx = (b[0] - a[0]) * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dy = b[1] - a[1];
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

interface Terms {
  readonly driveS: number;
  readonly neutralS: number;
  readonly qualityS: number;
  readonly tollS: number;
  readonly turnS: number;
  readonly metres: number;
  readonly tollM: number;
  readonly uncoveredM: number;
  /** Metres per class rank, and the quality surcharge those metres carry. */
  readonly perClass: ReadonlyMap<number, { m: number; qualityS: number }>;
  readonly manoeuvres: number;
}

const total = (t: Terms): number => t.driveS + t.neutralS + t.qualityS + t.tollS + t.turnS;

/**
 * Prices any line under the full objective by snapping each segment to the road it runs along.
 *
 * Every per-metre rate here is read from the same constants the router precomputes from, so the
 * only difference between this and the exact answer is which edge a segment is attributed to. That
 * is what the self-error measurement below quantifies.
 */
function priceLine(coords: readonly (readonly [number, number])[]): Terms {
  const perKm = OBJECTIVE.secondsPerKm;
  const quality = OBJECTIVE.qualityByRank;
  const secPerRupee = OBJECTIVE.secondsPerRupee;
  let driveS = 0;
  let neutralS = 0;
  let qualityS = 0;
  let tollS = 0;
  let turnS = 0;
  let metres = 0;
  let tollM = 0;
  let uncoveredM = 0;
  let manoeuvres = 0;
  const perClass = new Map<number, { m: number; qualityS: number }>();

  // Segment index -> snapped edge, resolved once so the turn pass can walk the same attribution the
  // cost pass used rather than snapping a second time and disagreeing with itself.
  const edgeOf: (number | null)[] = [];
  const segLen: number[] = [];
  for (let i = 0; i + 1 < coords.length; i++) {
    const a = coords[i] as readonly [number, number];
    const b = coords[i + 1] as readonly [number, number];
    const segM = haversineM(a[1], a[0], b[1], b[0]);
    segLen.push(segM);
    if (segM === 0) {
      edgeOf.push(null);
      continue;
    }
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const s = snap.snap(mid, 'destination', COVERAGE_SNAP_M);
    edgeOf.push(s === null ? null : s.edgeId);
    metres += segM;
    if (s === null) {
      uncoveredM += segM;
      // Priced at the slowest class in the table rather than skipped, so a road we lack can never
      // make the other line look artificially cheap and turn a data gap into a router verdict.
      driveS += segM / (10 * KMH_TO_MS);
      neutralS += (segM / 1000) * perKm;
      qualityS += (segM / 1000) * perKm * (3.5 - 1);
      continue;
    }
    const e = s.edgeId;
    const rank = g.edgeClassRank[e] as number;
    const w = quality[rank] ?? 1;
    driveS += segM / ((g.edgeSpeedKmh[e] as number) * KMH_TO_MS);
    neutralS += (segM / 1000) * perKm;
    const qs = (segM / 1000) * perKm * (w - 1);
    qualityS += qs;
    const road = g.edgeTollRoad[e] as number;
    if (road !== 0) tollS += (segM / 1000) * (searchRupeesPerKm[road] as number) * secPerRupee;
    if (g.edgeToll[e] === 1) tollM += segM;
    const slot = perClass.get(rank) ?? { m: 0, qualityS: 0 };
    slot.m += segM;
    slot.qualityS += qs;
    perClass.set(rank, slot);
  }

  // Turns, at every point the attributed edge changes to a different SHAPE. A change of edge within
  // one shape is the same physical road, and charging it would invent a manoeuvre per carriageway
  // split. Bearings are averaged over a ground window rather than read off adjacent shape points.
  for (let i = 1; i < edgeOf.length; i++) {
    const prev = edgeOf[i - 1];
    const cur = edgeOf[i];
    if (prev === null || cur === null || prev === undefined || cur === undefined || prev === cur) continue;
    if ((g.edgeShape[prev] as number) === (g.edgeShape[cur] as number)) continue;
    let back = i;
    let backM = 0;
    while (back > 0 && backM < BEARING_WINDOW_M) {
      back--;
      backM += segLen[back] as number;
    }
    let fwd = i;
    let fwdM = 0;
    while (fwd + 1 < coords.length && fwdM < BEARING_WINDOW_M) {
      fwdM += segLen[fwd] as number;
      fwd++;
    }
    if (back === i || fwd === i) continue;
    const from = bearingDeg(coords[back] as readonly [number, number], coords[i] as readonly [number, number]);
    const to = bearingDeg(coords[i] as readonly [number, number], coords[fwd] as readonly [number, number]);
    const d = bearingDelta(from, to);
    const s = manoeuvreSeconds(d, g.edgeClassRank[prev] as number, g.edgeClassRank[cur] as number, TURN_COST);
    if (s > 0) manoeuvres++;
    turnS += s;
  }

  return { driveS, neutralS, qualityS, tollS, turnS, metres, tollM, uncoveredM, perClass, manoeuvres };
}

function fixture(id: string): { lat: number; lon: number } {
  const f = ROUTING_FIXTURES.find((x) => x.id === id);
  if (f === undefined) {
    throw new Error(`no routing fixture "${id}". Have: ${ROUTING_FIXTURES.map((x) => x.id).join(', ')}`);
  }
  return { lat: f.lat, lon: f.lon };
}

const [aId = 'jewar', bId = 'gaur-city'] = process.argv.slice(2);
const A = fixture(aId);
const B = fixture(bId);

const sa = snap.snap([A.lon, A.lat], 'destination', SNAP_DESTINATION_M);
const sb = snap.snap([B.lon, B.lat], 'destination', SNAP_DESTINATION_M);
if (sa === null || sb === null) throw new Error('an endpoint does not snap');

console.log(`=== ${aId} to ${bId}, every term of the objective ===`);
console.log(
  `  ${OBJECTIVE.secondsPerKm} s/km neutral, ${OBJECTIVE.secondsPerRupee.toFixed(3)} s/rupee, ` +
    `${(3600 / OBJECTIVE.secondsPerRupee).toFixed(0)} rupees/hour of driving`,
);

const ours = router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction);
const oursNoToll = router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction, { avoidTolls: true });
if (ours === null) throw new Error('our router found no route');

const url =
  `${OSRM}/route/v1/driving/${A.lon},${A.lat};${B.lon},${B.lat}` +
  '?overview=full&geometries=geojson&annotations=nodes&steps=true';
const res = await fetch(url, {
  headers: { 'user-agent': 'wayfinder-gn single-pair diagnosis (single developer, one request)' },
});
if (!res.ok) throw new Error(`OSRM ${res.status}`);
const body = (await res.json()) as {
  code?: string;
  routes?: {
    distance: number;
    duration: number;
    geometry: { coordinates: [number, number][] };
    legs: { steps?: { name?: string; ref?: string; maneuver?: { type?: string } }[] }[];
  }[];
};
if (body.code !== 'Ok' || body.routes === undefined || body.routes[0] === undefined) {
  throw new Error(`OSRM said ${body.code}`);
}
const osrm = body.routes[0];

const oursPriced = priceLine(ours.geometry);
const theirsPriced = priceLine(osrm.geometry.coordinates);

// --- the control, printed before any verdict rests on the instrument -----------------------------

const exactTotal = ours.seconds;
const estTotal = total(oursPriced);
const errS = estTotal - exactTotal;
console.log('\n--- CONTROL: our own path priced both ways -------------------------------------');
console.log('  term                 router (exact)      estimator      difference');
const row = (name: string, exact: number, est: number): void => {
  console.log(
    `  ${name.padEnd(20)} ${(exact / 60).toFixed(2).padStart(9)} min ${(est / 60).toFixed(2).padStart(13)} min ` +
      `${(((est - exact) / 60) as number).toFixed(2).padStart(11)} min`,
  );
};
const exactNeutral = (ours.metres / 1000) * OBJECTIVE.secondsPerKm;
row('drive', ours.driveSeconds, oursPriced.driveS);
row('distance, neutral', exactNeutral, oursPriced.neutralS);
row('distance, quality', ours.distanceSeconds - exactNeutral, oursPriced.qualityS);
row('toll', ours.tollSeconds, oursPriced.tollS);
row('turns', ours.turnSeconds, oursPriced.turnS);
row('TOTAL', exactTotal, estTotal);
console.log(
  `  length ${(ours.metres / 1000).toFixed(2)} km exact, ${(oursPriced.metres / 1000).toFixed(2)} km estimated`,
);
console.log(
  `  INSTRUMENT ERROR ON THIS PAIR: ${(errS / 60).toFixed(2)} min ` +
    `(${((Math.abs(errS) / exactTotal) * 100).toFixed(1)}% of our cost). No margin below this is a finding.`,
);

// --- the two paths, term by term ---------------------------------------------------------------

console.log('\n--- both paths under our objective, same estimator on both --------------------');
console.log('  term                     ours       OSRM        OSRM minus ours');
const cmp = (name: string, o: number, t: number): void => {
  console.log(
    `  ${name.padEnd(22)} ${(o / 60).toFixed(2).padStart(7)} min ${(t / 60).toFixed(2).padStart(8)} min ` +
      `${(((t - o) / 60) as number).toFixed(2).padStart(13)} min`,
  );
};
cmp('drive', oursPriced.driveS, theirsPriced.driveS);
cmp('distance, neutral', oursPriced.neutralS, theirsPriced.neutralS);
cmp('distance, quality', oursPriced.qualityS, theirsPriced.qualityS);
cmp('toll', oursPriced.tollS, theirsPriced.tollS);
cmp('turns', oursPriced.turnS, theirsPriced.turnS);
cmp('TOTAL', total(oursPriced), total(theirsPriced));
console.log(
  `  length      ${(oursPriced.metres / 1000).toFixed(2)} km ours, ${(theirsPriced.metres / 1000).toFixed(2)} km OSRM ` +
    `(OSRM reports ${(osrm.distance / 1000).toFixed(2)} km, ${(osrm.duration / 60).toFixed(1)} min)`,
);
console.log(
  `  tolled      ${(oursPriced.tollM / 1000).toFixed(2)} km ours, ${(theirsPriced.tollM / 1000).toFixed(2)} km OSRM`,
);
console.log(
  `  not in our graph  ${(oursPriced.uncoveredM / 1000).toFixed(2)} km ours, ` +
    `${(theirsPriced.uncoveredM / 1000).toFixed(2)} km OSRM  (CONTROL: covered ` +
    `${((1 - theirsPriced.uncoveredM / theirsPriced.metres) * 100).toFixed(1)}% of OSRM's line)`,
);
console.log(`  manoeuvres charged  ${oursPriced.manoeuvres} ours, ${theirsPriced.manoeuvres} OSRM`);

const margin = total(theirsPriced) - total(oursPriced);
console.log('\n--- VERDICT -------------------------------------------------------------------');
if (margin > Math.abs(errS)) {
  console.log(
    `  OUR PATH IS CHEAPER under our objective by ${(margin / 60).toFixed(2)} min, which beats the\n` +
      `  instrument error of ${(Math.abs(errS) / 60).toFixed(2)} min. The router did its job; the disagreement with\n` +
      '  OSRM is a difference of objective, not a search failure.',
  );
} else if (margin < -Math.abs(errS)) {
  console.log(
    `  OSRM'S PATH IS CHEAPER under our own objective by ${(-margin / 60).toFixed(2)} min, beyond the\n` +
      `  instrument error of ${(Math.abs(errS) / 60).toFixed(2)} min. Our search failed to find something it should\n` +
      '  have: a missing edge, a broken connection, or an over-applied restriction. THIS IS A DEFECT.',
  );
} else {
  console.log(
    `  TOO CLOSE TO CALL. The two paths differ by ${(margin / 60).toFixed(2)} min under our objective, inside the\n` +
      `  instrument error of ${(Math.abs(errS) / 60).toFixed(2)} min. Neither a defect nor a preference can be claimed.`,
  );
}

// --- which classes the quality term is spent on ------------------------------------------------

console.log('\n--- quality surcharge by road class, the only term that can pay for a longer, slower route ---');
console.log('  class          ours km   ours qual    OSRM km   OSRM qual     delta qual');
const ranks = new Set<number>([...oursPriced.perClass.keys(), ...theirsPriced.perClass.keys()]);
for (const rank of [...ranks].sort((a, b) => a - b)) {
  const o = oursPriced.perClass.get(rank) ?? { m: 0, qualityS: 0 };
  const t = theirsPriced.perClass.get(rank) ?? { m: 0, qualityS: 0 };
  console.log(
    `  ${(RANK_NAME.get(rank) ?? `rank ${rank}`).padEnd(14)}` +
      `${(o.m / 1000).toFixed(2).padStart(7)}${(o.qualityS / 60).toFixed(2).padStart(11)}` +
      `${(t.m / 1000).toFixed(2).padStart(11)}${(t.qualityS / 60).toFixed(2).padStart(11)}` +
      `${((t.qualityS - o.qualityS) / 60).toFixed(2).padStart(15)}`,
  );
}

// --- with the quality term switched off, which is what makes "quality carries it" checkable ------

{
  const flat = (t: Terms): number => t.driveS + t.neutralS + t.tollS + t.turnS;
  const withQ = total(theirsPriced) - total(oursPriced);
  const without = flat(theirsPriced) - flat(oursPriced);
  console.log('\n--- counterfactual: the same two paths with qualityByRank flat at 1.0 ----------');
  console.log(
    `  with quality      OSRM minus ours ${(withQ / 60).toFixed(2).padStart(7)} min  ` +
      `(${withQ > 0 ? 'we win' : 'OSRM wins'})`,
  );
  console.log(
    `  without quality   OSRM minus ours ${(without / 60).toFixed(2).padStart(7)} min  ` +
      `(${without > 0 ? 'we win' : 'OSRM wins'})`,
  );
  console.log(
    withQ > 0 !== without > 0
      ? '  THE QUALITY TERM IS DECISIVE on this pair: removing it flips the verdict.'
      : '  The quality term is not decisive here: the verdict holds without it.',
  );
}

// --- which named roads each path runs on -------------------------------------------------------

const NAMES = new Map<number, string>();
{
  // Way names are not in the graph artifact, so they come from the clip, the same source the graph
  // was built from. Read once and only for the ways these two paths actually touch.
  const { loadOrBuildClip } = await import('../packages/pipeline/clip/clip.ts');
  const { readLock } = await import('./fetch-extracts.ts');
  const lock = await readLock();
  const { clipped } = await loadOrBuildClip(
    lock.extracts.map((e) => ({ name: e.name, localPath: e.localPath, md5: e.md5 })),
    resolve(DATA, 'clipped.bin'),
    () => {},
  );
  for (const w of clipped.ways) {
    const n = w.tags.get('name') ?? w.tags.get('ref');
    if (n !== undefined && n !== '') NAMES.set(w.id, n);
  }
}

function namedRoads(coords: readonly (readonly [number, number])[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i + 1 < coords.length; i++) {
    const a = coords[i] as readonly [number, number];
    const b = coords[i + 1] as readonly [number, number];
    const segM = haversineM(a[1], a[0], b[1], b[0]);
    if (segM === 0) continue;
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const s = snap.snap(mid, 'destination', COVERAGE_SNAP_M);
    if (s === null) continue;
    const wayId = g.edgeWayId[s.edgeId] as number;
    const rank = g.edgeClassRank[s.edgeId] as number;
    const key = `${NAMES.get(wayId) ?? '(unnamed)'}  [${RANK_NAME.get(rank) ?? rank}]`;
    out.set(key, (out.get(key) ?? 0) + segM);
  }
  return out;
}

for (const [label, coords] of [
  ['ours', ours.geometry],
  ['OSRM', osrm.geometry.coordinates],
] as const) {
  const roads = [...namedRoads(coords)].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`\n--- ${label}: named roads by distance, top 8 ---`);
  for (const [name, m] of roads) console.log(`  ${(m / 1000).toFixed(2).padStart(6)} km  ${name}`);
}

// --- what the driver is actually billed --------------------------------------------------------

console.log('\n--- billed, from the router (exact, not the estimator) -------------------------');
const money = (r: RouteResult | null): string =>
  r === null
    ? 'no route'
    : `${(r.metres / 1000).toFixed(2)} km, drive ${(r.driveSeconds / 60).toFixed(1)} min, ` +
      `${(r.tollMetres / 1000).toFixed(2)} tolled km, ${r.tollCost.toFixed(2)} rupees, ` +
      `${r.tollConfidence}, display ${r.tollDisplay}`;
console.log(`  tolls allowed   ${money(ours)}`);
console.log(`  avoidTolls      ${money(oursNoToll)}`);
