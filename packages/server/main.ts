/**
 * The API and tile server. Fastify, memory-loads artifacts at boot, no network egress.
 *
 * Two routes here deliberately bypass the typed contract in `shared/`, and root CLAUDE.md names
 * both as the only permitted exceptions: the static `.pmtiles` path and the MapLibre style JSON.
 * Everything else must be declared in `shared/index.ts` first.
 *
 * RANGE REQUESTS ARE HAND-WRITTEN, not delegated to a static-file plugin. A PMTiles archive is
 * read by the client as a series of byte ranges, so a 200-with-whole-file response would make
 * MapLibre download the entire archive to draw one tile. The 206 is the mechanism, so it is
 * implemented explicitly and asserted at gate 2 rather than assumed from a plugin's defaults.
 *
 * `build-city` does NOT hot reload. Artifacts are read into memory at boot, so any rebuild
 * needs a full server restart.
 */
import Fastify from 'fastify';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROUTES } from '../shared/index.ts';
import type { ApiError, Approach, Fix, LngLat, MatchRequest, MatchResponse, Place, RouteResponse, SearchResponse } from '../shared/index.ts';
import { haversineM } from '../shared/geo.ts';
import { SnapIndex } from '../engine/snap.ts';
import { Router } from '../engine/dijkstra.ts';
import { parseGraphArtifact } from '../engine/graphfile.ts';
import { buildInstructions } from '../engine/instructions.ts';
import { matchFreeDrive } from '../engine/mapmatch.ts';
import { PlacesSearch } from '../engine/search.ts';
import { APPROACH_MIN_M, BUILD_AREA, OBJECTIVE, SNAP_DESTINATION_M, SNAP_TRACKING_M, TURN_COST } from '../../config/city.ts';

const DATA = resolve(import.meta.dirname, '../../data');
const PMTILES = resolve(DATA, 'wayfinder-gn.pmtiles');
const GRAPH_BIN = resolve(DATA, 'graph.bin');
const PLACES_JSON = resolve(DATA, 'places.json');
const STYLE_JSON = resolve(DATA, 'style.json');

/**
 * Hard cap on what one search request may return.
 *
 * The client asks for what it will draw. This exists so a hand-crafted `limit=100000` cannot make
 * the server sort and serialise the whole index per keystroke; `packages/server/CLAUDE.md` treats
 * every client parameter as untrusted, and a number is untrusted in exactly this way.
 */
const SEARCH_LIMIT_MAX = 25;
/** Newest fixes considered by /match. The HMM only needs enough history to judge a transition. */
const MATCH_WINDOW_FIXES = 12;
const PORT = Number(process.env['PORT'] ?? 8080);
const HOST = process.env['HOST'] ?? '0.0.0.0';

const app = Fastify({ logger: false });

// The map centre used to be derived here for the style. It moved to `build-city` along with the
// style itself, and is still derived from BUILD_AREA rather than hand-picked, per root CLAUDE.md.

function artifactsMissing(what: string, how: string): ApiError {
  return {
    code: 'ARTIFACTS_NOT_BUILT',
    // Governed by rules/copy.md: states a remedy, not just a fact, and carries no em dash.
    message: `The map data has not been built yet. Run ${how} and restart the server.`,
    detail: { missing: what },
  };
}

app.get(ROUTES.health, async () => {
  let pmtilesBytes = 0;
  try {
    pmtilesBytes = (await stat(PMTILES)).size;
  } catch {
    pmtilesBytes = 0;
  }
  return {
    ok: pmtilesBytes > 0,
    buildArea: BUILD_AREA,
    // Reported rather than hardcoded anywhere else. The search UI states the corpus size to the
    // user, and a figure typed into a component is wrong the next time the city is rebuilt.
    places: places.size,
    artifacts: { pmtilesBytes },
  };
});

