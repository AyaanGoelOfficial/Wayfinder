/**
 * Client dev server.
 *
 * Everything the API and tiles live behind is PROXIED to the Fastify server on 8080, so the
 * browser sees a single origin. That is not cosmetic: the gate 2 assertion is that PMTiles is
 * fetched with HTTP 206 byte ranges, and a cross-origin setup turns that into a CORS question
 * instead of a range question. One origin keeps the measurement about the thing being measured.
 *
 * HTTPS is opt-in via `HTTPS=1`. Real GPS in a phone browser requires a secure context, so
 * phone verification needs it, but a self-signed certificate is friction for headless Chrome
 * runs that do not need geolocation at all.
 */
import { defineConfig } from 'vite';
import type { PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const API_TARGET = process.env['API_TARGET'] ?? 'http://localhost:8080';
const useHttps = process.env['HTTPS'] === '1';

export default defineConfig(async () => {
  const plugins: PluginOption[] = [react()];
  if (useHttps) {
    const { default: mkcert } = await import('vite-plugin-mkcert');
    plugins.push(mkcert());
  }
  return {
    plugins,
    /*
     * EXACTLY TWO ALIASES, and the omissions are the point. `packages/CLAUDE.md` allows the client
     * to import `config/` and `shared/` and nothing else; `engine/` and `pipeline/` are deliberately
     * absent so an accidental import fails at build time rather than shipping hundreds of megabytes
     * of typed arrays, or a native binary call, into a browser bundle.
     */
    resolve: {
      alias: [
        { find: /^@config\//, replacement: `${fileURLToPath(new URL('../../config/', import.meta.url))}` },
        {
          find: /^@wayfinder\/shared$/,
          replacement: fileURLToPath(new URL('../shared/index.ts', import.meta.url)),
        },
        { find: /^@wayfinder\/shared\//, replacement: `${fileURLToPath(new URL('../shared/', import.meta.url))}` },
      ],
    },
    // maplibre-gl spawns its worker with `new Worker(new URL(...), {type:'module'})`. Vite's
    // dependency pre-bundling rewrites that URL to a path it never emits, so the worker 404s,
    // and a MapLibre map with no worker silently renders nothing while reporting no error and
    // making zero tile requests. Excluding it from optimisation leaves the URL intact.
    optimizeDeps: { exclude: ['maplibre-gl'] },
    server: {
      port: 5173,
      // Bound to all interfaces only when HTTPS is on, which is the phone-testing case. A plain
      // HTTP dev server should not be reachable from the LAN by default.
      host: useHttps ? true : 'localhost',
      // EVERY server path must be listed. An unlisted path falls through to Vite's SPA
      // fallback and returns index.html with a 200, so the client receives HTML where it
      // expected binary. That is how the glyph ranges silently failed: MapLibre reported
      // "Unimplemented type: 4" from parsing "<!doctype html>" as protobuf, then fell back to
      // local font rendering, which looks almost right and is not our glyphs at all.
      proxy: Object.fromEntries(
        ['/tiles', '/fonts', '/style.json', '/health', '/route', '/snap', '/search', '/match'].map((p) => [
          p,
          { target: API_TARGET, changeOrigin: false },
        ]),
      ),
    },
    build: { outDir: 'dist', sourcemap: true },
  };
});
