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

/**
 * ROUTING PERFORMANCE BUDGETS. Two of them, because there are two different requirements and
 * one number cannot serve both.
 *
 * The requirement was never "any route in 30 ms". It was "a RE-ROUTE feels instant". Those come
 * apart: a re-route is computed mid-trip while the driver is moving and a stale line is on
 * screen, so latency is felt directly. An initial route is computed once, at trip start, off the
 * interaction path, where 150 ms is invisible.
 *
 * NEITHER MAY BE MET BY NARROWING THE SAMPLE. That is the whole risk of splitting a budget, so
 * it is written into the constants rather than left to good intentions:
 *
 *   Re-route sampling: origins sampled ALONG REAL ROUTES, destination the real remaining
 *   endpoint. This deliberately includes the hard case. A driver who deviates 1 km into a 61 km
 *   trip generates a ~60 km re-route, so long queries ARE in this distribution and are expected
 *   to be what sets p95. Sampling only late-trip origins would be exactly the narrowing this
 *   note forbids.
 *
 *   Initial-route sampling: any pair inside BUILD_AREA, and the corner-to-corner worst case
 *   STAYS IN PERMANENTLY. It is the one query that cannot be argued away.
 *
 * Report the two separately, always. A combined figure hides which requirement failed.
 *
 * THE RE-ROUTE BAND SPLIT, and why it is a definition rather than a relaxation.
 *
 * `rerouteP95Ms` was written for a case, not for a query length: a driver deviates and the answer
 * has to arrive before the next decision. The sample as drawn contains both that case and one it
 * was never about. An 84 km remaining-distance re-route belongs to a driver who still holds a
 * valid old route and more than an hour of road; whether the new line lands in 30 ms or 300 ms is
 * not observable to them. Judging both against one threshold measures the wrong thing in one
 * direction and says nothing in the other.
 *
 * So the sample is REPORTED IN TWO BANDS AND NARROWED IN NEITHER. Every query drawn stays in the
 * distribution permanently, the combined figure is still printed, and the long band is still
 * reported in full. What changes is only which band carries the verdict.
 *
 * `urgentRemainingKm` IS A PROXY AND IS NAMED AS ONE. The variable that actually decides urgency
 * is time to the next maneuver, which does not exist yet: instructions arrive at gate 7 and
 * tracking at gate 8. Remaining distance is what the benchmark can compute today and it correlates
 * with the thing we mean. Revisit it at gate 8, when the real quantity is measurable, and say so
 * if it moves.
 */
export const ROUTE_BUDGET = {
  /**
   * p95 for an URGENT mid-trip re-route, in milliseconds. The felt requirement. Does not move,
   * and has not: this is the same 30 ms, applied to the band it was written for.
   */
  rerouteP95Ms: 30,
  /**
   * Remaining distance, in km, below which a re-route is judged against `rerouteP95Ms`. Above it
   * the query is still measured, still reported, and carries no threshold. Chosen as roughly
   * 20 minutes of driving at the arterial speeds this graph actually produces, which is the range
   * within which a driver can plausibly act on the answer. See the band-split note above: this is
   * a proxy for time to next maneuver, not a claim to be that quantity.
   */
  urgentRemainingKm: 15,
  /** p95 for the first route of a trip, any pair in the area, including corner to corner. */
  initialP95Ms: 150,
} as const;

/**
 * THE OBJECTIVE. What the router is actually minimising, beyond raw travel time.
 *
 * WHY THIS EXISTS. Until gate 4 the router minimised time and NOTHING ELSE. That sounds principled
 * and is not: when two routes are near-tied in time there is no tiebreaker, so the search can
 * return the one that is 37% longer and call it optimal. The measured case is
 * `gautam-buddha-university to jewar`, where we spent 12.0 extra km, on a TOLL road, to save 2.7
 * minutes. Nothing in the model objected, because nothing in the model had an opinion about
 * distance or tolls. A driver offered that trade declines it.
 *
 * THESE ARE STATED PREFERENCES, NOT TUNED CONSTANTS, and the difference is the whole point. Each
 * one is derived from an exchange rate a person can argue with, then CHECKED against the
 * validation set. It is never fitted to it. Fitting these to minimise divergence from OSRM would
 * be parity chasing wearing a different hat, and it would produce numbers nobody could defend
 * except by pointing at the number.
 */
/*
 * The Yamuna per-kilometre tariff that used to live here (2.65 rupees/km, three sources, fetched
 * 2026-08-03) has been REMOVED rather than kept unused. It was never the billing mechanism: the
 * road is gate charged, and 2.65/km priced the landmark leg at about 33 rupees against a real 140.
 * The provenance is preserved in `DESIGN.md`; the live model is `TOLL_ROADS` above.
 */