app.get('/style.json', async (_req, reply) => {
  try {
    await stat(PMTILES);
  } catch {
    return reply.code(503).send(artifactsMissing('wayfinder-gn.pmtiles', 'npm run build-city'));
  }
  // SERVED AS AN ARTIFACT, not built here. The style is a derivative of the tile schema, which
  // the pipeline owns, and this package may not import `pipeline/`. `build-city` emits it from
  // the same run that emits the tiles, so the two cannot describe different schemas.
  //
  // The URLs inside it are same-origin relative on purpose: the client proxies /tiles to this
  // server, so the browser sees one origin and the 206 assertion at gate 2 is not confounded
  // by CORS.
  let style: string;
  try {
    style = await readFile(STYLE_JSON, 'utf8');
  } catch {
    return reply.code(503).send(artifactsMissing('style.json', 'npm run build-city'));
  }
  return reply.header('cache-control', 'no-store').type('application/json').send(style);
});

/**
 * SDF glyph ranges, generated offline by the pipeline from vendored Noto faces.
 *
 * The fontstack arrives percent-encoded ("Noto%20Sans%20Regular"); Fastify decodes it. The path
 * is rebuilt from the decoded parts rather than concatenated raw, and both parts are rejected if
 * they contain a separator, because this is the only route that takes a filename from the client.
 */
app.get<{ Params: { stack: string; range: string } }>('/fonts/:stack/:range.pbf', async (req, reply) => {
  const { stack, range } = req.params;
  if (/[\\/]|\.\./.test(stack) || !/^\d+-\d+$/.test(range)) {
    return reply.code(400).send({
      code: 'INVALID_PARAMETER',
      message: 'That font range is not valid. Reload the map to request it again.',
    } satisfies ApiError);
  }
  const file = resolve(DATA, 'fonts', stack, `${range}.pbf`);
  if (!file.startsWith(resolve(DATA, 'fonts'))) {
    return reply.code(400).send({
      code: 'INVALID_PARAMETER',
      message: 'That font range is not valid. Reload the map to request it again.',
    } satisfies ApiError);
  }
  try {
    const s = await stat(file);
    reply.header('content-type', 'application/x-protobuf');
    reply.header('content-length', String(s.size));
    reply.header('cache-control', 'public, max-age=86400');
    return reply.send(createReadStream(file));
  } catch {
    // A range with no glyphs is normal: MapLibre asks for every range a label might touch.
    // 404 is the correct answer and MapLibre treats it as "no glyphs here", not as an error.
    return reply.code(404).send();
  }
});

/**
 * Serves the archive with byte-range support. Only a single range is honoured: MapLibre's
 * PMTiles reader never asks for a multipart range, and answering one incorrectly is worse than
 * declining it, so an unsatisfiable or multi-range request gets a clear status rather than a
 * guess.
 */
app.get('/tiles/wayfinder-gn.pmtiles', async (req, reply) => {
  let size: number;
  try {
    size = (await stat(PMTILES)).size;
  } catch {
    return reply.code(503).send(artifactsMissing('wayfinder-gn.pmtiles', 'npm run build-city'));
  }

  reply.header('accept-ranges', 'bytes');
  reply.header('content-type', 'application/octet-stream');
  reply.header('cache-control', 'public, max-age=3600');

  const range = req.headers.range;
  if (range === undefined) {
    reply.header('content-length', String(size));
    return reply.send(createReadStream(PMTILES));
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) {
    return reply.code(416).header('content-range', `bytes */${size}`).send();
  }
  const rawStart = m[1] ?? '';
  const rawEnd = m[2] ?? '';

  let start: number;
  let end: number;
  if (rawStart === '') {
    // Suffix range: the last N bytes. PMTiles does not use it, but it is cheap to be correct.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return reply.code(416).header('content-range', `bytes */${size}`).send();
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return reply.code(416).header('content-range', `bytes */${size}`).send();
  }
  if (end >= size) end = size - 1;

  reply.code(206);
  reply.header('content-range', `bytes ${start}-${end}/${size}`);
  reply.header('content-length', String(end - start + 1));
  return reply.send(createReadStream(PMTILES, { start, end }));
});

