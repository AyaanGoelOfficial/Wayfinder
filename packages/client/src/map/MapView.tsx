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
import { TRACKING_LAYERS, chevronImage } from './trackingLayers.ts';
import { onTrackingFrame, useStore } from '../store.ts';
import { CAMERA } from '@config/city.ts';
import { haversineM } from '@wayfinder/shared/geo.ts';

import 'maplibre-gl/dist/maplibre-gl.css';

/**
 * How far the dot may travel before the covered line is redrawn, in metres.
 *
 * Bounds the gap between the end of the grey line and the vehicle. 3 m is about 4 px at zoom 17
 * in this city, under the threshold at which a line end reads as detached, and it costs about
 * five source updates a second at cruising speed rather than sixty.
 */
const COVERED_RESOLUTION_M = 3;

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
    /** Store subscriptions, torn down with the map. A leaked one repaints a removed map. */
    const unsubscribers: (() => void)[] = [];

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
        // Fed to the store so search ranking can bias toward what is on screen. A hint only: the
        // ranking rules are the engine's, and nothing here re-ranks.
        useStore.getState().setCentre([c.lng, c.lat]);
      };
      // DEV ONLY. Exposes the map for the browser gates, which need querySourceFeatures and
      // queryRenderedFeatures to tell "the tile has no feature" apart from "the layer did not
      // draw it". Those are indistinguishable from a screenshot, and guessing between them is
      // how a label bug gets "fixed" without a cause. Stripped from production builds.
      if (import.meta.env.DEV) {
        (window as unknown as { __map?: MapLibreMap }).__map = m;
      }

      /**
       * Draws whatever route the store currently holds, and clears the line when it holds none.
       *
       * Subscribed rather than polled, and keyed on `route.id`, which is the monotonic id the
       * server stamps for exactly this purpose. Redrawing the same line on every unrelated store
       * change would refit the camera while the user is panning.
       */
      let drawnId = -1;
      const paint = (): void => {
        const r = useStore.getState().route;
        const src = m.getSource('route') as unknown as { setData: (d: unknown) => void } | undefined;
        const appSrc = m.getSource('approach') as unknown as { setData: (d: unknown) => void } | undefined;
        const empty = { type: 'FeatureCollection' as const, features: [] };
        if (r === null) {
          drawnId = -1;
          if (src !== undefined) src.setData(empty);
          if (appSrc !== undefined) appSrc.setData(empty);
          return;
        }
        if (r.id === drawnId) return;
        drawnId = r.id;
        const line = {
          type: 'FeatureCollection' as const,
          features: [
            {
              type: 'Feature' as const,
              properties: {},
              geometry: { type: 'LineString' as const, coordinates: r.geometry as [number, number][] },
            },
          ],
        };
        // The approach segments, drawn from their own source so the dashed style cannot be applied
        // to the driven line by accident. Straight two-point lines: we have no pedestrian routing.
        const approaches = [r.originApproach, r.destinationApproach]
          .filter((x): x is NonNullable<typeof x> => x !== null)
          .map((ap) => ({
            type: 'Feature' as const,
            properties: {},
            geometry: {
              type: 'LineString' as const,
              coordinates: [ap.from as [number, number], ap.to as [number, number]],
            },
          }));
        const approachData = { type: 'FeatureCollection' as const, features: approaches };

        if (src === undefined) {
          m.addSource('route', { type: 'geojson', data: line });
          // BENEATH THE TRACKING STACK. The route line is 9 px wide at z15 and the dot is 8, so a
          // route added on top hides the dot completely. It did: the first navigation screenshot
          // had a working camera, a working banner, and no visible vehicle anywhere on screen.
          m.addLayer({ ...ROUTE_LAYERS.casing, source: 'route' } as never, routeAnchor());
          m.addLayer({ ...ROUTE_LAYERS.line, source: 'route' } as never, routeAnchor());
        } else {
          src.setData(line);
        }
        if (appSrc === undefined) {
          m.addSource('approach', { type: 'geojson', data: approachData });
          m.addLayer({ ...ROUTE_LAYERS.approach, source: 'approach' } as never, routeAnchor());
        } else {
          appSrc.setData(approachData);
        }
        let minLon = Infinity;
        let minLat = Infinity;
        let maxLon = -Infinity;
        let maxLat = -Infinity;
        const fitPoints: [number, number][] = [...(r.geometry as [number, number][])];
        for (const ap of [r.originApproach, r.destinationApproach]) {
          // The true destination is what the user asked for, so it must be on screen even though
          // nothing is driven to it.
          if (ap !== null) fitPoints.push(ap.to as [number, number]);
        }
        for (const [lon, lat] of fitPoints) {
          if (lon < minLon) minLon = lon;
          if (lat < minLat) minLat = lat;
          if (lon > maxLon) maxLon = lon;
          if (lat > maxLat) maxLat = lat;
        }
        if (Number.isFinite(minLon)) {
          // Padded generously on the left, where the search and route panel sit, so the line is
          // never fitted underneath the chrome that describes it.
          m.fitBounds(
            [
              [minLon, minLat],
              [maxLon, maxLat],
            ],
            { padding: { top: 60, bottom: 60, left: 380, right: 60 }, duration: 600 },
          );
        }
      };
      const unsubscribe = useStore.subscribe(paint);
      unsubscribers.push(unsubscribe);

      /**
       * The tracking layers, and the frame loop that drives them.
       *
       * WRITTEN STRAIGHT INTO MAPLIBRE, never through React. The dot moves every frame and the
       * banner does not, so they travel on different channels: `onTrackingFrame` here, and the
       * store's coarse slice for anything a person reads. A `setState` per frame would re-render
       * the search field sixty times a second to say what it already said.
       */
      const empty = { type: 'FeatureCollection' as const, features: [] };

      /**
       * The id everything non-tracking is inserted BEFORE, so the vehicle is always on top.
       *
       * Returns undefined until the tracking stack exists, which is what `addLayer` wants when
       * there is nothing to insert before. Passing a `beforeId` naming a layer that does not
       * exist makes MapLibre drop the layer and report it on the ERROR CHANNEL rather than
       * throwing, so the caller sees success and the layer is simply missing. That is exactly how
       * `route-covered` went absent while its source sat there looking healthy.
       */
      const belowTracking = (): string | undefined =>
        m.getLayer(TRACKING_LAYERS.accuracy.id) === undefined ? undefined : TRACKING_LAYERS.accuracy.id;

      /**
       * Where the driven route line goes: below the GREY COVERED line as well as below the dot.
       *
       * The full stack, bottom to top, and every position is load bearing:
       *
       *   route-casing, route-line, route-approach   the route as planned
       *   route-covered                              the part already driven, grey, over the blue
       *   tracking-accuracy .. tracking-heading      the vehicle, over everything
       *
       * Anchoring the route at `belowTracking()` alone would place it ABOVE `route-covered`, and
       * the grey progress line would then be painted over by the blue one it is meant to cover.
       */
      const routeAnchor = (): string | undefined =>
        m.getLayer(TRACKING_LAYERS.covered.id) !== undefined ? TRACKING_LAYERS.covered.id : belowTracking();

      const addTrackingLayers = (): void => {
        if (!m.hasImage('tracking-chevron')) m.addImage('tracking-chevron', chevronImage());
        if (m.getSource('tracking') === undefined) {
          m.addSource('tracking', { type: 'geojson', data: empty });
          m.addLayer({ ...TRACKING_LAYERS.accuracy, source: 'tracking' } as never);
          m.addLayer({ ...TRACKING_LAYERS.dotCasing, source: 'tracking' } as never);
          m.addLayer({ ...TRACKING_LAYERS.dot, source: 'tracking' } as never);
          m.addLayer({ ...TRACKING_LAYERS.heading, source: 'tracking' } as never);
        }
        if (m.getSource('route-covered') === undefined) {
          m.addSource('route-covered', { type: 'geojson', data: empty });
          // Beneath the tracking stack, above the route line, so the driven part greys out under
          // a dot that stays visible.
          m.addLayer({ ...TRACKING_LAYERS.covered, source: 'route-covered' } as never, belowTracking());
        }
      };

      /**
       * Follow mode is dropped by a USER gesture only.
       *
       * MapLibre fires the same `dragstart` for a programmatic `jumpTo` as for a finger, and the
       * discriminator is `originalEvent`: present for a real input, absent for our own camera
       * write. Without that check the chase camera cancels itself on its first frame.
       */
      const breakFollow = (e: { originalEvent?: unknown }): void => {
        if (e.originalEvent === undefined) return;
        if (useStore.getState().tracking.following) useStore.getState().setFollowing(false);
      };
      m.on('dragstart', breakFollow);
      m.on('rotatestart', breakFollow);
      m.on('pitchstart', breakFollow);

      // Camera state, eased here rather than in the engine: bearing and zoom are presentation,
      // and the engine has no opinion about how a map is framed.
      // Annotated, because `CAMERA` is `as const` and would otherwise infer the literal 17.5.
      let camBearing = 0;
      let camZoom: number = CAMERA.zoomAtRest;
      let camReady = false;
      let lastCoveredIndex = -1;
      let lastCoveredPoint: readonly [number, number] | null = null;
      let lastFrameAt = performance.now();

      const unsubFrame = onTrackingFrame((snap) => {
        const src = m.getSource('tracking') as unknown as { setData: (d: unknown) => void } | undefined;
        if (src === undefined) return;
        if (snap.display === null) {
          src.setData(empty);
          camReady = false;
          return;
        }
        src.setData({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { accuracyM: snap.accuracyM, bearing: snap.displayBearingDeg },
              geometry: { type: 'Point', coordinates: snap.display as [number, number] },
            },
          ],
        });

        /**
         * The covered line, redrawn on DISTANCE rather than on vertex index.
         *
         * Keying it on `coveredIndex` alone was wrong and the browser gate's own screenshot showed
         * it: route vertices are up to 217 m apart at p99, so between two of them the grey line
         * kept the endpoint it was given when the index last changed while the dot drove on. It
         * was measured at 195 m adrift, which on screen is a grey line that visibly stops short of
         * the vehicle.
         *
         * Redrawing every frame would re-serialise the whole driven prefix at display rate, which
         * on a long route is thousands of coordinates per frame for no visible gain. So it is
         * redrawn whenever the index changes OR the dot has moved more than
         * `COVERED_RESOLUTION_M` since the last redraw. That bounds the visible error to 3 m,
         * about 4 px at zoom 17, while costing roughly five updates a second at cruising speed
         * instead of sixty.
         */
        const covered = snap.progress?.coveredIndex ?? -1;
        const movedSinceCovered =
          lastCoveredPoint === null
            ? Infinity
            : haversineM(lastCoveredPoint[1], lastCoveredPoint[0], snap.display[1], snap.display[0]);
        if (covered !== lastCoveredIndex || movedSinceCovered > COVERED_RESOLUTION_M) {
          lastCoveredIndex = covered;
          lastCoveredPoint = snap.display;
          const r = useStore.getState().route;
          const cSrc = m.getSource('route-covered') as unknown as { setData: (d: unknown) => void } | undefined;
          if (cSrc !== undefined) {
            const coords =
              r === null || covered < 1
                ? []
                : [...(r.geometry.slice(0, covered + 1) as [number, number][]), snap.display as [number, number]];
            cSrc.setData(
              coords.length < 2
                ? empty
                : {
                    type: 'FeatureCollection',
                    features: [
                      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } },
                    ],
                  },
            );
          }
        }

        if (!useStore.getState().tracking.following) return;

        const now = performance.now();
        const dt = now - lastFrameAt;
        lastFrameAt = now;
        // Speed-based zoom: closer when slow because the next decision is near, wider at speed
        // because it is far. Clamped outside the two anchors in config.
        const t = Math.max(
          0,
          Math.min(1, (snap.speedMps - CAMERA.zoomAtRestSpeedMps) / (CAMERA.zoomAtCruiseSpeedMps - CAMERA.zoomAtRestSpeedMps)),
        );
        const targetZoom = CAMERA.zoomAtRest + t * (CAMERA.zoomAtCruise - CAMERA.zoomAtRest);
        const alpha = 1 - Math.exp(-Math.max(0, dt) / CAMERA.easeTauMs);
        if (!camReady) {
          camBearing = snap.displayBearingDeg;
          camZoom = targetZoom;
          camReady = true;
        } else {
          // Rotate the short way, so 350 to 10 crosses north rather than spinning backwards.
          const delta = ((snap.displayBearingDeg - camBearing + 540) % 360) - 180;
          camBearing = (camBearing + delta * alpha + 360) % 360;
          camZoom += (targetZoom - camZoom) * alpha;
        }
        m.jumpTo({
          center: snap.display as [number, number],
          bearing: camBearing,
          pitch: CAMERA.pitchDeg,
          zoom: camZoom,
        });
      });
      unsubscribers.push(unsubFrame);

      m.on('load', () => {
        addTrackingLayers();
        report();
        paint();
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
      for (const off of unsubscribers) off();
      map?.remove();
    };
  }, [onStatus]);

  return <div className="map" ref={container} role="application" aria-label="Map of Greater Noida" />;
}
