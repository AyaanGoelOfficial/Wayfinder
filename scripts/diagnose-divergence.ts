/**
 * Why does a pair diverge from OSRM? `npm run diagnose:route`.
 *
 * Gate 4 says WHICH pairs diverge. This says WHY, per pair, by cause rather than by size.
 * Ten worst cases sharing one root cause is one bug; ranking them by percentage makes it look
 * like ten, which is how a cost-model problem gets mistaken for a distribution of small ones.
 *
 * THE DECISIVE TEST is not "are the two lines different" but "does OUR router prefer OUR path
 * over OSRM's, under OUR cost model". Both are computed here:
 *
 *   - If OSRM's path costs MORE seconds in our model than our own path, the router did its job.
 *     We chose a longer road because our speed table says it is faster. The cause is the TABLE.
 *   - If OSRM's path costs FEWER seconds in our model, the router failed to find something it
 *     should have. The cause is a MISSING EDGE, a broken connection, or an over-applied
 *     restriction. That is a real bug and it is not fixable by tuning speeds.
 *
 * That single comparison separates the two candidate causes with no interpretation required.
 *
 * COVERAGE IS MEASURED TWICE, two independent ways, because each alone can lie:
 *
 *   1. BY OSM NODE ID. OSRM returns the node id sequence it drove through (`annotations=nodes`).
 *      Each id is looked up in our clip, then in our graph, so a road OSRM used can be sorted
 *      into: outside the build area, excluded by the car profile, dropped by SCC filtering, or
 *      present. This names the cause exactly, including the highway class and access tag.
 *   2. BY GEOMETRY. Every segment of OSRM's line is snapped to our graph. Segments with nothing
 *      within `COVERAGE_SNAP_M` are road we do not have, measured in metres.
 *
 * The two are computed from different inputs and must broadly agree. If they disagree, one of
 * them is broken and neither result can be used.
 *
 * POSITIVE CONTROL, per hard-rules.md: every "OSRM used a road we lack" claim ships beside the
 * count of roads we DID find on the same path, from the same lookup. A lookup that finds nothing
 * because it is broken and a path made entirely of roads we lack produce the same headline
 * number, and the control is the only thing that tells them apart.
 *
 * NETWORK EGRESS: `scripts/` is the only place allowed it. Throttled the same as `npm run
 * validate`, against the same free public server.
 */
import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BUILD_AREA, SNAP_DESTINATION_M, TURN_COST } from '../config/city.ts';
import { ROUTING_FIXTURES } from '../config/fixtures/routing.ts';
import { SnapIndex } from '../packages/engine/snap.ts';
import { Router } from '../packages/engine/dijkstra.ts';
import { parseGraphArtifact } from '../packages/engine/graphfile.ts';
import { loadOrBuildClip } from '../packages/pipeline/clip/clip.ts';
import type { ClippedWay } from '../packages/pipeline/clip/clip.ts';
import { classifyWay } from '../packages/pipeline/graph/profile.ts';
import { haversineM } from '../packages/shared/geo.ts';
import { readLock } from './fetch-extracts.ts';

const DATA = resolve(import.meta.dirname, '../data');
const OSRM = 'https://router.project-osrm.org';
const REQUEST_INTERVAL_MS = 1_100;

/** Same seed and same selection as `validate-osrm.ts`, so the labels here mean the same pairs. */
const SEED = 20260731;
const RANDOM_PAIRS = 50;

/**
 * How close a road must be to count as covering a point of OSRM's line.
 *
 * Not a snap radius in the `SNAP_TRACKING_M` sense and deliberately not that constant: this
 * measures whether the SAME PHYSICAL ROAD exists in our graph, and the two lines are built from
 * the same OSM geometry, so agreement should be metres. 25 m is loose enough to absorb a
 * different snapshot of the same road and tight enough that a parallel service road one
 * carriageway away does not count as covering the main road.
 */
const COVERAGE_SNAP_M = 25;

const KMH_TO_MS = 1 / 3.6;

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

interface OsrmDetail {
  readonly distance: number;
  readonly duration: number;
  readonly coords: readonly (readonly [number, number])[];
  readonly nodes: readonly number[];
  readonly steps: readonly string[];
}