// ---------------------------------------------------------------------------
// Routing. The graph is MEMORY-LOADED from an artifact, never rebuilt here.
//
// This file used to import `loadOrBuildClip`, `buildGraph` and `buildTurnTable` from `pipeline/`,
// which `packages/server/CLAUDE.md` forbids, and rebuilt the graph on every boot at a cost of
// 3.8 s. `build-city` now writes `data/graph.bin` and this reads it. The parser lives in
// `engine/` and is pure; the file read is here, because the server is the layer allowed to touch
// the filesystem.
// ---------------------------------------------------------------------------
console.log('loading graph...');
const tLoad = performance.now();
let artifact: ReturnType<typeof parseGraphArtifact>;
try {
  artifact = parseGraphArtifact(await readFile(GRAPH_BIN));
} catch (err) {
  // Loud and specific. A server that starts cleanly and then fails every /route is much harder
  // to diagnose than one that refuses to start and names the command that fixes it.
  console.error(`MISSING OR UNREADABLE ARTIFACT: ${GRAPH_BIN}`);
  console.error(err instanceof Error ? err.message : String(err));
  console.error('Run `npm run build-city` first.');
  process.exit(1);
}
const graphStats = artifact.stats.graph as Record<string, number>;
const restrictionStats = artifact.stats.restrictions as Record<string, number>;
const snapIndex = new SnapIndex(artifact.graph, BUILD_AREA);
const router = new Router(artifact.graph, artifact.restrictions, TURN_COST, OBJECTIVE);
console.log(
  `graph: ${(graphStats['verticesAfterScc'] ?? 0).toLocaleString('en-US')} vertices, ` +
    `${(graphStats['edgesAfterScc'] ?? 0).toLocaleString('en-US')} edges, ` +
    `${(restrictionStats['enforcedByPair'] ?? 0) + (restrictionStats['enforcedBySequence'] ?? 0)} restrictions enforced, ` +
    `loaded in ${((performance.now() - tLoad) / 1000).toFixed(2)}s`,
);

/**
 * The places index, memory-loaded at boot exactly like the graph.
 *
 * Loud on failure rather than degrading to an empty index: a search box that returns nothing looks
 * identical whether the data is missing or the query genuinely matched nothing, and only one of
 * those is the operator's problem.
 */
console.log('loading places...');
const tPlaces = performance.now();
let places: PlacesSearch;
try {
  const raw = JSON.parse(await readFile(PLACES_JSON, 'utf-8')) as { places?: Place[] } | Place[];
  const list = Array.isArray(raw) ? raw : (raw.places ?? []);
  if (list.length === 0) throw new Error('places index parsed but contains no entries');
  places = new PlacesSearch(list);
} catch (err) {
  console.error(`MISSING OR UNREADABLE ARTIFACT: ${PLACES_JSON}`);
  console.error(err instanceof Error ? err.message : String(err));
  console.error('Run `npm run build-city` first.');
  process.exit(1);
}
console.log(
  `places: ${places.size.toLocaleString('en-US')} entries, ` +
    `loaded in ${((performance.now() - tPlaces) / 1000).toFixed(2)}s`,
);

/** Monotonic per process. The client discards anything that is not the latest. Charter item 6. */
let routeId = 0;

function parsePoint(raw: string | undefined, name: string): LngLat | ApiError {
  if (typeof raw !== 'string') {
    return { code: 'INVALID_PARAMETER', message: `Add a ${name} point to the request, as lon,lat.` };
  }
  const parts = raw.split(',');
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  if (parts.length !== 2 || !Number.isFinite(lon) || !Number.isFinite(lat)) {
    return { code: 'INVALID_PARAMETER', message: `The ${name} point must be two numbers, lon,lat.` };
  }
  if (lat < BUILD_AREA.minLat || lat > BUILD_AREA.maxLat || lon < BUILD_AREA.minLon || lon > BUILD_AREA.maxLon) {
    return {
      code: 'OUTSIDE_BUILD_AREA',
      message: `That ${name} point is outside the mapped area. Pick somewhere in Gautam Buddha Nagar.`,
      detail: { lon, lat },
    };
  }
  return [lon, lat];
}

