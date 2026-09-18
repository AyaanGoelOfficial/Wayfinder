/**
 * The blue dot, its accuracy circle, and the greyed-out part of the route already driven.
 *
 * THE ACCURACY CIRCLE IS DRAWN AT TRUE SIZE, and that is a requirement rather than a detail.
 * Charter item 10 forbids silent failure, and a fixed-size decorative ring is exactly that: it
 * looks identical whether the receiver is confident to 5 m or to 40, so a degraded fix renders as
 * a confident one. `circle-radius` in MapLibre is PIXELS, so the metres are converted in the
 * expression below using the web-mercator scale at this latitude.
 *
 *   metres per pixel = 156543.03392 * cos(latitude) / 2^zoom
 *   so pixels = metres * 2^zoom / (156543.03392 * cos(latitude))
 *
 * The city spans 28.06 to 28.68 degrees, where cos runs 0.8823 to 0.8779, a 0.5% spread. One
 * constant for the whole build area is therefore accurate to within half a percent, which is far
 * inside the honesty this circle exists to provide, and it avoids a per-feature latitude lookup on
 * every frame.
 *
 * ⛔ THE RADIUS MUST BE WRITTEN AS A TOP-LEVEL `interpolate`, NOT AS ARITHMETIC ON `['zoom']`.
 * MapLibre rejects the obvious form with:
 *
 *   layers.<id>.paint.circle-radius: "zoom" expression may only be used as input to a
 *   top-level "step" or "interpolate" expression.
 *
 * and it reports that on the map's ERROR CHANNEL rather than throwing, so `addLayer` returns
 * normally and the layer simply is not there. That is how this shipped invisible the first time:
 * the dot rendered, the accuracy ring did not, and nothing anywhere said why.
 *
 * The interpolation below is EXACT rather than an approximation. With base 2 over the span 0 to
 * 24, MapLibre's exponential factor is t = (2^z - 1) / (2^24 - 1), so
 *
 *   value = A + (B - A) * t   with A = a/K and B = a * 2^24 / K
 *         = (a/K) * [1 + (2^24 - 1) * (2^z - 1) / (2^24 - 1)]
 *         = (a/K) * 2^z
 *
 * which is the metres-to-pixels formula itself, at every zoom and not just at the two stops.
 */
import { BUILD_AREA } from '@config/city.ts';
import { ROUTE_ACCENT } from './routeLayers.ts';

const MID_LAT = (BUILD_AREA.minLat + BUILD_AREA.maxLat) / 2;
/** Metres per pixel at zoom 0 for this city's latitude. */
export const METRES_PER_PIXEL_Z0 = 156_543.03392 * Math.cos((MID_LAT * Math.PI) / 180);

/** The already-driven part of the line. Grey, above the accent, so progress reads at a glance. */
const COVERED_GREY = '#9aa4b2';

export const TRACKING_LAYERS = {
  /** Honest accuracy. Radius is the receiver's own reported metres, converted to pixels. */
  accuracy: {
    id: 'tracking-accuracy',
    type: 'circle',
    paint: {
      'circle-color': ROUTE_ACCENT,
      'circle-opacity': 0.1,
      'circle-stroke-color': ROUTE_ACCENT,
      'circle-stroke-width': 1,
      'circle-stroke-opacity': 0.25,
      'circle-radius': [
        'interpolate',
        ['exponential', 2],
        ['zoom'],
        0,
        ['/', ['get', 'accuracyM'], METRES_PER_PIXEL_Z0],
        24,
        ['/', ['*', ['get', 'accuracyM'], 16_777_216], METRES_PER_PIXEL_Z0],
      ],
    },
  },
  /** White casing, so the dot stays visible over the accent route line beneath it. */
  dotCasing: {
    id: 'tracking-dot-casing',
    type: 'circle',
    paint: {
      'circle-color': '#ffffff',
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 8, 18, 12],
    },
  },
  dot: {
    id: 'tracking-dot',
    type: 'circle',
    paint: {
      'circle-color': ROUTE_ACCENT,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 18, 8],
    },
  },
  /**
   * The heading chevron. A symbol rather than a circle because direction is the one thing a round
   * dot cannot express, and on a divided road knowing which way the vehicle points is the
   * difference between the two carriageways.
   */
  heading: {
    id: 'tracking-heading',
    type: 'symbol',
    layout: {
      'icon-image': 'tracking-chevron',
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 18, 0.8],
    },
  },
  covered: {
    id: 'route-covered',
    type: 'line',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': COVERED_GREY,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 15, 9, 18, 14],
      'line-opacity': 0.85,
    },
  },
} as const;

/**
 * A chevron, drawn at runtime rather than shipped as an asset.
 *
 * No network request, no build step, no file to fall out of sync with the accent constant. It is
 * generated once and registered with the map under the name the layer above references.
 */
export function chevronImage(size = 64): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return new ImageData(size, size);
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  // Points UP at rotation 0, because MapLibre's `icon-rotate` measures clockwise from north and
  // the bearing we feed it is measured the same way.
  ctx.moveTo(size * 0.5, size * 0.12);
  ctx.lineTo(size * 0.78, size * 0.62);
  ctx.lineTo(size * 0.5, size * 0.48);
  ctx.lineTo(size * 0.22, size * 0.62);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}
