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
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ROUTES } from '../shared/index.ts';
import type { ApiError } from '../shared/index.ts';
import { mapStyle } from '../pipeline/tiles/style.ts';
import { BUILD_AREA } from '../../config/city.ts';

const DATA = resolve(import.meta.dirname, '../../data');
const PMTILES = resolve(DATA, 'wayfinder-gn.pmtiles');
const PORT = Number(process.env['PORT'] ?? 8080);
const HOST = process.env['HOST'] ?? '0.0.0.0';

const app = Fastify({ logger: false });

/** Centre of the build area, derived. No hand-picked coordinates, per root CLAUDE.md. */
const CENTRE: readonly [number, number] = [
  (BUILD_AREA.minLon + BUILD_AREA.maxLon) / 2,
  (BUILD_AREA.minLat + BUILD_AREA.maxLat) / 2,
];

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
  // Same-origin relative path on purpose. The client proxies /tiles to this server, so the
  // browser sees one origin and the 206 assertion at gate 2 is not confounded by CORS.
  return reply.header('cache-control', 'no-store').send(
    mapStyle({ pmtilesUrl: '/tiles/wayfinder-gn.pmtiles', center: CENTRE, zoom: 11 }),
  );
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