app.get<{ Querystring: { from?: string; to?: string } }>(ROUTES.route, async (req, reply) => {
  const t0 = performance.now();
  const from = parsePoint(req.query.from, 'start');
  if ('code' in from) return reply.code(from.code === 'OUTSIDE_BUILD_AREA' ? 422 : 400).send(from);
  const to = parsePoint(req.query.to, 'destination');
  if ('code' in to) return reply.code(to.code === 'OUTSIDE_BUILD_AREA' ? 422 : 400).send(to);

  /**
   * Snap to a PUBLIC road where one exists, and fall back to a private one only when none does.
   *
   * ⛔ THE PENALTY ALONE CANNOT DO THIS, and measuring it is what showed the gap. Sweeping
   * `privateSecondsPerKm` from 0 to 1800 leaves the Gautam Buddha University approach at 160 m at
   * every value, because the SNAP picks the nearest edge before the search ever runs, and that edge
   * is inside the campus. The search penalty stops private roads being used as a THROUGH route; the
   * snap decides whether the route ends inside a gate at all. Both are needed.
   *
   * THE FALLBACK IS NOT OPTIONAL. Measured over the whole places index: 1,428 of 7,650 places snap
   * to a private edge, and excluding private outright leaves FOUR with no legal edge within
   * `SNAP_DESTINATION_M`. Those must stay routable, which is what "routable, but only as a last
   * resort" has meant in `pipeline/graph/CLAUDE.md` since gate 1.
   *
   * The gap it opens is not hidden: it becomes the approach path, drawn dashed and stated in metres.
   */
  const snapPreferPublic = (p: LngLat): ReturnType<typeof snapIndex.snap> =>
    snapIndex.snap(p, 'destination', SNAP_DESTINATION_M, { excludePrivate: true }) ??
    snapIndex.snap(p, 'destination', SNAP_DESTINATION_M);

  const tSnap = performance.now();
  const a = snapPreferPublic(from);
  const b = snapPreferPublic(to);
  const snapMs = performance.now() - tSnap;
  for (const [s, name] of [[a, 'start'], [b, 'destination']] as const) {
    if (s === null) {
      return reply.code(404).send({
        code: 'POINT_TOO_FAR_FROM_ROAD',
        message: `That ${name} is more than ${SNAP_DESTINATION_M} m from any road. Move it closer to a road and try again.`,
        detail: { radiusM: SNAP_DESTINATION_M },
      } satisfies ApiError);
    }
  }

  const tRoute = performance.now();
  // BIDIRECTIONAL, and this is not a quality choice. `npm run gate:equality` proves all four rungs
  // return the identical PATH and cost on all 190 pairs, including every via-node and via-way
  // restriction site in the graph, so the rung decides only how much of the graph gets settled on
  // the way to the same answer.
  //
  // It is the only rung that meets the felt requirement. Measured at gate 5, urgent re-route p95:
  // dijkstra 85.72 ms, astar 69.07 ms, bidirectional 27.46 ms against a 30 ms budget. Paired on
  // identical queries it cuts 69.4% of settled states for 66.1% of the time.
  const r = router.route(a!.edgeId, a!.fraction, b!.edgeId, b!.fraction, { algorithm: 'bidirectional' });
  const routeMs = performance.now() - tRoute;
  if (r === null) {
    return reply.code(404).send({
      code: 'NO_ROUTE_FOUND',
      message: 'No legal driving route connects those two points. Try a different destination.',
    } satisfies ApiError);
  }

  /**
   * The walking gap between where the driving stops and where the user asked to go.
   *
   * Computed from the SNAPPED point the router actually used, never from the route geometry's own
   * endpoint: those differ by the trim fraction, and using the geometry would draw the line from a
   * point a metre or two off the road for no reason.
   */
  const approachOf = (asked: LngLat, snapped: { point: LngLat }): Approach | undefined => {
    const metres = haversineM(asked[1], asked[0], snapped.point[1], snapped.point[0]);
    if (metres < APPROACH_MIN_M) return undefined;
    return { from: snapped.point, to: asked, metres: Number(metres.toFixed(1)) };
  };
  const originApproach = approachOf(from, a!);
  const destinationApproach = approachOf(to, b!);

  const body: RouteResponse = {
    route: {
      id: ++routeId,
      cost: r.seconds,
      distanceM: r.metres,
      durationS: r.seconds,
      geometry: r.geometry,
      edgeIds: r.edges,
      // Cost, confidence and tolled distance travel together on purpose: a client that has the
      // amount without the confidence would show a rupee figure we cannot defend, which is exactly
      // the behaviour this model exists to avoid.
      tollCost: r.tollCost,
      tollConfidence: r.tollConfidence,
      // Copied, never recomputed. The engine priced the route and is the only thing that knows
      // which roads it touched, so deriving the display tier again here would be a second opinion.
      tollDisplay: r.tollDisplay,
      tollMetres: r.tollMetres,
      // Derived in the engine from the SAME edge sequence and geometry that are being returned, so
      // an instruction can never name a road the drawn line does not run along.
      instructions: buildInstructions({
        graph: artifact.graph,
        roadNames: artifact.roadNames,
        edges: r.edges,
        geometry: r.geometry,
      }),
      // ⛔ NOT added to distanceM, durationS or instructions. A driver cannot drive this, and an
      // ETA that included it would be wrong. `exactOptionalPropertyTypes` is on, so the key is
      // omitted entirely rather than set to undefined.
      ...(originApproach === undefined ? {} : { originApproach }),
      ...(destinationApproach === undefined ? {} : { destinationApproach }),
      profile: 'driving',
    },
    timingMs: {
      snap: Number(snapMs.toFixed(2)),
      route: Number(routeMs.toFixed(2)),
      total: Number((performance.now() - t0).toFixed(2)),
    },
  };
  return reply.header('cache-control', 'no-store').send(body);
});