/**
 * WHAT AN HOUR OF DRIVING COSTS, in rupees. A STATED PREFERENCE, from the operator of this
 * project, and deliberately NOT a wage.
 *
 * THE NAME IS THE CORRECTION. This constant was `VALUE_OF_TIME_RUPEES_PER_HOUR`, 225, and the name
 * is what made it wrong. It is used for exactly one thing: deciding how much detour is worth taking
 * to avoid a fee. That trade is not against the value of an hour, it is against EVERYTHING an extra
 * hour of driving costs. Fuel alone is over 300 rupees an hour at these speeds, before wear, before
 * fatigue, before an hour of village road instead of expressway.
 *
 * 225 implied an hour of driving was worth less than a coffee, and the consequence was visible in
 * the routes: a 140 rupee plaza fee bought 2240 seconds of detour budget, 37 minutes, so the router
 * left the expressway at an interchange and rejoined past the plaza. No driver does that.
 *
 * NOT A MARKET FIGURE, and it is not presented as one. It is the same kind of stated judgement as
 * the distance exchange rate above, written down so it can be argued with rather than buried inside
 * a seconds-per-rupee constant.
 */
const DRIVING_COST_RUPEES_PER_HOUR = 550;

/**
 * THE ELEVEN EPE TOLL PLAZAS, from Gazette of India S.O. 613(E), 3 February 2025.
 *
 * STATUTORY, AND IT OUTRANKS EVERY OTHER SOURCE THIS PROJECT HOLDS. Ministry of Road Transport and
 * Highways, Part II Section 3(ii), amending principal notification S.O. 4153(E) of 5 September
 * 2022. Concessionaire M/s NCR Eastern Peripheral Expressway Pvt Ltd, km 1.000 to km 136.000 on
 * NE-2. Chainages are the notification's own, in the notification's own order, south end last.
 *
 * `exitOnlyCollection` on NE3 is the notification's footnote, verbatim in effect: "Toll collection
 * shall be done only for exit from EPE". It makes the fare matrix ASYMMETRIC at that one plaza. We
 * do not model that yet and the omission is recorded in `DESIGN.md` rather than left implicit.
 */
export const EPE_PLAZAS = [
  { label: 'Main Plaza Jakhauli', village: 'Jakhauli', district: 'Sonepat', chainageKm: 5.5, mainPlaza: true, exitOnlyCollection: false },
  { label: 'Mawikalan', village: 'Mawikalan', district: 'Baghpat', chainageKm: 15.36, mainPlaza: false, exitOnlyCollection: false },
  { label: 'Badagaon', village: 'Badagaon (Trilok Tirth Dham)', district: 'Baghpat', chainageKm: 23.002, mainPlaza: false, exitOnlyCollection: false },
  { label: 'Duhai', village: 'Duhai', district: 'Ghaziabad', chainageKm: 44.512, mainPlaza: false, exitOnlyCollection: false },
  { label: 'NE3 Interchange', village: 'Delhi Meerut Expressway', district: 'Ghaziabad', chainageKm: 49.96, mainPlaza: false, exitOnlyCollection: true },
  { label: 'Dasna', village: 'Dasna', district: 'Ghaziabad', chainageKm: 52.192, mainPlaza: false, exitOnlyCollection: false },
  { label: 'Bilakbarpur', village: 'Bilakbarpur', district: 'GB Nagar', chainageKm: 72.724, mainPlaza: false, exitOnlyCollection: false },
  { label: 'Fatehpur Rampur', village: 'Fatehpur Rampur', district: 'GB Nagar', chainageKm: 83.005, mainPlaza: false, exitOnlyCollection: false },
  { label: 'Maujpur', village: 'Maujpur', district: 'Faridabad', chainageKm: 108.57, mainPlaza: false, exitOnlyCollection: false },
  { label: 'Pelak/Sihol', village: 'Pelak/Sihol (Aligarh Palwal Interchange)', district: 'Palwal', chainageKm: 126.137, mainPlaza: false, exitOnlyCollection: false },
  { label: 'Main Plaza Chhajju Nagar', village: 'Chhajju Nagar', district: 'Palwal', chainageKm: 132.085, mainPlaza: true, exitOnlyCollection: false },
] as const;

