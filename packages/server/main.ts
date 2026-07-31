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
import type { ApiError, LngLat, RouteResponse } from '../shared/index.ts';
import { SnapIndex } from '../engine/snap.ts';
import { Router } from '../engine/dijkstra.ts';
import { parseGraphArtifact } from '../engine/graphfile.ts';
import { BUILD_AREA, SNAP_DESTINATION_M } from '../../config/city.ts';

const DATA = resolve(import.meta.dirname, '../../data');
const PMTILES = resolve(DATA, 'wayfinder-gn.pmtiles');
const GRAPH_BIN = resolve(DATA, 'graph.bin');
const STYLE_JSON = resolve(DATA, 'style.json');
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
const router = new Router(artifact.graph, artifact.restrictions);
console.log(
  `graph: ${(graphStats['verticesAfterScc'] ?? 0).toLocaleString('en-US')} vertices, ` +
    `${(graphStats['edgesAfterScc'] ?? 0).toLocaleString('en-US')} edges, ` +
    `${(restrictionStats['enforcedByPair'] ?? 0) + (restrictionStats['enforcedBySequence'] ?? 0)} restrictions enforced, ` +
    `loaded in ${((performance.now() - tLoad) / 1000).toFixed(2)}s`,
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

  const tSnap = performance.now();
  const a = snapIndex.snap(from, 'destination', SNAP_DESTINATION_M);
  const b = snapIndex.snap(to, 'destination', SNAP_DESTINATION_M);
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
  const r = router.route(a!.edgeId, a!.fraction, b!.edgeId, b!.fraction);
  const routeMs = performance.now() - tRoute;
  if (r === null) {
    return reply.code(404).send({
      code: 'NO_ROUTE_FOUND',
      message: 'No legal driving route connects those two points. Try a different destination.',
    } satisfies ApiError);
  }

  const body: RouteResponse = {
    route: {
      id: ++routeId,
      cost: r.seconds,
      distanceM: r.metres,
      durationS: r.seconds,
      geometry: r.geometry,
      edgeIds: r.edges,
      // Turn-by-turn instructions are gate 7. Empty is honest; a fabricated list is not.
      instructions: [],
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

// Artifact check at boot, loud rather than at first request. A server that starts cleanly and
// then 503s every tile is much harder to diagnose than one that refuses to start.
try {
  const s = await stat(PMTILES);
  console.log(`artifacts: wayfinder-gn.pmtiles ${(s.size / 1024 / 1024).toFixed(1)} MB`);
} catch {
  console.error('MISSING ARTIFACT: data/wayfinder-gn.pmtiles');
  console.error('Run `npm run build-city` first. The server will start but every tile will 503.');
}

await app.listen({ port: PORT, host: HOST });
console.log(`wayfinder-gn server on http://localhost:${PORT}`);
console.log(`  ${ROUTES.health}   health and artifact status`);
console.log(`  /style.json  MapLibre style`);
console.log(`  /tiles/wayfinder-gn.pmtiles  archive, byte ranges honoured`);