/**
 * Search as you type. One request per keystroke, so the budget is the keystroke, not the page.
 *
 * `near` is optional and is the map centre, not a location fix. It only breaks ties: the ranking
 * rules live in `engine/search.ts`, and nothing here may re-rank, because a second opinion about
 * relevance is how the fixtures start passing in the gate and failing in the product.
 */
app.get<{ Querystring: { q?: string; near?: string; limit?: string; index?: string } }>(ROUTES.search, async (req, reply) => {
  const t0 = performance.now();
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  if (q.trim() === '') {
    // Not an error. An empty box is the resting state of a search field, and answering it with a
    // 400 would make the client special-case the most common state it is ever in.
    const empty: SearchResponse = { hits: [], timingMs: { search: 0, total: 0 } };
    return reply.header('cache-control', 'no-store').send(empty);
  }

  const rawLimit = Number(req.query.limit ?? 8);
  const limit = Number.isFinite(rawLimit) ? Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.trunc(rawLimit))) : 8;

  let near: LngLat | undefined;
  if (typeof req.query.near === 'string') {
    const parsed = parsePoint(req.query.near, 'map centre');
    // A bad `near` degrades to no bias rather than failing the search. The parameter is a hint;
    // refusing to search because a hint was malformed would be the wrong trade for the user.
    if (!('code' in parsed)) near = parsed;
  }

  // `index=off` runs the same ranking with no precomputation. It exists so the cost of the index
  // can be WATCHED rather than asserted, over the real corpus, and it is off by default.
  const indexed = req.query.index !== 'off';
  const opts = near === undefined ? { limit } : { limit, near };
  const tSearch = performance.now();
  const hits = indexed ? places.search(q, opts) : places.searchUnindexed(q, opts);
  const searchMs = performance.now() - tSearch;

  const body: SearchResponse = {
    hits,
    timingMs: {
      search: Number(searchMs.toFixed(2)),
      total: Number((performance.now() - t0).toFixed(2)),
    },
  };
  return reply.header('cache-control', 'no-store').send(body);
});

// Artifact check at boot, loud rather than at first request. A server that starts cleanly and
// then 503s every tile is much harder to diagnose than one that refuses to start.
try {
  const s = await stat(PMTILES);
  console.log(`artifacts: wayfinder-gn.pmtiles ${(s.size / 1024 / 1024).toFixed(1)} MB`);
} catch {
  console.error('MISSING ARTIFACT: data/wayfinder-gn.pmtiles');
  console.error('Run `npm run build-city` first. The server will start but every tile will 503.');
}