/**
 * TABLE 5 OF S.O. 613(E): the tollable road length between every pair of plazas, in kilometres.
 *
 * ⛔ TABLE 5, NOT TABLE 2, AND THE DIFFERENCE IS THE WHOLE FARE. The notification carries two
 * matrices. Table 2 is carriageway length only. Table 5 is "the net effective length for which fee
 * shall be due and payable", carriageway PLUS the equivalent length of structures over 60 m, and it
 * is the one the notification declares fees are payable on. Table 5 exceeds Table 2 by up to 23.4
 * km end to end, so pricing from Table 2 would undercharge a full-length run by about 45 rupees.
 *
 * Row and column order is `EPE_PLAZAS` order. Symmetric, zero diagonal.
 *
 * TRANSCRIBED, THEN CHECKED BY AN IDENTITY RATHER THAN BY RE-READING. `tests/config/epe.test.ts`
 * asserts symmetry, a zero diagonal, and the one property that would catch a mistyped digit: the
 * ten adjacent-plaza structure allowances (Table 5 minus Table 2) must sum to the independently
 * transcribed end-to-end allowance. They do, 23.434 against 23.433 km, which is agreement to the
 * rounding of the published figures across 21 separately transcribed cells.
 *
 * Two cells are NOT monotonic in chainage separation and both are real. The main plazas at km 5.5
 * and km 132.085 bill to the ends of the tolled section at km 1.000 and km 136.000, so their rows
 * carry about 4 km that is not separation; and Dasna to Badagaon exceeds Dasna to Fatehpur Rampur
 * because the Badagaon to Duhai span alone carries 3.020 km of structures.
 */
export const EPE_TOLLABLE_KM: readonly (readonly number[])[] = [
  [0.0, 19.76, 28.032, 52.26, 58.608, 61.967, 83.147, 94.779, 126.824, 144.391, 156.09],
  [19.76, 0.0, 8.272, 32.5, 38.848, 42.207, 63.387, 75.019, 107.064, 124.631, 136.33],
  [28.032, 8.272, 0.0, 24.228, 30.576, 33.935, 55.115, 66.747, 98.792, 116.359, 128.058],
  [52.26, 32.5, 24.228, 0.0, 6.348, 9.707, 30.887, 42.519, 74.564, 92.131, 103.83],
  [58.608, 38.848, 30.576, 6.348, 0.0, 3.359, 24.539, 36.171, 68.216, 85.783, 97.482],
  [61.967, 42.207, 33.935, 9.707, 3.359, 0.0, 21.18, 32.813, 64.858, 82.425, 94.124],
  [83.147, 63.387, 55.115, 30.887, 24.539, 21.18, 0.0, 11.633, 43.678, 61.245, 72.944],
  [94.779, 75.019, 66.747, 42.519, 36.171, 32.813, 11.633, 0.0, 32.045, 49.612, 61.311],
  [126.824, 107.064, 98.792, 74.564, 68.216, 64.858, 43.678, 32.045, 0.0, 17.567, 29.266],
  [144.391, 124.631, 116.359, 92.131, 85.783, 82.425, 61.245, 49.612, 17.567, 0.0, 11.699],
  [156.09, 136.33, 128.058, 103.83, 97.482, 94.124, 72.944, 61.311, 29.266, 11.699, 0.0],
] as const;

/**
 * Table 2 of the same notification, carriageway only. NOT USED FOR PRICING, and that is the point:
 * it is kept solely so `tests/config/epe.test.ts` can run the sum identity that validates the
 * Table 5 transcription. Deleting it would leave Table 5 unverifiable.
 */
export const EPE_CARRIAGEWAY_KM: readonly (readonly number[])[] = [
  [0.0, 13.76, 21.332, 42.54, 47.888, 49.995, 70.455, 80.586, 105.431, 122.998, 132.657],
  [13.76, 0.0, 7.572, 28.78, 34.128, 36.235, 56.695, 66.826, 91.671, 109.238, 118.897],
  [21.332, 7.572, 0.0, 21.208, 26.556, 28.663, 49.123, 59.254, 84.099, 101.666, 111.325],
  [42.54, 28.78, 21.208, 0.0, 5.348, 7.455, 27.915, 38.046, 62.891, 80.458, 90.117],
  [47.888, 34.128, 26.556, 5.348, 0.0, 2.107, 22.567, 32.698, 57.543, 75.11, 84.769],
  [49.995, 36.235, 28.663, 7.455, 2.107, 0.0, 20.46, 30.591, 55.436, 73.003, 82.662],
  [70.455, 56.695, 49.123, 27.915, 22.567, 20.46, 0.0, 10.131, 34.976, 52.543, 62.202],
  [80.586, 66.826, 59.254, 38.046, 32.698, 30.591, 10.131, 0.0, 24.845, 42.412, 52.071],
  [105.431, 91.671, 84.099, 62.891, 57.543, 55.436, 34.976, 24.845, 0.0, 17.567, 27.226],
  [122.998, 109.238, 101.666, 80.458, 75.11, 73.003, 52.543, 42.412, 17.567, 0.0, 9.659],
  [132.657, 118.897, 111.325, 90.117, 84.769, 82.662, 62.202, 52.071, 27.226, 9.659, 0.0],
] as const;

