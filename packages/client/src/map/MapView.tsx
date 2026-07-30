/**
 * The map. MapLibre behind a thin adapter, reading our own PMTiles archive over byte ranges.
 *
 * The style is FETCHED from the server rather than built here. The style is a derivative of the
 * tile schema, and the tile schema is owned by the pipeline; duplicating it in the client is how
 * a renamed layer becomes a blank map that nothing reports as broken.
 *
 * maplibre-gl v6 has NO default export, only named ones. `import maplibregl from 'maplibre-gl'`
 * type-checks under some configs and is undefined at runtime, so the named form is used.
 */
import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { AttributionControl, Map as MapLibreMap, NavigationControl, addProtocol } from 'maplibre-gl';
import type { MapOptions } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';

type StyleSpec = Exclude<MapOptions['style'], string | undefined>;

export type MapStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly zoom: number; readonly center: readonly [number, number] }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Registered once per page, not per component. `addProtocol` mutates global MapLibre state, and
 * registering twice, which React strict mode's double effect invites, throws.
 */
let protocolRegistered = false;
function registerPmtiles(): void {
  if (protocolRegistered) return;
  addProtocol('pmtiles', new Protocol().tile);
  protocolRegistered = true;
}

/**
 * The server emits a root-relative archive path so the style stays origin agnostic. The PMTiles
 * protocol handler hands its URL to `fetch` after stripping the scheme, and a root-relative path
 * resolves against the document base, so it is made absolute here where the origin is known.
 */
function absolutizePmtiles(style: StyleSpec): StyleSpec {
  const sources = style.sources as Record<string, { url?: string }> | undefined;
  if (sources === undefined) return style;
  for (const src of Object.values(sources)) {
    const url = src.url;
    if (typeof url === 'string' && url.startsWith('pmtiles://')) {
      const rest = url.slice('pmtiles://'.length);
      if (rest.startsWith('/')) src.url = `pmtiles://${window.location.origin}${rest}`;
    }
  }
  return style;
}

export function MapView({ onStatus }: { readonly onStatus: (s: MapStatus) => void }): ReactElement {
  const container = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = container.current;
    if (el === null) return;
    registerPmtiles();

    let cancelled = false;
    let map: MapLibreMap | null = null;

    const start = async (): Promise<void> => {
      let style: StyleSpec;
      try {
        const res = await fetch('/style.json', { cache: 'no-store' });
        if (!res.ok) {
          // The server answers 503 with a remedy when artifacts are missing. Surface ITS message
          // rather than inventing one, so the user is told which command to run.
          const body = (await res.json().catch(() => null)) as { message?: string } | null;
          throw new Error(body?.message ?? `Style request failed with status ${res.status}.`);
        }
        style = absolutizePmtiles((await res.json()) as StyleSpec);
      } catch (err) {
        if (!cancelled) {
          onStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (cancelled) return;

      const m = new MapLibreMap({
        container: el,
        style,
        // Zooming past the deepest built zoom is fine: MapLibre overzooms, and z15 already
        // resolves finer than GPS ever does. Capping here would stop a driver zooming into a
        // junction, which is exactly when they need it most.
        maxZoom: 19,
        attributionControl: false,
        // The view lives in the URL hash (#zoom/lat/lon). A map app should restore where you
        // were, and it also makes a bug report or a verification screenshot reproducible by
        // link instead of by description.
        hash: true,
      });
      map = m;

      m.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');
      m.addControl(
        new AttributionControl({ compact: true, customAttribution: 'OpenStreetMap contributors' }),
        'bottom-left',
      );

      const report = (): void => {
        const c = m.getCenter();
        onStatus({ kind: 'ready', zoom: m.getZoom(), center: [c.lng, c.lat] });
      };
      m.on('load', report);
      m.on('moveend', report);
      m.on('error', (e) => {
        // MapLibre reports tile-level failures here. Silence would look like an empty region.
        onStatus({ kind: 'error', message: e.error?.message ?? 'Map failed to load a resource.' });
      });
    };

    void start();

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [onStatus]);

  return <div className="map" ref={container} role="application" aria-label="Map of Greater Noida" />;
}
