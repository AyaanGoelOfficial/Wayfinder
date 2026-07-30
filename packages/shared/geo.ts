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