/**
 * Rupees per tollable kilometre for a car on EPE, and the rounding the fares are published at.
 *
 * DERIVED, NOT READ. Table 1 of the notification carries the base rates and is NOT in the excerpt
 * we hold, which begins at page 4, so the rate is fitted to two photographed NHAI rate boards
 * against the Table 5 distances above rather than taken from the statute. What is statutory is the
 * DISTANCE; the rate is measured.
 *
 * THE FIT, and it is the reason this is trusted. For each board cell, the rate consistent with a
 * published fare is a half-open interval, and a rate is only admissible if it lies in ALL ten:
 *
 *   Pelak/Sihol board, current    admissible [1.9457, 1.9526)    1.95 lies inside    10 of 10 cells
 *   Fatehpur Rampur board, 2025   admissible [1.8728, 1.8995)    1.89 lies inside    10 of 10 cells
 *
 * The two bands do not overlap, which is what proves they are two annual revisions rather than
 * measurement noise: 3.3% apart, and the shared Sihol to Fatehpur Rampur cell reads 95 rupees on
 * both boards because both rates round to it. The CURRENT board is the one we bill from.
 *
 * ⛔ 1.90 IS NOT THE FIT FOR THE OLDER BOARD, though it is within a rupee of it. At 1.90 the
 * Mawikalan cell computes 142.54 and rounds to 145 against a posted 140, so 1.90 satisfies 9 of 10.
 * Recorded because it is exactly the kind of near-miss that gets rounded into "verified" by anyone
 * who checks three cells instead of ten. It changes nothing we ship: we bill from 1.95.
 */
export const EPE_RATE_RUPEES_PER_KM = 1.95;

/** Published fares are multiples of five rupees. Verified: the fit above fails at any other step. */
export const EPE_FARE_ROUNDING_RUPEES = 5;

/**
 * Gazette chainage at the southern end of the EPE mainline as our clip holds it, near Palwal.
 *
 * THE ANCHOR THAT TURNS OUR MEASUREMENT INTO THE GAZETTE'S. `packages/pipeline/graph/epe.ts`
 * measures distance north from that end along the mainline carriageway; subtracting it from this
 * number gives chainage, and chainage is what Table 5 is indexed by.
 *
 * FITTED, NOT ASSUMED, because the notification does not state it. The notification defines the
 * TOLLED section as km 1.000 to km 136.000, "ending at 1.00 km distance from km 64.330 on NH-19",
 * which puts the physical tie-in near km 137 without saying where. Our `highway=motorway` tagging
 * stops about 2.4 km short of that tie-in, which is why this reads 134.5 rather than 137, and it is
 * the reason the number is fitted rather than taken from the statute.
 *
 * PRODUCED BY `npm run calibrate:epe`, which fits this one unknown against the eleven published
 * chainages and reports the residual at every feature. Measured 2026-08-14:
 *
 *   Pelak/Sihol       -0.177 km      Fatehpur Rampur   -0.072 km
 *   Maujpur           -0.326 km      Bilakbarpur       +0.027 km
 *   Main Plaza Chhajju Nagar  +0.547 km
 *
 * ⛔ A DRIFTING RESIDUAL IS A REFUSAL, NOT AN AVERAGE. If one anchor stops explaining every
 * feature, our carriageway and the Gazette reference line are not the same road and the script
 * exits non-zero rather than adopting a mapping. Re-run it after any re-clip: this end is where
 * motorway tagging stops, not a bbox edge, but only the calibration proves it did not move.
 *
 * The fit uses NO NAME and none of the three plazas the earlier audit identified by hand; those are
 * held out and used as its test, which all three pass.
 */
export const EPE_CHAINAGE_AT_CLIP_SOUTH_END_KM = 134.548;

/**
 * HOW EACH TOLL ROAD CHARGES, one entry per road, with its own source, date and confidence.
 *
 * WHY A TABLE AND NOT A RATE. Until gate 5 this was one number, `TOLL_TARIFF_RUPEES_PER_KM`,
 * applied to every `toll=yes` metre in the graph. That model is wrong in a way a single rate cannot
 * be made right: **the two roads that carry 85% of our tolled network charge by different
 * mechanisms.** The Yamuna Expressway bills at BARRIERS, a flat fee for crossing a plaza regardless
 * of distance. The Eastern Peripheral is a CLOSED entry-exit system billing a published matrix.
 * Pricing both per kilometre charged roughly 33 rupees for the Yamuna leg of the landmark route
 * against a real 140, about 4x under, on the very route this investigation started from.
 *
 * ⛔ NEVER INFER ONE ROAD'S MECHANISM FROM ANOTHER'S. Each mechanism is established from that
 * road's own operator or statute before it is modelled, or the road stays `unpriced`.
 *
 * ⛔ STRUCTURE AND VALUES CARRY SEPARATE PROVENANCE, because they fail separately. YEIDA's official
 * rate table has the correct plaza structure for the Yamuna Expressway and values at least two
 * revisions stale. EPE is the mirror image: its distances are statutory and current, while its
 * per-kilometre rate is not in the excerpt we hold and had to be fitted to rate boards. An official
 * source can be authoritative about the mechanism and silent or wrong about the amount.
 *
 * ⛔ TWO PRICES PER ROAD, AND THEY ARE NOT THE SAME NUMBER. See `searchRatePerKm` below. This is
 * the one pattern that covers every road here, and `DESIGN.md` states it once under "The search
 * proxy and the billed truth" rather than as a special case per road.
 *
 * CONFIDENCE DRIVES THE UI, and that is a deliberate difference from Google, which shows an
 * estimate for every toll road and gives the reader no way to tell which figures it stands behind.
 * A bare rupee amount is shown only for `verified`; everything else is shown as an estimate and
 * says so. See `TollConfidence` and `TollDisplay` in `packages/shared/index.ts`.
 */
