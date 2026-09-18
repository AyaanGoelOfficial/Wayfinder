/**
 * Great-circle distance, in metres.
 *
 * WHY IT LIVES IN shared/: the pipeline measures edge lengths with it and the engine measures
 * route costs and snap distances with it. The route line and the drawn road can only be
 * guaranteed to agree if there is exactly ONE implementation, and `packages/CLAUDE.md` forbids
 * the pipeline importing the engine, so shared/ is the only place both can reach. It is a
 * separate file from index.ts on purpose: index.ts is THE CONTRACT and holds types crossing
 * server and client, not utilities.
 *
 * Haversine rather than equirectangular: at this latitude the cheap approximation is off by
 * a few metres per kilometre, which accumulates over a long route into an ETA that disagrees
 * with the drawn geometry.
 */

const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean radius
const DEG_TO_RAD = Math.PI / 180;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Initial great-circle bearing, degrees clockwise from true north, in [0, 360).
 *
 * ADDED AT GATE 8, and it is the canonical implementation for NEW code. Two private copies
 * predate it, and they are not the same as each other, which is worth stating precisely rather
 * than filing under "duplication":
 *
 *   `engine/turncost.ts`      the SAME great-circle formula and the same [0, 360) range
 *   `engine/instructions.ts`  a DIFFERENT function: planar, and signed over (-180, 180]
 *
 * So this is not three copies of one thing. Neither is refactored to import this one: `turncost`
 * sits in the routing hot loop and `instructions` feeds gate-verified output, and a tidying edit
 * to either buys nothing while risking a regression in code two gates have already checked.
 * What is asserted instead, in `tests/shared/geo.test.ts`, is this function against known-truth
 * bearings, so the canonical one is pinned even though the older two are left alone.
 *
 * Live tracking needs this in `shared/` specifically: the client matches fixes to the active
 * route polyline itself, and `packages/CLAUDE.md` forbids the client importing `engine/`.
 */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG_TO_RAD;
  const p2 = lat2 * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const y = Math.sin(dLon) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Smallest absolute angle between two bearings, in [0, 180].
 *
 * Wrapping is the whole point: 359 and 1 differ by 2 degrees, not 358. Every heading comparison
 * in the tracking matcher goes through here, and getting it wrong would make north-pointing roads
 * the one place wrong-side matching still happened.
 */
export function bearingGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Perpendicular projection of a point onto the segment a-b, in local metres.
 *
 * Returns the projected point, the distance to it, and how far along the segment it fell as a
 * fraction clamped to [0, 1]. Equirectangular within the segment: over the tens of metres a
 * single shape segment spans, the error against haversine is below a millimetre, and the clamp
 * means an endpoint is returned exactly rather than approximately when the foot falls outside.
 */
export function projectOntoSegment(
  plat: number,
  plon: number,
  alat: number,
  alon: number,
  blat: number,
  blon: number,
): { readonly lat: number; readonly lon: number; readonly distanceM: number; readonly t: number } {
  const cosLat = Math.cos(((alat + blat) / 2) * DEG_TO_RAD);
  const ax = 0;
  const ay = 0;
  const bx = (blon - alon) * cosLat;
  const by = blat - alat;
  const px = (plon - alon) * cosLat;
  const py = plat - alat;
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / len2));
  const lat = alat + t * (blat - alat);
  const lon = alon + t * (blon - alon);
  return { lat, lon, distanceM: haversineM(plat, plon, lat, lon), t };
}
