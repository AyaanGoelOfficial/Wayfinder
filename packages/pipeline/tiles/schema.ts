/**
 * The tilemaker layer configuration, GENERATED from config/city.ts rather than hand-written.
 *
 * `bounding_box` has to come from `BUILD_AREA` or it is a second, drifting definition of the
 * city, and root CLAUDE.md is explicit that `config/` is the only place the target city is
 * defined. A hand-typed bbox here is the same defect as a hand-typed `BUILD_AREA`.
 *
 * Layer and attribute names are THE CONTRACT with the hand-written MapLibre style and with
 * process.lua. All three must change together.
 */
import { BUILD_AREA } from '../../../config/city.ts';

/**
 * z15 is the deepest zoom built. At this latitude a z15 tile at 4096 extent resolves to about
 * 1.2 m, which is finer than GPS ever is, and MapLibre overzooms past it for free. Building to
 * z16 would roughly quadruple tile count and .pmtiles size to add nothing a driver can see.
 */
export const MAX_ZOOM = 15;
export const MIN_ZOOM = 6;

export function tilemakerConfig(): unknown {
  return {
    layers: {
      // Roads carry simplification only below z13. Simplifying at high zoom is what makes a
      // route line and the road under it visibly disagree, which is charter item 1.
      transportation: {
        minzoom: MIN_ZOOM, maxzoom: MAX_ZOOM,
        simplify_below: 13, simplify_level: 0.0003, simplify_ratio: 2.0,
      },
      transportation_name: { minzoom: 12, maxzoom: MAX_ZOOM },
      place: { minzoom: MIN_ZOOM, maxzoom: MAX_ZOOM },
      poi: { minzoom: 14, maxzoom: MAX_ZOOM },
      water: {
        minzoom: 8, maxzoom: MAX_ZOOM,
        simplify_below: 12, simplify_level: 0.0003, simplify_ratio: 2.0,
      },
      waterway: {
        minzoom: 8, maxzoom: MAX_ZOOM,
        simplify_below: 12, simplify_level: 0.0003, simplify_ratio: 2.0,
      },
      landuse: {
        minzoom: 10, maxzoom: MAX_ZOOM,
        simplify_below: 13, simplify_level: 0.0003, simplify_ratio: 2.0,
      },
      building: { minzoom: 14, maxzoom: MAX_ZOOM },
      boundary: { minzoom: MIN_ZOOM, maxzoom: MAX_ZOOM },
    },
    settings: {
      minzoom: MIN_ZOOM,
      maxzoom: MAX_ZOOM,
      basezoom: MAX_ZOOM,
      include_ids: false,
      name: 'Wayfinder GN',
      version: '0.1.0',
      description: 'Greater Noida and Gautam Buddha Nagar, built from OSM by wayfinder-gn',
      compress: 'gzip',
      // [minlon, minlat, maxlon, maxlat]. Belt and braces: the input PBF is already clipped,
      // but the clip deliberately keeps nodes just OUTSIDE the area so boundary-crossing roads
      // are not severed, and those should not extend the tiled region.
      bounding_box: [BUILD_AREA.minLon, BUILD_AREA.minLat, BUILD_AREA.maxLon, BUILD_AREA.maxLat],
    },
  };
}