export const TOLL_ROADS = [
  {
    /** Index into this table as stored per edge in the artifact. 0 means "no toll". */
    id: 1,
    key: 'yamuna-expressway',
    label: 'Yamuna Expressway',
    /** Matched against a way's `name` or `ref` by the pipeline. */
    match: /yamuna\s*expressway/i,
    /**
     * GATE HYBRID. Mainline barriers charge a flat fee; ramp plazas charge by distance.
     *
     * The road has main plazas across the carriageway AND eight ramp toll plazas at interchanges,
     * which is why a pure gate model was wrong: it billed only the mainline, so the router learned
     * to leave at one interchange and rejoin past the barrier for nothing. A real driver pays a
     * ramp booth to do that. Every booth is now a toll point and the dodge is unavailable.
     *
     *   crosses a mainline plaza          that plaza's flat fee, once per crossing, plus
     *                                     `ratePerKm` on the distance after the LAST one
     *   crosses only ramp plazas          `ratePerKm` on the distance run on this road
     *   crosses no mapped booth at all    `ratePerKm` on the distance run, and NOT free
     *
     * THE LAST CASE IS OURS, NOT THE OPERATOR'S. OSM holds five booths on this road where the
     * operator runs at least ten, so a route can use an unmapped ramp and cross nothing. Charging
     * it as free is the one error that actively steers drivers onto an unpriced toll road, so it
     * is charged at the ramp rate and marked `confidenceWithRamp`.
     */
    mechanism: 'gate-hybrid',
    /**
     * Rupees for a car crossing one mainline plaza. Jewar.
     *
     * VALUES: rate board photographed at the plaza in person, corroborated by Google Maps toll
     * estimates matching to the rupee across three cumulative probes (Pari Chowk to Jewar 140, to
     * Mathura 320, to Agra 485). Read 2026-08-11.
     * STRUCTURE: main plazas at Jewar, Mathura and Agra each charging a flat car fee, plus eight
     * ramp plazas. Plaza structure from YEIDA's official rate table, ITS page and Phase-II master
     * plan; the ramp plazas are first-hand from the operator of this project.
     * NOT USED FOR VALUES: the same YEIDA table, whose amounts (120/155/140) are at least two
     * revisions behind what is posted at the plaza.
     */
    feeRupees: 140,
    /**
     * Rupees per km at a ramp plaza, and for any run that crosses no mapped booth.
     *
     * REPORTED, NOT STATUTORY. 2.95 is the current per-kilometre basis for this road as reported by
     * the operator of this project. UP publishes no online state gazette (physical publication via
     * the Directorate of Printing and Stationery, Lucknow), so unlike EPE there is no statutory
     * source obtainable online and an RTI to YEIDA is the open path.
     *
     * ⛔ THE 50 RUPEE RAMP BOARD IS NOT ENCODED. One ramp board was photographed showing a flat 50
     * for a car. ONE board is not a tariff: it does not establish whether every ramp charges the
     * same, nor whether a ramp charge stacks with a mainline crossing. Encoding it would turn a
     * single observation into a model. Revisit on a second board or an RTI response.
     */
    ratePerKm: 2.95,
    /**
     * What the SEARCH is charged per km on this road. See the ⛔ on the pattern above.
     *
     * Equal to the ramp rate, which makes the proxy exact for the ramp-only and no-booth cases and
     * close for the rest: a 40 km mainline trip is proxied at 118 rupees against a billed 140.
     */
    searchRatePerKm: 2.95,
    sourceStructure: 'YEIDA official rate table, ITS page, Phase-II master plan; ramp plazas first-hand',
    sourceValues: 'mainline fee from a plaza rate board photographed in person 2026-08-11, corroborated by Google Maps cumulative probes to the rupee; per-km basis reported, not statutory',
    date: '2026-08-11',
    /** A crossing that touches only mainline barriers. Fee and structure both from a primary source. */
    confidence: 'verified',
    /** A crossing that involves a ramp, or no mapped booth. The per-km basis is reported, not published. */
    confidenceWithRamp: 'approximated',
  },
  {
    id: 2,
    key: 'eastern-peripheral',
    label: 'Eastern Peripheral Expressway',
    match: /eastern\s*peripheral|^NE-?2$/i,
    /**
     * MATRIX. A closed entry-exit system, priced from the statutory distance between the plaza the
     * driver entered at and the one they left at, and not from distance driven.
     *
     * `EPE_TOLLABLE_KM` is Table 5 of Gazette S.O. 613(E), so the DISTANCES are statutory. The rate
     * is fitted to two NHAI rate boards against those distances, exactly 10 of 10 cells on the
     * current board. Entry and exit are resolved from `edgeTollSegment`, which the pipeline derives
     * from measured chainage rather than from a village name. `npm run calibrate:epe` is that
     * derivation and its residual is under 350 m at every ramp plaza.
     *
     * THE FLOOR IS GONE, and its absence is the point: the old model needed one because a per-km
     * rate undercharges a short hop. The matrix has the real minimum built in, so nothing has to be
     * clamped.
     */
    mechanism: 'matrix',
    feeRupees: 0,
    /** Applied to the Table 5 distance for the entry-exit pair, then rounded to the published step. */
    ratePerKm: EPE_RATE_RUPEES_PER_KM,
    /** Table 5 of the notification. STATUTORY distances; see `EPE_TOLLABLE_KM` for the transcription check. */
    matrixKm: EPE_TOLLABLE_KM,
    fareRoundingRupees: EPE_FARE_ROUNDING_RUPEES,
    /** The fitted rate, additive and smooth, which is what a shortest path can actually minimise. */
    searchRatePerKm: EPE_RATE_RUPEES_PER_KM,
    sourceStructure: 'Gazette of India S.O. 613(E), 3 February 2025, MoRTH, Part II Sec 3(ii), amending S.O. 4153(E) of 5 September 2022. Eleven plazas with chainages and the Table 5 tollable-distance matrix',
    sourceValues: 'rate fitted to NHAI rate boards at Pelak/Sihol and Fatehpur Rampur against Table 5; the current board fits 10 of 10 cells at 1.95. Table 1 base rates are not in our excerpt, which begins at page 4',
    date: '2026-08-14',
    confidence: 'verified',
    confidenceWithRamp: 'verified',
  },
  {
    id: 3,
    key: 'unpriced',
    label: 'Tolled, tariff not established',
    /** Never matched by name. Assigned to any `toll=yes` way no other entry claims. */
    match: null,
    /**
     * EVERYTHING ELSE TAGGED `toll=yes`: Delhi Western Peripheral, NH148NA, and the unnamed ramps
     * that geometry could not attach to a named toll road.
     *
     * ⛔ THESE MUST NEVER BE SILENTLY FREE. A road we have not priced is not a road that costs
     * nothing, and treating it as free is the one error that actively steers drivers onto it. The
     * rate below is explicit, documented, and deliberately the rate we have actually established on
     * a comparable road in this area rather than an invention. Confidence is `unpriced`, so the
     * figure is always shown as an estimate.
     */
    mechanism: 'per-km',
    feeRupees: 0,
    ratePerKm: EPE_RATE_RUPEES_PER_KM,
    searchRatePerKm: EPE_RATE_RUPEES_PER_KM,
    sourceStructure: 'not established',
    sourceValues: 'stand-in: the EPE rate, fitted from statutory distances and a current rate board, and the only per-km rate established on any road here',
    date: '2026-08-14',
    confidence: 'unpriced',
    confidenceWithRamp: 'unpriced',
  },
] as const;

