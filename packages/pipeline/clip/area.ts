/**
 * The BUILD_AREA containment test, done in integer space.
 *
 * WHY INTEGERS: OSM coordinates are exact multiples of 1e-7, and `BUILD_AREA` is derived to
 * six decimal places, so scaling both by 1e7 makes every value an exact integer and removes
 * the comparison's rounding step entirely.
 *
 * Doing it in degrees does not merely risk imprecision, it produced a real disagreement:
 * cross-validating central-zone against libosmium matched exactly on every count except nodes
 * inside the area, which differed by ONE. Our decoder computes
 * `lat = 1e-9 * (latOffset + granularity * delta)`; libosmium keeps an int32 at 1e-7 and
 * divides. Neither 1e-9 nor a bound like 28.058161 is exactly representable in binary, so the
 * two routes to the same number can land one unit in the last place apart, and against an
 * INCLUSIVE bound that a node sits exactly on, one says inside and the other says outside.
 *
 * The bounds are inclusive. A node exactly on the edge is inside, which matters because
 * `BUILD_AREA` is already buffered by 3 km specifically so nothing real sits on the cut.
 */
import { BUILD_AREA } from '../../../config/city.ts';

export const COORD_SCALE = 1e7;

/**
 * Degrees to the exact integer OSM stores. `Math.round` is safe rather than lossy here: the
 * true value is an exact multiple of 1e-7, and a double at this magnitude carries about 1e-16
 * of relative error, so the nearest integer is always the right one by a factor of ~1e7.
 */
export function toScaled(deg: number): number {
  return Math.round(deg * COORD_SCALE);
}

export const BUILD_AREA_SCALED = {
  minLat: toScaled(BUILD_AREA.minLat),
  maxLat: toScaled(BUILD_AREA.maxLat),
  minLon: toScaled(BUILD_AREA.minLon),
  maxLon: toScaled(BUILD_AREA.maxLon),
} as const;

/** The containment test the build uses. Integer in, integer compared, no rounding. */
export function inBuildAreaScaled(latScaled: number, lonScaled: number): boolean {
  return (
    latScaled >= BUILD_AREA_SCALED.minLat &&
    latScaled <= BUILD_AREA_SCALED.maxLat &&
    lonScaled >= BUILD_AREA_SCALED.minLon &&
    lonScaled <= BUILD_AREA_SCALED.maxLon
  );
}

/**
 * The float comparison, kept ONLY so scripts/diagnose-boundary.ts can show the two disagreeing.
 * Not for use in the build. If you are reaching for this in pipeline code, use
 * `inBuildAreaScaled` instead.
 */
export function inBuildAreaDegrees(lat: number, lon: number): boolean {
  return (
    lat >= BUILD_AREA.minLat &&
    lat <= BUILD_AREA.maxLat &&
    lon >= BUILD_AREA.minLon &&
    lon <= BUILD_AREA.maxLon
  );
}
