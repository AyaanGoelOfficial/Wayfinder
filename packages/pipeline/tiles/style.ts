/**
 * The MapLibre style, hand written, generated as JSON.
 *
 * Layer and attribute names here MUST match process.lua and schema.ts. A rename in one of the
 * three yields a blank map with no error anywhere, which is the worst failure mode available.
 *
 * COLOUR, per .claude/rules/ui.md:
 *  - ONE saturated accent, used once: the route line. Everything else is a light neutral or a
 *    deliberately desaturated tint, so the route cannot be out-shouted by the basemap.
 *  - Hold hue, move lightness. Every road grade is the same warm neutral hue at a different
 *    lightness, never a different hue.
 *  - Road hierarchy survives greyscale, because it is carried by WIDTH as well as lightness.
 *    Hue alone would fail for a colour-blind driver, and this is a navigation app.
 *  - Water and vegetation are the two tints the map genuinely needs to be legible. Both are
 *    held under about 25% saturation so they read as tinted neutrals rather than as accents.
 *
 * The `px` ban in ui.md is a CSS rule about ignoring the browser text setting. Map label sizes
 * are canvas-rendered by MapLibre and have no rem equivalent, so it does not apply here.
 */

/** Warm neutral, one hue, lightness doing all the work. */
const LAND = '#f4f1ec';
const ROAD_FILL_MINOR = '#ffffff';
const ROAD_FILL_MAJOR = '#fdf6e8';
const ROAD_CASING = '#ddd7cc';
const ROAD_CASING_MAJOR = '#c9c0ae';
const BUILDING = '#e7e2d8';
const BUILDING_OUTLINE = '#d8d2c5';

/** Desaturated tints. Legibility, not identity. */
const WATER = '#c3d5de';
const GREEN = '#dfe6d5';

/** THE one saturated colour in the whole style. */
export const ROUTE_ACCENT = '#1f6feb';
const ROUTE_CASING = '#ffffff';

const BOUNDARY = '#b9ae9a';

/**
 * Road widths by grade. The wide-to-narrow spread is the greyscale-safe hierarchy channel.
 * Values are MapLibre zoom interpolations, not fixed, or every grade looks identical at z15.
 */
function widthFor(z10: number, z15: number): unknown {
  return ['interpolate', ['linear'], ['zoom'], 8, z10 * 0.35, 12, z10, 15, z15];
}

/**
 * Per-class width, as ONE zoom interpolation whose stops are `match` expressions.
 *
 * The nesting order matters and is not a style choice: the spec allows only one zoom-based
 * `step`/`interpolate` per expression, so wrapping a `match` around several `interpolate`s
 * (the intuitive reading of "each class has its own width curve") is rejected outright with
 * "Only one zoom-based step or interpolate subexpression may be used in an expression", and
 * the whole style fails to load. Interpolate on the outside, match on the inside.
 */
function widthByClass(table: Readonly<Record<string, readonly [number, number]>>, fallback: readonly [number, number]): unknown {
  const stopAt = (pick: (pair: readonly [number, number]) => number): unknown[] => {
    const out: unknown[] = ['match', ['get', 'class']];
    for (const [cls, pair] of Object.entries(table)) out.push(cls, pick(pair));
    out.push(pick(fallback));
    return out;
  };
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    8, stopAt((p) => p[0] * 0.35),
    12, stopAt((p) => p[0]),
    15, stopAt((p) => p[1]),
  ];
}

const CASING_WIDTHS: Readonly<Record<string, readonly [number, number]>> = {
  motorway: [7, 18],
  trunk: [6, 15],
  primary: [5, 12],
  secondary: [4, 10],
  tertiary: [3.2, 8.5],
};
const FILL_WIDTHS: Readonly<Record<string, readonly [number, number]>> = {
  motorway: [5, 14],
  trunk: [4.2, 11.5],
  primary: [3.4, 9],
  secondary: [2.6, 7.2],
  tertiary: [2, 6],
};

export interface StyleOptions {
  /** Where the archive lives, as MapLibre will fetch it. The pmtiles protocol is registered client side. */
  readonly pmtilesUrl: string;
  readonly center: readonly [number, number];
  readonly zoom: number;
  /** Optional glyphs endpoint. Omitted until we generate our own SDF ranges; see CLAUDE.md. */
  readonly glyphsUrl?: string;
}