async function osrmDetail(
  a: readonly [number, number],
  b: readonly [number, number],
): Promise<OsrmDetail | null> {
  const url =
    `${OSRM}/route/v1/driving/${a[0]},${a[1]};${b[0]},${b[1]}` +
    '?overview=full&geometries=geojson&annotations=nodes&steps=true';
  const res = await fetch(url, {
    headers: { 'user-agent': 'wayfinder-gn divergence diagnosis (single developer, throttled)' },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    code?: string;
    routes?: {
      distance: number;
      duration: number;
      geometry: { coordinates: [number, number][] };
      legs: { annotation?: { nodes?: number[] }; steps?: { name?: string; ref?: string }[] }[];
    }[];
  };
  if (body.code !== 'Ok' || body.routes === undefined || body.routes.length === 0) return null;
  const r = body.routes[0] as NonNullable<typeof body.routes>[number];
  const nodes: number[] = [];
  const steps: string[] = [];
  for (const leg of r.legs) {
    for (const n of leg.annotation?.nodes ?? []) nodes.push(n);
    for (const s of leg.steps ?? []) {
      const label = `${s.name ?? ''}${s.ref ? ` (${s.ref})` : ''}`.trim();
      if (label !== '' && steps[steps.length - 1] !== label) steps.push(label);
    }
  }
  return {
    distance: r.distance,
    duration: r.duration,
    coords: r.geometry.coordinates,
    nodes,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Load everything once.

const args = process.argv.slice(2);
const wantAll = args.includes('--all');
const filter = args.find((a) => !a.startsWith('--'));

console.log('=== divergence diagnosis ===');

const artifact = parseGraphArtifact(await readFile(resolve(DATA, 'graph.bin')));
const g = artifact.graph;
const snap = new SnapIndex(g, BUILD_AREA);
const router = new Router(g, artifact.restrictions, TURN_COST);
console.log(`  graph     ${g.edgeFrom.length.toLocaleString('en-US')} directed edges`);

const lock = await readLock();
const { clipped } = await loadOrBuildClip(
  lock.extracts.map((e) => ({ name: e.name, localPath: e.localPath, md5: e.md5 })),
  resolve(DATA, 'clipped.bin'),
  () => {},
);
console.log(
  `  clip      ${clipped.nodeIds.length.toLocaleString('en-US')} nodes, ${clipped.ways.length.toLocaleString('en-US')} ways`,
);

/** Way ids that survived into the routing graph. The SCC filter is the last thing that removes one. */
const graphWayIds = new Set<number>();
for (let e = 0; e < g.edgeWayId.length; e++) graphWayIds.add(g.edgeWayId[e] as number);
console.log(`  in graph  ${graphWayIds.size.toLocaleString('en-US')} distinct way ids`);

const wayById = new Map<number, ClippedWay>();
for (const w of clipped.ways) wayById.set(w.id, w);

// ---------------------------------------------------------------------------
// Pair selection, identical to validate-osrm.ts.

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

const selected = wantAll
  ? pairs
  : pairs.filter((p) => p.label.includes(filter ?? 'gautam-buddha-university to jewar'));
if (selected.length === 0) {
  console.error(`no pair matches "${filter}". Use --all, or a substring of a label in VALIDATION.md.`);
  process.exit(1);
}
console.log(`  pairs     ${selected.length} selected\n`);

// ---------------------------------------------------------------------------

type Cause =
  | 'present'
  | 'excluded-by-profile'
  | 'dropped-by-scc'
  | 'outside-build-area'
  | 'node-not-in-clip';

interface WayVerdict {
  readonly wayId: number;
  readonly cause: Cause;
  readonly highway: string;
  readonly name: string;
  readonly detail: string;
}

/**
 * Sorts every way OSRM drove through into one cause.
 *
 * The chain is checked in the order the pipeline applies it, so the FIRST thing that removed a
 * way is the thing reported. A way excluded by the car profile never reaches SCC filtering, and
 * calling that "dropped by SCC" would send the next reader to the wrong file.
 */
function verdictForWay(wayId: number): WayVerdict {
  const w = wayById.get(wayId);
  if (w === undefined) {
    return { wayId, cause: 'outside-build-area', highway: '', name: '', detail: 'not in the clip' };
  }
  const highway = w.tags.get('highway') ?? '';
  const name = w.tags.get('name') ?? w.tags.get('ref') ?? '';
  if (graphWayIds.has(wayId)) {
    return { wayId, cause: 'present', highway, name, detail: '' };
  }
  const cls = classifyWay(w.tags);
  if (!cls.drivable) {
    const access = ['motorcar', 'motor_vehicle', 'vehicle', 'access']
      .map((k) => (w.tags.get(k) === undefined ? '' : `${k}=${w.tags.get(k) as string}`))
      .filter((s) => s !== '')
      .join(' ');
    return {
      wayId,
      cause: 'excluded-by-profile',
      highway,
      name,
      detail: `highway=${highway === '' ? '(none)' : highway}${access === '' ? '' : ` ${access}`}`,
    };
  }
  return {
    wayId,
    cause: 'dropped-by-scc',
    highway,
    name,
    detail: `drivable at ${cls.speedKmh} km/h but absent from the graph`,
  };
}

/** The OSM highway class of the way an edge came from, or a marker when the tag is gone. */
function classOfEdge(edgeId: number): string {
  const w = wayById.get(g.edgeWayId[edgeId] as number);
  return w?.tags.get('highway') ?? '(unknown)';
}

function addClass(into: Map<string, number>, cls: string, metres: number): void {
  into.set(cls, (into.get(cls) ?? 0) + metres);
}

interface Priced {
  readonly seconds: number;
  readonly uncoveredM: number;
  readonly classes: ReadonlyMap<string, number>;
}

/**
 * Prices any line under OUR speed table by snapping each segment to the road it runs along.
 *
 * Used on BOTH routes on purpose. Run on OSRM's line it answers "what would this path cost us";
 * run on our OWN line, where the exact answer is already known from the router, the difference
 * is this method's measurement error, on that pair, in seconds. That self-error is what makes a
 * verdict of "OSRM found something cheaper" meaningful rather than a rounding artefact: the
 * margin has to beat the error of the instrument measuring it.
 */
function priceLine(coords: readonly (readonly [number, number])[]): Priced {
  let seconds = 0;
  let uncoveredM = 0;
  const classes = new Map<string, number>();
  for (let i = 0; i + 1 < coords.length; i++) {
    const a = coords[i] as readonly [number, number];
    const b = coords[i + 1] as readonly [number, number];
    const segM = haversineM(a[1], a[0], b[1], b[0]);
    if (segM === 0) continue;
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const s = snap.snap(mid, 'destination', COVERAGE_SNAP_M);
    if (s === null) {
      uncoveredM += segM;
      // Priced at the slowest class in the table rather than skipped, so an uncovered stretch can
      // never make a path look artificially CHEAP and turn a missing road into a router bug.
      seconds += segM / (10 * KMH_TO_MS);
      addClass(classes, '(not in our graph)', segM);
      continue;
    }
    seconds += segM / ((g.edgeSpeedKmh[s.edgeId] as number) * KMH_TO_MS);
    addClass(classes, classOfEdge(s.edgeId), segM);
  }
  return { seconds, uncoveredM, classes };
}

/** Metres per class, biggest first, as `motorway 28.1 km (64%)`. */
function classLine(classes: ReadonlyMap<string, number>): string {
  const total = [...classes.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return '(nothing)';
  return [...classes]
    .sort((x, y) => y[1] - x[1])
    .map(([cls, m]) => `${cls} ${(m / 1000).toFixed(1)} km (${Math.round((m / total) * 100)}%)`)
    .join(', ');
}

interface Diagnosis {
  readonly label: string;
  readonly kind: string;
  readonly a: [number, number];
  readonly b: [number, number];
  readonly oursM: number;
  readonly oursS: number;
  readonly osrmM: number;
  readonly osrmS: number;
  readonly distDelta: number;
  /** OSRM's own path, priced by OUR speed table. The decisive number. */
  readonly osrmPathOurSeconds: number;
  /** Metres of OSRM's line with no road of ours within COVERAGE_SNAP_M. */
  readonly uncoveredM: number;
  /** Our own line priced by the same method vs the router's exact answer. The instrument's error. */
  readonly methodErrorS: number;
  /** OSM nodes on OSRM's path that our clip does not contain at all. */
  readonly nodesNotInClip: number;
  readonly nodesTotal: number;
  /** Our own best route between OSRM's endpoints, so the two costs share a start and a finish. */
  readonly matchedSeconds: number;
  readonly wayCauses: Record<Cause, number>;
  readonly worstWays: readonly WayVerdict[];
  readonly rootCause: string;
  readonly steps: readonly string[];
  readonly ourClasses: ReadonlyMap<string, number>;
  readonly theirClasses: ReadonlyMap<string, number>;
  readonly ourRoads: readonly string[];
}

const results: Diagnosis[] = [];

for (const p of selected) {
  const sa = snap.snap(p.a, 'destination', SNAP_DESTINATION_M);
  const sb = snap.snap(p.b, 'destination', SNAP_DESTINATION_M);
  if (sa === null || sb === null) {
    console.log(`  ${p.label}: unsnappable, skipped`);
    continue;
  }
  const ours = router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction);
  if (ours === null) {
    console.log(`  ${p.label}: we found no route, skipped`);
    continue;
  }
  const theirs = await osrmDetail(p.a, p.b);
  await sleep(REQUEST_INTERVAL_MS);
  if (theirs === null) {
    console.log(`  ${p.label}: OSRM returned nothing, skipped`);
    continue;
  }

  // ---- Coverage measure 1: by OSM node id, through the clip and then the graph.
  //
  // A way counts as DRIVEN only when it contains two nodes that are ADJACENT in OSRM's node
  // sequence. Membership of a single node is not enough: every footway, driveway and field track
  // crossing the route shares a node with it, and counting those reported twelve "missing" ways
  // on a route where nothing at all was missing. Direction is not required, since a way's own
  // node order is independent of the direction of travel.
  const nodeIds = new Set(theirs.nodes);
  const followedBy = new Map<number, Set<number>>();
  for (let i = 0; i + 1 < theirs.nodes.length; i++) {
    const a = theirs.nodes[i] as number;
    const b = theirs.nodes[i + 1] as number;
    if (a === b) continue;
    const s = followedBy.get(a);
    if (s) s.add(b);
    else followedBy.set(a, new Set([b]));
  }
  const adjacent = (a: number, b: number): boolean =>
    followedBy.get(a)?.has(b) === true || followedBy.get(b)?.has(a) === true;

  const waysDriven = new Set<number>();
  for (const w of clipped.ways) {
    for (let i = 0; i + 1 < w.refs.length; i++) {
      if (adjacent(w.refs[i] as number, w.refs[i + 1] as number)) {
        waysDriven.add(w.id);
        break;
      }
    }
  }
  const verdicts = [...waysDriven].map(verdictForWay);
  const wayCauses: Record<Cause, number> = {
    present: 0,
    'excluded-by-profile': 0,
    'dropped-by-scc': 0,
    'outside-build-area': 0,
    'node-not-in-clip': 0,
  };
  for (const v of verdicts) wayCauses[v.cause]++;
  // A node id in NO clipped way at all means the clip does not have that piece of road.
  let nodesNotInClip = 0;
  for (const n of nodeIds) if (clipped.nodeIndex.get(n) < 0) nodesNotInClip++;
  wayCauses['node-not-in-clip'] = nodesNotInClip;

  // ---- Coverage measure 2: by geometry, and OSRM's path priced in our cost model.
  const theirPriced = priceLine(theirs.coords);
  const osrmPathOurSeconds = theirPriced.seconds;
  const uncoveredM = theirPriced.uncoveredM;
  const theirClasses = theirPriced.classes;

  // ---- The instrument's own error, measured on this very pair.
  //
  // Our own line priced by the same method, against the exact cost the router already computed.
  // The gap is what segment-midpoint snapping gets wrong here: a midpoint can land on a parallel
  // service road with a different speed, and the two routers snap the endpoints to different
  // places entirely. Without this, a 2% difference reads as "the router missed a better path"
  // when it is the ruler, not the road.
  // DRIVE TIME ON BOTH SIDES. `priceLine` prices a bare line from the speed table and has no way
  // to know what turns it makes, while `ours.seconds` now includes our turn penalties. Comparing
  // them directly reports the turn penalty as instrument error. Subtracting `turnSeconds` puts
  // both back on the same quantity.
  //
  // LIMITATION, stated rather than buried: this comparison is therefore blind to a divergence
  // caused purely by turn pricing. It can still clear the graph and the search on drive time,
  // which is what it is used for, but a ROUTER verdict here means "missed a cheaper path by drive
  // time", not "by total modelled cost".
  const oursDriveS = ours.seconds - ours.turnSeconds;
  const ourByMethod = priceLine(ours.geometry).seconds;
  const methodErrorS = Math.abs(ourByMethod - oursDriveS);

  // ---- The last confound: the two routers do not start at the same place.
  //
  // OSRM snaps the request coordinates to ITS graph, we snap to OURS, and the two landing points
  // differ by metres to hundreds of metres. Comparing our cost from our endpoints against OSRM's
  // line from its endpoints charges that difference to the router. So we route again between
  // OSRM's OWN endpoints: same two points, same graph, same cost model, and the only thing left
  // that can differ is the path chosen. Only THAT comparison can accuse the search of missing
  // something.
  const ta = theirs.coords[0] as readonly [number, number];
  const tb = theirs.coords[theirs.coords.length - 1] as readonly [number, number];
  const tsa = snap.snap([ta[0], ta[1]], 'destination', SNAP_DESTINATION_M);
  const tsb = snap.snap([tb[0], tb[1]], 'destination', SNAP_DESTINATION_M);
  let matchedSeconds = Number.NaN;
  if (tsa !== null && tsb !== null) {
    const m = router.route(tsa.edgeId, tsa.fraction, tsb.edgeId, tsb.fraction);
    if (m !== null) matchedSeconds = m.seconds - m.turnSeconds;
  }

  // ---- What each side actually drove on, by metres per highway class.
  //
  // The single most useful line in this report. A route that is longer because it took a
  // motorway is a speed-table decision; a route that is longer because it took residential
  // streets is something else entirely, and the percentage delta alone cannot tell them apart.
  const ourClasses = new Map<string, number>();
  const ourRoads: string[] = [];
  for (const e of ours.edges) {
    addClass(ourClasses, classOfEdge(e), g.edgeLengthM[e] as number);
    const w = wayById.get(g.edgeWayId[e] as number);
    const nm = w?.tags.get('name') ?? w?.tags.get('ref') ?? '';
    if (nm !== '' && ourRoads[ourRoads.length - 1] !== nm) ourRoads.push(nm);
  }

  const distDelta = (ours.metres - theirs.distance) / theirs.distance;

  // ---- The verdict.
  //
  // Checked in the order a cause would have to be RULED OUT, not in order of interest. A path
  // that leaves the build area was never ours to find, and calling that a cost-model difference
  // would put a sampling artefact in the same bucket as a speed-table bias.
  const missing =
    wayCauses['excluded-by-profile'] + wayCauses['dropped-by-scc'] + wayCauses['outside-build-area'];
  // Uncovered metres a way-based count can never see: a road outside BUILD_AREA has no clipped
  // way at all, so it shows up as zero missing ways while the geometry says kilometres are gone.
  // That contradiction is what this branch exists to resolve.
  // A ROUTER verdict must beat the instrument. Two times the measured self-error, floored at a
  // minute, so a pair where the method happens to be accurate cannot pass on a few seconds.
  const routerMargin = Math.max(60, methodErrorS * 2);
  // Coverage must be COMPLETE before the search can be blamed. A path we could not have taken is
  // not a path we failed to find, and the 10 km/h penalty on uncovered metres does not make it one.
  const coverageComplete = uncoveredM <= 200;

  let rootCause: string;
  if (!coverageComplete && nodesNotInClip > 0) {
    rootCause =
      `OUTSIDE AREA: ${(uncoveredM / 1000).toFixed(2)} km of OSRM's line has no road of ours, and ` +
      `${nodesNotInClip} of its ${nodeIds.size} nodes are not in our clip at all. OSRM has all of ` +
      'India and left BUILD_AREA; that path was never ours to find. Not a router defect.';
  } else if (!coverageComplete) {
    rootCause =
      `GRAPH: ${(uncoveredM / 1000).toFixed(2)} km of OSRM's line has no road of ours within ` +
      `${COVERAGE_SNAP_M} m, with every node present in the clip, so ${missing} way(s) were dropped ` +
      'between the clip and the graph rather than never collected.';
  } else if (Number.isNaN(matchedSeconds)) {
    rootCause = 'UNDECIDED: we could not route between OSRM\'s own endpoints, so no fair comparison exists.';
  } else if (osrmPathOurSeconds < matchedSeconds - routerMargin) {
    rootCause =
      `ROUTER: from OSRM's OWN endpoints, its path costs ${(osrmPathOurSeconds / 60).toFixed(1)} min ` +
      `in our model and our best is ${(matchedSeconds / 60).toFixed(1)} min (instrument error ` +
      `${(methodErrorS / 60).toFixed(2)} min), so the search missed a path that is in our graph.`;
  } else {
    rootCause =
      `COST MODEL: we have OSRM's roads, and from its own endpoints its path costs MORE in our ` +
      `model (${(osrmPathOurSeconds / 60).toFixed(1)} min against our ${(matchedSeconds / 60).toFixed(1)} min). ` +
      'We chose a different road because the speed table says it is faster.';
  }

  const worstWays = verdicts
    .filter((v) => v.cause !== 'present')
    .sort((x, y) => x.cause.localeCompare(y.cause))
    .slice(0, 15);

  results.push({
    label: p.label,
    kind: p.kind,
    a: p.a,
    b: p.b,
    oursM: ours.metres,
    oursS: ours.seconds,
    osrmM: theirs.distance,
    osrmS: theirs.duration,
    distDelta,
    osrmPathOurSeconds,
    uncoveredM,
    methodErrorS,
    nodesNotInClip,
    nodesTotal: nodeIds.size,
    matchedSeconds,
    wayCauses,
    worstWays,
    rootCause,
    steps: theirs.steps,
    ourClasses,
    theirClasses,
    ourRoads,
  });

  console.log(`--- ${p.label}  (${(distDelta * 100).toFixed(2)}% distance delta)`);
  console.log(
    `    ours  ${(ours.metres / 1000).toFixed(2)} km in ${(ours.seconds / 60).toFixed(1)} min` +
      `    osrm  ${(theirs.distance / 1000).toFixed(2)} km in ${(theirs.duration / 60).toFixed(1)} min`,
  );
  console.log(
    `    OSRM path priced by OUR table: ${(osrmPathOurSeconds / 60).toFixed(1)} min` +
      `   (ours: ${(ours.seconds / 60).toFixed(1)} min)`,
  );
  console.log(
    `    ways on OSRM path: ${wayCauses.present} present (CONTROL), ` +
      `${wayCauses['excluded-by-profile']} excluded by profile, ` +
      `${wayCauses['dropped-by-scc']} dropped by SCC, ` +
      `${wayCauses['outside-build-area']} outside build area`,
  );
  console.log(
    `    geometry not covered by any road of ours: ${(uncoveredM / 1000).toFixed(2)} km of ` +
      `${(theirs.distance / 1000).toFixed(2)} km` +
      `   nodes not in our clip: ${nodesNotInClip} of ${nodeIds.size}`,
  );
  console.log(
    `    method self-error on OUR line: ${(methodErrorS / 60).toFixed(2)} min ` +
      `(${(ourByMethod / 60).toFixed(1)} measured against ${(oursDriveS / 60).toFixed(1)} exact drive time)`,
  );
  console.log(
    `    our best from OSRM's OWN endpoints: ${Number.isNaN(matchedSeconds) ? 'no route' : `${(matchedSeconds / 60).toFixed(1)} min`}` +
      `   (OSRM's line priced by us: ${(osrmPathOurSeconds / 60).toFixed(1)} min)`,
  );
  console.log(`    our classes:  ${classLine(ourClasses)}`);
  console.log(`    osrm classes: ${classLine(theirClasses)}`);
  console.log(`    ${rootCause}`);
  if (worstWays.length > 0) {
    console.log('    absent ways:');
    for (const v of worstWays) {
      console.log(
        `      way ${v.wayId}  ${v.cause.padEnd(20)} ${v.detail}${v.name === '' ? '' : `  "${v.name}"`}`,
      );
    }
  }
  console.log(`    OSRM drove: ${theirs.steps.slice(0, 12).join(' > ')}`);
  console.log(`    we drove:   ${ourRoads.slice(0, 12).join(' > ')}`);
  console.log('');
}

if (results.length === 0) {
  console.error('nothing diagnosed.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Grouped summary. By cause, never by size.

const byCause = new Map<string, Diagnosis[]>();
for (const r of results) {
  const key = r.rootCause.split(':')[0] as string;
  const list = byCause.get(key);
  if (list) list.push(r);
  else byCause.set(key, [r]);
}
console.log('=== grouped by cause ===');
for (const [cause, list] of byCause) {
  console.log(`  ${cause.padEnd(12)} ${list.length} pair(s): ${list.map((r) => r.label).join(', ')}`);
}

if (wantAll) {
  const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
  const md = [
    '# Divergence diagnosis',
    '',
    'Generated by `npm run diagnose:route -- --all`. Companion to `VALIDATION.md`, which says',
    'WHICH pairs diverge. This says WHY, grouped by cause. Ten worst cases sharing one root cause',
    'is one bug, and ranking by percentage hides that.',
    '',
    '## How the cause is decided',
    '',
    "The test is not whether the two lines differ. It is whether OSRM's own path is cheaper or",
    'more expensive THAN OURS UNDER OUR OWN COST MODEL.',
    '',
    "- Cheaper in our model: our search failed to find a path it should have. A missing edge, a",
    '  broken connection, or an over-applied restriction. A real bug, not fixable by tuning speeds.',
    '- More expensive in our model: the router did its job and the speed table chose the road.',
    '  The cause is the table.',
    '',
    'The comparison is made BETWEEN THE SAME TWO POINTS. `Ours from their ends` is our own router',
    "run between OSRM's snapped endpoints, not ours. The two engines land a request on different",
    'points of different graphs, and charging that difference to the search invents router bugs',
    'that are really snapping. Only the matched-endpoint number can accuse the search.',
    '',
    'That comparison is only as good as the ruler, so the ruler is measured too. `Method error` is',
    "OUR OWN line priced by the same segment-snapping method against the exact cost the router",
    'computed. A `ROUTER` verdict requires OSRM to be cheaper by more than twice that error, with a',
    'floor of one minute. Without it a 2% difference reads as a missed path when it is the',
    'instrument: the two routers snap the endpoints to different places, so the two lines do not',
    'even start at the same point.',
    '',
    '`Nodes off clip` is the column that resolves an apparent contradiction. A road OUTSIDE',
    '`BUILD_AREA` has no clipped way at all, so a way-based count reports nothing missing while the',
    'geometry says kilometres are gone. Counting OSRM nodes absent from our clip catches exactly',
    'that case, which turns the near-edge sampling caveat in `VALIDATION.md` from a hypothesis into',
    'a measured cause.',
    '',
    'Coverage is measured twice from different inputs, by OSM node id through the clip and the',
    "graph, and geometrically by snapping OSRM's line. Both are reported so they can disagree",
    'visibly rather than silently.',
    '',
    `Every "we lack this road" count ships beside the count of roads we DID find on the same path`,
    '(the `present` column), because a broken lookup and a genuinely missing road produce the same',
    'headline number without it.',
    '',
    '## Causes',
    '',
    '| Cause | Pairs |',
    '|---|---|',
    ...[...byCause].map(([cause, list]) => `| ${cause} | ${list.length} |`),
    '',
    '## Per pair',
    '',
    '| Pair | Dist delta | Ours min | Ours from their ends | OSRM path, our table | Method error min | Present | SCC | Nodes off clip | Uncovered km | Cause |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.label} | ${pct(r.distDelta)} | ${(r.oursS / 60).toFixed(1)} | ` +
        `${Number.isNaN(r.matchedSeconds) ? 'no route' : (r.matchedSeconds / 60).toFixed(1)} | ` +
        `${(r.osrmPathOurSeconds / 60).toFixed(1)} | ${(r.methodErrorS / 60).toFixed(2)} | ${r.wayCauses.present} | ` +
        `${r.wayCauses['dropped-by-scc']} | ${r.nodesNotInClip} of ${r.nodesTotal} | ` +
        `${(r.uncoveredM / 1000).toFixed(2)} | ${r.rootCause.split(':')[0] as string} |`,
    ),
    '',
  ].join('\n');
  await writeFile(resolve(import.meta.dirname, '../DIVERGENCE.md'), `${md}\n`, 'utf8');
  console.log('\n  wrote DIVERGENCE.md');

  // Machine-readable, for `experiment:speeds`, which needs to know which pairs left BUILD_AREA in
  // order to report the distribution both with and without them. Regenerated here rather than
  // hand-maintained, so the two scripts can never disagree about a pair's cause.
  const causes: Record<string, string> = {};
  for (const r of results) causes[r.label] = r.rootCause.split(':')[0] as string;
  await writeFile(resolve(DATA, 'divergence-causes.json'), `${JSON.stringify(causes, null, 2)}\n`, 'utf8');
  console.log('  wrote data/divergence-causes.json');
}
