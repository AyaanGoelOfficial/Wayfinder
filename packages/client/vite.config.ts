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
      proxy: Object.fromEntries(
        ['/tiles', '/style.json', '/health', '/route', '/snap', '/search'].map((p) => [
          p,
          { target: API_TARGET, changeOrigin: false },
        ]),
      ),
    },
    build: { outDir: 'dist', sourcemap: true },
  };
});