export function mapStyle(opts: StyleOptions): unknown {
  const SRC = 'wayfinder';
  const style: Record<string, unknown> = {
    version: 8,
    name: 'Wayfinder GN',
    sources: {
      [SRC]: { type: 'vector', url: `pmtiles://${opts.pmtilesUrl}` },
    },
    center: [opts.center[0], opts.center[1]],
    zoom: opts.zoom,
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': LAND } },

      {
        id: 'landuse',
        type: 'fill',
        source: SRC,
        'source-layer': 'landuse',
        paint: {
          'fill-color': [
            'match',
            ['get', 'class'],
            ['park', 'garden', 'recreation_ground', 'golf_course', 'pitch', 'playground'], GREEN,
            ['industrial', 'quarry', 'military', 'construction'], '#eae5da',
            '#efebe2',
          ],
          'fill-opacity': 0.9,
        },
      },

      {
        id: 'water',
        type: 'fill',
        source: SRC,
        'source-layer': 'water',
        paint: { 'fill-color': WATER },
      },
      {
        id: 'waterway',
        type: 'line',
        source: SRC,
        'source-layer': 'waterway',
        paint: {
          'line-color': WATER,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 12, 1.6, 15, 4],
        },
      },

      {
        id: 'building',
        type: 'fill',
        source: SRC,
        'source-layer': 'building',
        minzoom: 14,
        paint: {
          'fill-color': BUILDING,
          'fill-outline-color': BUILDING_OUTLINE,
        },
      },

      // Casings under fills, all casings before all fills, so junctions do not show seams.
      {
        id: 'road-casing-minor',
        type: 'line',
        source: SRC,
        'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['residential', 'unclassified', 'service', 'living_street', 'road', 'pedestrian', 'track']]],
        minzoom: 12,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ROAD_CASING, 'line-width': widthFor(2.2, 7) },
      },
      {
        id: 'road-casing-major',
        type: 'line',
        source: SRC,
        'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ROAD_CASING_MAJOR,
          'line-width': widthByClass(CASING_WIDTHS, [2.6, 7]),
        },
      },

      {
        id: 'road-fill-minor',
        type: 'line',
        source: SRC,
        'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['residential', 'unclassified', 'service', 'living_street', 'road', 'pedestrian', 'track']]],
        minzoom: 12,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ROAD_FILL_MINOR, 'line-width': widthFor(1.2, 5) },
      },
      {
        id: 'road-fill-major',
        type: 'line',
        source: SRC,
        'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': [
            'match',
            ['get', 'class'],
            ['motorway', 'trunk'], ROAD_FILL_MAJOR,
            ROAD_FILL_MINOR,
          ],
          'line-width': widthByClass(FILL_WIDTHS, [1.5, 5]),
        },
      },

      {
        id: 'boundary',
        type: 'line',
        source: SRC,
        'source-layer': 'boundary',
        paint: {
          'line-color': BOUNDARY,
          'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 1.4],
          'line-dasharray': [3, 2],
        },
      },
    ],
  };

  // Text layers are only added when a glyphs endpoint exists. MapLibre needs SDF glyph ranges,
  // and this project may not fetch them from a public endpoint, so they have to be generated
  // and served by us. Adding text layers without glyphs produces console errors and no labels,
  // which is strictly worse than an honest label-free basemap.
  if (opts.glyphsUrl !== undefined) {
    style['glyphs'] = opts.glyphsUrl;
    (style['layers'] as unknown[]).push(
      {
        id: 'road-label',
        type: 'symbol',
        source: SRC,
        'source-layer': 'transportation_name',
        minzoom: 12,
        layout: {
          'symbol-placement': 'line',
          'text-field': ['coalesce', ['get', 'name'], ['get', 'name:en']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 15, 13],
          'text-letter-spacing': 0.02,
        },
        paint: { 'text-color': '#5a5245', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
      },
      {
        // POI labels matter for navigation: you search for a hospital, then you want to see it
        // named on the map. They are also the only place local-script names surface here, since
        // every Devanagari name in the index is on an amenity rather than a settlement.
        id: 'poi-label',
        type: 'symbol',
        source: SRC,
        'source-layer': 'poi',
        minzoom: 15,
        layout: {
          'text-field': ['coalesce', ['get', 'name'], ['get', 'name:en']],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-anchor': 'top',
          'text-offset': [0, 0.6],
          'text-max-width': 9,
          // No `text-optional`, because it is meaningless without an `icon-image`: it means
          // "the text may be hidden if the ICON collides". Omitted as hygiene, NOT as a bug fix.
          // An earlier comment here claimed removing it is what made POI labels appear. A
          // bisection with a render barrier DISPROVED that: with it set true the label still
          // renders, while a deliberately wrong `source-layer` renders zero, which is the
          // control proving the measurement can see a dark layer at all.
          //
          // The real cause of the blank POI layer was never in this style. The client was
          // holding a style fetched BEFORE the server restarted, because navigating to the same
          // URL does not remount the map under Vite HMR. Reload via about:blank when verifying
          // a style change, or the screenshot describes the previous build.
        },
        paint: { 'text-color': '#6f675a', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
      },
      {
        id: 'place-label',
        type: 'symbol',
        source: SRC,
        'source-layer': 'place',
        layout: {
          'text-field': ['coalesce', ['get', 'name'], ['get', 'name:en']],
          'text-font': ['Noto Sans Regular'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            6, ['match', ['get', 'class'], 'city', 13, 'town', 11, 9],
            12, ['match', ['get', 'class'], 'city', 20, 'town', 16, 13],
          ],
          'text-letter-spacing': 0.05,
        },
        paint: { 'text-color': '#3d372e', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 },
      },
    );
  }

  return style;
}

/** The route line, added at runtime above the basemap. The one saturated colour, used once. */
export const ROUTE_LAYERS = {
  casing: {
    id: 'route-casing',
    type: 'line',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ROUTE_CASING,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 15, 14],
      'line-opacity': 0.9,
    },
  },
  line: {
    id: 'route-line',
    type: 'line',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ROUTE_ACCENT,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 15, 9],
    },
  },
} as const;