/**
 * Free-drive map matching. Which road is the vehicle on, with no active route?
 *
 * A POST, and the only one in this file, because the body is a WINDOW of fixes rather than a
 * point. The HMM needs consecutive observations to judge a transition, and a query string full of
 * serialised fixes would be a worse version of the same thing.
 *
 * THE CLIENT IS UNTRUSTED INPUT, so every field of every fix is validated before the engine is
 * touched, exactly as `parsePoint` does for /route. A fix array is a larger attack surface than a
 * pair of coordinates, so the window is capped as well as validated.
 */
app.post<{ Body: MatchRequest }>(ROUTES.match, async (req, reply) => {
  const t0 = performance.now();
  const body = req.body as MatchRequest | undefined;
  const raw = body?.fixes;
  if (!Array.isArray(raw) || raw.length === 0) {
    const err: ApiError = {
      code: 'INVALID_PARAMETER',
      message: 'Send at least one position fix to match, as a fixes array.',
    };
    return reply.code(400).send(err);
  }

  // Only the newest fixes matter, and an unbounded array is an unbounded amount of work.
  const window = raw.slice(-MATCH_WINDOW_FIXES);
  const fixes: Fix[] = [];
  for (const f of window) {
    const p = f?.point;
    if (!Array.isArray(p) || p.length !== 2) {
      const err: ApiError = {
        code: 'INVALID_PARAMETER',
        message: 'Every fix needs a point, as lon,lat.',
      };
      return reply.code(400).send(err);
    }
    const lon = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      const err: ApiError = {
        code: 'INVALID_PARAMETER',
        message: 'Every fix point must be two numbers, lon,lat.',
      };
      return reply.code(400).send(err);
    }
    if (lat < BUILD_AREA.minLat || lat > BUILD_AREA.maxLat || lon < BUILD_AREA.minLon || lon > BUILD_AREA.maxLon) {
      const err: ApiError = {
        code: 'OUTSIDE_BUILD_AREA',
        message: 'That position is outside the mapped area. Tracking works inside Gautam Buddha Nagar.',
        detail: { lon, lat },
      };
      return reply.code(422).send(err);
    }
    const accuracyM = Number(f?.accuracyM);
    const timestamp = Number(f?.timestamp);
    const headingRaw = f?.headingDeg;
    const speedRaw = f?.speedMps;
    fixes.push({
      point: [lon, lat],
      // A missing accuracy is treated as the worst accepted rather than as perfect. Defaulting an
      // absent uncertainty to zero would let a fix claim more precision than it stated.
      accuracyM: Number.isFinite(accuracyM) ? accuracyM : SNAP_TRACKING_M,
      headingDeg: typeof headingRaw === 'number' && Number.isFinite(headingRaw) ? headingRaw : null,
      speedMps: typeof speedRaw === 'number' && Number.isFinite(speedRaw) ? speedRaw : null,
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    });
  }

  const match = matchFreeDrive(artifact.graph, snapIndex, fixes, {
    nameOf: (id) => (id >= 0 ? artifact.roadNames[id] : undefined),
  });
  const response: MatchResponse = {
    // Null is a real answer: nothing survived the heading gate, so we decline to name a road
    // rather than assert one. Charter item 10.
    match,
    timingMs: { match: Number((performance.now() - t0).toFixed(2)) },
  };
  return response;
});

await app.listen({ port: PORT, host: HOST });
console.log(`wayfinder-gn server on http://localhost:${PORT}`);
console.log(`  ${ROUTES.health}   health and artifact status`);
console.log(`  ${ROUTES.route}    from=lon,lat to=lon,lat`);
console.log(`  ${ROUTES.search}   q=text, optional near=lon,lat and limit`);
console.log(`  ${ROUTES.match}    POST, body {fixes}, free-drive map matching`);
console.log(`  /style.json  MapLibre style`);
console.log(`  /tiles/wayfinder-gn.pmtiles  archive, byte ranges honoured`);
