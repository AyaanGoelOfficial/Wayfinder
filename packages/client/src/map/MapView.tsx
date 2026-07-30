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
import { ROUTE_LAYERS } from './routeLayers.ts';
import 'maplibre-gl/dist/maplibre-gl.css';

type StyleSpec = Exclude<MapOptions['style'], string | undefined>;

export type MapStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly zoom: number; readonly center: readonly [number, number] }
  | { readonly kind: 'error'; readonly message: string };

/**
 * The route is its OWN channel, not a variant of `MapStatus`. Two bugs came from sharing one.
 *
 * The summary was a `MapStatus` variant, so `moveend`, which fires on the initial hash jump and on
 * every pan, overwrote the route distance and time with the zoom readout. Panning made the summary
 * vanish, and which one you saw depended on whether the route fetch resolved before the first
 * `moveend`, so a screenshot could show either and neither was reproducible.
 *
 * Route FAILURES went down the map's error path too, which put "The map could not load" above a
 * message about an out-of-area destination. The map had loaded fine. A remedy is only useful if it
 * names the thing that actually failed, so the two failures are now separate states.
 */
export type RouteState =
  | { readonly kind: 'route'; readonly km: number; readonly minutes: number; readonly points: number }
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

export function MapView({
  onStatus,
  onRoute,
}: {
  readonly onStatus: (s: MapStatus) => void;
  readonly onRoute: (r: RouteState) => void;
}): ReactElement {
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
      // DEV ONLY. Exposes the map for the browser gates, which need querySourceFeatures and
      // queryRenderedFeatures to tell "the tile has no feature" apart from "the layer did not
      // draw it". Those are indistinguishable from a screenshot, and guessing between them is
      // how a label bug gets "fixed" without a cause. Stripped from production builds.
      if (import.meta.env.DEV) {
        (window as unknown as { __map?: MapLibreMap }).__map = m;
      }

      /**
       * Draws a route when the URL carries ?from=lon,lat&to=lon,lat.
       *
       * Deliberately URL-driven for now: gate 3 needs a reproducible cross-city route to
       * screenshot, and a link is reproducible in a way "I clicked two places" is not. The
       * search-and-tap flow arrives with the UI that needs it.
       */
      const drawRoute = async (): Promise<void> => {
        const q = new URLSearchParams(window.location.search);
        const fromQ = q.get('from');
        const toQ = q.get('to');
        if (fromQ === null || toQ === null) return;
        const res = await fetch(`/route?from=${encodeURIComponent(fromQ)}&to=${encodeURIComponent(toQ)}`);
        if (!res.ok) {
          // The server's own message carries the remedy, per shared/'s structured error contract.
          // Reported on the ROUTE channel: the map is fine, the route is not.
          const err = (await res.json().catch(() => null)) as { message?: string } | null;
          onRoute({ kind: 'error', message: err?.message ?? `Route failed with status ${res.status}.` });
          return;
        }
        const body = (await res.json()) as {
          route: { geometry: [number, number][]; distanceM: number; durationS: number; id: number };
        };
        const line = {
          type: 'FeatureCollection' as const,
          features: [{ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: body.route.geometry } }],
        };
        if (m.getSource('route') === undefined) {
          m.addSource('route', { type: 'geojson', data: line });
          m.addLayer({ ...ROUTE_LAYERS.casing, source: 'route' } as never);
          m.addLayer({ ...ROUTE_LAYERS.line, source: 'route' } as never);
        } else {
          (m.getSource('route') as unknown as { setData: (d: unknown) => void }).setData(line);
        }
        onRoute({
          kind: 'route',
          km: body.route.distanceM / 1000,
          minutes: body.route.durationS / 60,
          points: body.route.geometry.length,
        });
      };

      m.on('load', () => {
        report();
        void drawRoute();
      });
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
  }, [onStatus, onRoute]);

  return <div className="map" ref={container} role="application" aria-label="Map of Greater Noida" />;
}
