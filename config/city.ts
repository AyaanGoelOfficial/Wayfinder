/**
 * City configuration. THE one place a city is defined.
 *
 * Nothing in this repo may hardcode Greater Noida. Retargeting the whole system
 * at another city means editing this file and nothing else.
 *
 * NO COORDINATE IN THIS FILE IS HAND-PICKED. Every number is derived from a named
 * OSM boundary relation, and the derivation is reproducible via
 * `npm run derive:bbox`, which regenerates this file's BUILD_AREA block.
 */

/** Source of truth for the build area. Everything else is derived from this. */
export const BOUNDARY_RELATION = {
  /** OSM relation id. https://www.openstreetmap.org/relation/1958053 */
  id: 1958053,
  name: 'Gautam Buddha Nagar',
  adminLevel: 5,
  boundary: 'administrative',
  /** Date the geometry below was fetched from the OSM API. */
  fetchedOn: '2026-07-29',
  /** Shape stats at fetch time, so drift is visible on re-derive. */
  outerWays: 30,
  boundaryVertices: 1355,
} as const;

/**
 * Buffer applied to the relation's bounding box.
 *
 * Roads routinely leave the district and re-enter it a short distance later. Cutting
 * exactly at the boundary severs those, and the severed stubs are then dropped by
 * largest-SCC filtering, which silently deletes real through-routes. 3 km comfortably
 * exceeds the longest such excursion near the western and southern edges.
 */
export const BUFFER_KM = 3;

/**
 * The relation's own bounding box, exactly as returned by the OSM API on the fetch date.
 * Exported so tests can RECOMPUTE BUILD_AREA from it rather than trusting a comment. If
 * someone hand-edits BUILD_AREA, that test goes red.
 */
export const RELATION_BBOX = {
  minLat: 28.08511,
  maxLat: 28.65295,
  minLon: 77.29289,
  maxLon: 77.73785,
} as const;

/**
 * BUILD_AREA: RELATION_BBOX buffered by BUFFER_KM.
 *
 *   raw relation bbox  lat 28.08511 .. 28.65295   lon 77.29289 .. 77.73785
 *   buffered           lat 28.058161 .. 28.679899 lon 77.262262 .. 77.768478
 *   extent             69.2 x 49.6 km  (3,432 km2)
 *
 * Longitude buffer uses cos(mean latitude), so the km margin holds at this latitude
 * rather than being a naive degree offset. Derived 2026-07-29.
 * Regenerate with `npm run derive:bbox`; verified by tests/config/fixtures.test.ts.
 */
export const BUILD_AREA = {
  minLat: 28.058161,
  maxLat: 28.679899,
  minLon: 77.262262,
  maxLon: 77.768478,
} as const;

/**
 * Source extracts, merged during the build.
 *
 * Two are required, and this is measured rather than assumed. The district polygon lies
 * entirely inside Geofabrik's Central Zone (0 of 1355 boundary vertices outside), but the
 * BUFFER_KM expansion crosses into Delhi along the western edge, which Geofabrik files
 * under Northern Zone. Verified 2026-07-29:
 *
 *   buffered bbox vs central only          4516 / 14641 grid cells outside  FAIL
 *   buffered bbox vs central UNION northern    0 / 14641 grid cells outside  PASS
 *
 * tilemaker accepts both .pbf files on one command line, so no merge tool is needed.
 *
 * `md5` is the value published alongside the file on 2026-07-28 and is recorded for
 * provenance only. Geofabrik republishes daily, so the BUILD verifies each download
 * against the live `<url>.md5` fetched at build time, hard-failing on mismatch, and
 * writes the observed checksum plus Last-Modified into data/extracts.lock.json. Pinning
 * a checksum here would break every build within 24 hours.
 */
export const EXTRACTS = [
  {
    name: 'central-zone',
    url: 'https://download.geofabrik.de/asia/india/central-zone-latest.osm.pbf',
    polyUrl: 'https://download.geofabrik.de/asia/india/central-zone.poly',
    observedBytes: 350_265_638,
    observedMd5: '323b2c699d8924218b6248c645bde68e',
    observedOn: '2026-07-28',
  },
  {
    name: 'northern-zone',
    url: 'https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf',
    polyUrl: 'https://download.geofabrik.de/asia/india/northern-zone.poly',
    observedBytes: 222_328_628,
    observedMd5: 'a8022e81a56829921d9a434f4a6461b7',
    observedOn: '2026-07-28',
  },
] as const;

/**
 * Semantic gates live in ./fixtures, split by what they actually test:
 *   fixtures/routing.ts  graph coverage. Snapping, legality, SCC connectivity.
 *   fixtures/search.ts   name resolution. What a person types vs what OSM holds.
 * They are separate because a routing fixture may sit on a highway in open country where
 * nobody would search, and a search fixture may resolve nowhere near a road.
 */

/** Routing profiles. Driving is primary; walking is a config-level second. */
export const PROFILES = ['driving', 'walking'] as const;
export type Profile = (typeof PROFILES)[number];
export const DEFAULT_PROFILE: Profile = 'driving';

/** Live-tracking thresholds. See DESIGN.md for how each was chosen. */
export const TRACKING = {
  /** Reject a fix reporting accuracy worse than this, in metres. */
  maxAccuracyM: 50,
  /** Reject a fix implying travel faster than this between fixes, in km/h. */
  maxImpliedSpeedKmh: 150,
  /** Matched position must be off-corridor by more than this to count as off-route. */
  offRouteM: 30,
  /** Sustained off-route duration before a re-route fires, in ms. */
  offRouteMs: 3000,
  /** ETA recompute interval. Charter item 5: numbers must not thrash. */
  etaMinIntervalMs: 1000,
  /**
   * Nominal fix cadence, for UI copy only. NEVER used as a timing assumption.
   * Measured under 4x CPU throttle, a requested 100 ms interval fired at
   * 188 / 315 / 253 / 117 ms. All dead reckoning uses fix timestamp deltas.
   */
  nominalFixHz: 1,
} as const;

/**
 * TWO SNAP RADII. They are not interchangeable, and crossing them is a bug, not a tuning
 * choice. Each is named after the code path it belongs to so a misuse is visible at the
 * call site rather than buried in a shared constant.
 */

/**
 * SNAP_TRACKING_M: matching a live GPS fix to the road the user is on.
 *
 * TIGHT ON PURPOSE. A fix farther than this from any road does not mean the driver is in
 * a field, it means THE MATCHER IS WRONG, or the fix is junk and should have been rejected
 * upstream. Reporting a confident match 100 m from any road is precision charter item 3
 * failing silently.
 *
 * NEVER WIDEN THIS TO MAKE A TEST PASS. If a tracking test fails at 40 m, the matcher, the
 * fix filter, or the fixture is wrong. Widening converts a loud failure into a lie.
 */
export const SNAP_TRACKING_M = 40;

/**
 * SNAP_DESTINATION_M: resolving a tapped point or a searched place to a routable edge.
 *
 * GENEROUS ON PURPOSE. A destination legitimately sits off-road: a station platform, a mall
 * interior, a campus centroid, a village whose centre is a field. The fixture `dadri` is
 * roughly 150 to 200 m from the nearest drivable road and is a correct destination.
 *
 * Beyond this the server returns a structured, actionable error rather than a silent
 * nearest-anything match.
 */
export const SNAP_DESTINATION_M = 500;