/**
 * Tolled ways this project refuses to believe, and why.
 *
 * Three ways carry `toll=yes` on a `residential` or `unclassified` road: 213101437 (2.245 km),
 * 213101624 (0.985 km) and 1243997952 (0.402 km), 3.63 km between them, clustered inside about
 * 2 km of each other around 28.46 to 28.48 north, 77.27 east.
 *
 * TREATED AS A TAGGING ERROR, ON EVIDENCE RATHER THAN ON TASTE. Each of the three carries exactly
 * two tags, `highway` and `toll`, with no `name`, no `ref`, no `operator` and no `barrier=toll_booth`
 * anywhere on them. A real toll road has an operator and a name. Residential and unclassified
 * streets are not tolled in this country, and three of them appearing together in one small area
 * with identical minimal tagging is the signature of one bad edit, not of three toll roads.
 *
 * They are excluded from tolling entirely rather than priced as `unpriced`, because charging a
 * residential street a toll would push routes off ordinary streets for a fee that does not exist.
 * If a future extract gives any of them a name or an operator, delete it from this list and let it
 * fall through to the `unpriced` entry.
 */
export const TOLL_TAGGING_ERRORS = [213101437, 213101624, 1243997952] as const;

export const OBJECTIVE = {
  /**
   * What one extra kilometre is worth, in seconds.
   *
   * DERIVED FROM THE EXCHANGE RATE, not fitted. The driver-plausible boundary is roughly one
   * minute saved per 2 to 3 extra kilometres: below that, a detour is not worth taking. At the
   * midpoint of 2.5 km per minute, one kilometre is worth 60 / 2.5 = 24 seconds.
   *
   * THE BAND MATTERS MORE THAN THE MIDPOINT, and it is what makes this a preference rather than a
   * fit. Across the whole stated band the verdict on the landmark case does not change: its 12.0
   * km detour saving 2.7 minutes is penalised 4.0 min at 3 km/min, 4.8 min at 2.5, and 6.0 min at
   * 2. It loses under every value in the band. A number whose conclusion survives its own
   * uncertainty is a preference; one that needs a specific value is a fit.
   */
  secondsPerKm: 24,

  /**
   * How much worse a kilometre of each road class is to drive, as a multiplier on
   * `secondsPerKm`. Indexed by `CLASS_RANK`, so index 0 is motorway and index 7 is service.
   *
   * ONE PREFERENCE, ONE RATE, A WEIGHT ON TOP. The exchange rate above is still the only number
   * with a unit. This says what a kilometre of THIS road is worth relative to an ordinary one, so
   * the whole preference reads as a single sentence: a minute is worth 2.5 km on an ordinary
   * Greater Noida road, less on a rough one and more on a smooth one, in proportion to how much
   * worse the road is to drive.
   *
   * WHY IT EXISTS. A single flat rate on every edge implements the exchange rate correctly and has
   * one unintended consequence: it is a larger FRACTION of a fast road's cost than a slow one's,
   * so it compresses the class hierarchy. Measured, at a flat 24 s/km the motorway to tertiary
   * cost ratio fell from 2.571 to 1.982 and the tertiary-and-below share of route distance across
   * the 56 validation pairs rose from 26.8% to 34.4%. The intent was to decline detours, never to
   * prefer village roads. Weighting the rate by class is the fix, and the sign is what matters:
   * a rough kilometre costs MORE, not a long trip costs more.
   *
   * NOT DERIVED FROM OSM TAGS, AND THAT IS MEASURED, NOT ASSUMED. `npm run calibrate:quality`
   * reports `smoothness` on 0.46% of drivable km, and `surface` on 18.37% but distributed exactly
   * wrong: 50 to 59% of motorway through secondary km, against 6.27% of unclassified and 13.93% of
   * residential. Coverage that is highest where roads are good and lowest where they are rough
   * cannot measure roughness, and 15,343 of the 16,373 tagged ways say asphalt or paved. If OSM
   * coverage in this area ever improves, a per-edge surface field is the natural upgrade and it
   * would supersede this table.
   *
   * THE STATED JUDGEMENT, which is what these numbers are, about driving in Greater Noida:
   *
   *   motorway 0.30      Grade separated, no cross traffic, no pedestrians, lane marked. The
   *                      Yamuna and Noida to Greater Noida expressways. The least demanding
   *                      kilometre on this network by a wide margin.
   *   trunk 0.45         Sealed and wide, but at-grade junctions, slow vehicles sharing the
   *                      carriageway, and occasional pedestrians. NH334DD is the case in point.
   *   primary 0.65       Signalised sector arterial. Autos and two-wheelers merging continuously.
   *   secondary 0.85     Narrower arterial, frequent side entries, vehicles parked at the edge.
   *   tertiary 1.00      NEUTRAL, and the road the exchange rate is stated about. Sealed but
   *                      narrow, unmarked speed breakers, cattle. The ordinary road here.
   *   unclassified 1.50  Village link road. Part unsealed, broken edges, oncoming traffic in the
   *                      middle of the carriageway.
   *   residential 2.00   Sector interior street. Parking on both sides, pedestrians and children
   *                      on the carriageway because there is no footpath.
   *   service 3.50       Parking aisles and back lanes. Walking pace, and not a through route
   *                      under any circumstance. `living_street` ranks here too.
   *
   * WHERE THE JUDGEMENT MET A STRUCTURAL INVARIANT, THE INVARIANT WON, and it is worth naming
   * which numbers moved. The hierarchy must not compress: for any two classes, weighting must
   * leave the slower one at least as expensive RELATIVE to the faster one as pure time made it.
   * That holds exactly when `quality / secondsPerClassKm` never decreases as roads get smaller,
   * and `tests/engine/quality.test.ts` asserts it over every pair. My first cut had primary at
   * 0.70 and trunk at 0.50, which broke it against secondary; both came down. Neither number was
   * moved by looking at the 56 pairs, and this table is never tuned against them.
   */
  qualityByRank: [0.3, 0.45, 0.65, 0.85, 1.0, 1.5, 2.0, 3.5] as const,

  /**
   * WHAT A RUPEE IS WORTH TO THE SEARCH, in seconds. The single conversion every toll price passes
   * through, whatever mechanism charged it.
   *
   *     3600 / DRIVING_COST_RUPEES_PER_HOUR = 3600 / 550 = 6.545 seconds per rupee
   *
   * THIS REPLACED A PER-KILOMETRE TOLL RATE, and the replacement is the point. The old constant
   * was `TOLL_TARIFF_RUPEES_PER_KM / VALUE_OF_TIME_RUPEES_PER_HOUR * 3600`, 42.4 seconds for every
   * tolled kilometre on every tolled road. That folded three separate things into one number: what
   * a road charges, how it charges it, and what time is worth. Only the last is a preference of
   * ours. The first two are facts about each road and now live in `TOLL_ROADS`, one entry per road
   * with its own source and confidence.
   *
   * WHAT THE MOVE FROM 16 TO 6.545 DOES, stated so it is expected rather than discovered: every
   * rupee now buys less than half the detour it used to, so tolls matter LESS to routing and toll
   * roads become relatively more attractive. That is the intended direction. At 16 s per rupee a
   * 140 rupee barrier bought 37 minutes of detour, which is why the router preferred to leave an
   * expressway and rejoin past the plaza; at 6.545 it buys 15 minutes, and the smooth per-km proxy
   * in `TOLL_ROADS.searchRatePerKm` removes the step that made the detour available at all.
   *
   * THE PRINCIPLED part of toll handling is still the flag, not the price: `avoidTollsByDefault`
   * is what answers "do not put me on a toll road", and no amount of pricing substitutes for it.
   */
  secondsPerRupee: 3600 / DRIVING_COST_RUPEES_PER_HOUR,

  /** The per-road toll table above, handed to the search. See `TOLL_ROADS` for why it is a table. */
  tollRoads: TOLL_ROADS,

  /**
   * Whether to exclude tolled roads outright unless the caller asks for them.
   *
   * FALSE: tolls are allowed by default, and priced. Excluding the Yamuna Expressway from every
   * route by default would be a hidden opinion imposed on every user, and it is the wrong default
   * for a city whose fastest road is tolled. The caller may pass `avoidTolls` per request to
   * exclude them entirely, which is a stated choice rather than a buried bias.
   */
  avoidTollsByDefault: false,
} as const;

/**
 * What a turn costs, in seconds. Applied by `packages/engine/turncost.ts`.
 *
 * WHY THIS EXISTS. Until gate 4 the router priced every turn at ZERO, which is not a modelling
 * choice anyone made, it is a gap. A router with free turns prefers a many-turn path through small
 * streets over a fewer-turn path along an arterial whenever the small path is even slightly
 * shorter, and that difference then shows up as a distance divergence against any reference that
 * does price turns.
 *
 * EVERY VALUE IS CALIBRATED AGAINST THE VALIDATION SET, not copied from another router's profile.
 * `npm run experiment:turns` sweeps them over the same 56 pairs `npm run validate` uses and reports
 * what each one does to the delta distribution. Changing a number here without re-running that is
 * how a cost model becomes folklore.
 *
 * ALL VALUES MUST STAY NON-NEGATIVE. The A* heuristic's admissibility proof depends on it: turn
 * costs can only ADD to a path, so a heuristic that lower-bounds the turn-free cost still lower
 * bounds the real one. A negative turn cost would silently break optimality rather than fail.
 */
export const TURN_COST = {
  /** Bearing change up to this, in degrees, is going straight ahead and is free. */
  straightDeg: 25,
  /** Seconds for a square 90 degree turn. Scales linearly with severity beyond `straightDeg`. */
  turnS: 3,
  /**
   * Extra seconds for a turn that crosses oncoming traffic, which has to wait for a gap.
   * India drives on the LEFT, so the crossing turn is a RIGHT turn. Getting this backwards
   * penalises exactly the turns that are free and is invisible in any aggregate number.
   */
  crossTrafficS: 3,
  /** Below this bearing change a turn is a bend in the road, not a crossing manoeuvre. */
  crossMinDeg: 40,
  /** Seconds per step DOWN the road class rank. This is what stops residential rat running. */
  classDropS: 2,
  /**
   * Seconds for a U-turn onto the reverse twin. A PENALTY, never a ban.
   *
   * THIS ONE IS NOT CALIBRATED, and cannot be from the validation set: across all 56 pairs the
   * router takes ZERO U-turns, so a candidate with  produces results identical to one
   * with , down to every digit. That matches the gate 3 measurement of 0 reverse-twin
   * U-turns over 92 km of real routes. The mechanism is proved by unit test, not by this number.
   * 40 s is a reasoned value, roughly what waiting for a gap and turning actually costs, and it is
   * deliberately on the discouraging side. It gets its real calibration at gate 8, where re-routing
   * from a matched mid-road position is the first thing that will actually exercise it.
   */
  uTurnS: 40,
  /** True where traffic drives on the left. Decides which way a crossing turn goes. */
  drivesOnLeft: true,
} as const;
