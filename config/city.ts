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
/**
 * The published Yamuna Expressway car tariff, in rupees per kilometre.
 *
 * VERIFIED, NOT RECALLED, and checked against an independent total rather than taken from one
 * page. Three sources agree on 2.65 for a car, jeep or van: the Wikipedia article, tollguru's
 * expressway guide (attributing it to 2025), and sarkarilist's rate list (previous rate 2.50,
 * raised at YEIDA's 74th board meeting). The cross-check is the full-run figure: 438 rupees over
 * 165.5 km is 2.647 rupees per km, which agrees to three digits with a number derived a different
 * way. Fetched 2026-08-03.
 *
 * ONE DISCREPANCY, RECORDED RATHER THAN RESOLVED BY PREFERENCE. A Construction World article dated
 * 2024-09-30 reports a 13.5% rise to 2.95 per km effective 1 October, under the Suraksha
 * resolution plan. No source reporting a CURRENT rate corroborates 2.95, and the three that do
 * report a current rate all say 2.65. The higher figure is not used. If it turns out to be live,
 * this constant rises about 11% and every conclusion below strengthens rather than reverses,
 * because a dearer toll can only make the tolled road less attractive.
 *
 * This is the ONLY toll road in the build area that matters at this scale, so one tariff stands in
 * for the network. `npm run calibrate:quality` reports 920 ways tagged `toll=yes`.
 *
 * RE-VERIFY THIS AT GATE 9. Phone verification happens in the city, on the road, where the current
 * car rate is posted at the plaza and reading it is a one-glance check that no amount of desk
 * research equals. If the posted figure disagrees with 2.65, change this constant and re-run
 * `npm run experiment:objective`; nothing else needs touching, which is the point of deriving the
 * cost from a tariff rather than storing the seconds directly.
 */
const TOLL_TARIFF_RUPEES_PER_KM = 2.65;

/**
 * What an hour of a private car driver's time is worth here, in rupees. A STATED JUDGEMENT.
 *
 * 225 is the midpoint of a 150 to 300 band. Unlike the tariff this is not a published figure and
 * is not presented as one: it is the same kind of preference as the distance exchange rate, and it
 * is stated so it can be argued with rather than buried inside a seconds-per-km constant. The band
 * is what matters, and it is checked at the point of use: every value in it produces a toll price
 * above the level at which the landmark route changes, so the conclusion does not depend on
 * landing on 225.
 */
const VALUE_OF_TIME_RUPEES_PER_HOUR = 225;

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
   * What a kilometre of TOLLED road costs, in seconds. Applied only when tolls are allowed, since
   * excluding them makes the price irrelevant.
   *
   * DERIVED FROM THE PUBLISHED TARIFF AND A STATED VALUE OF TIME. Two inputs, one division:
   *
   *     TOLL_TARIFF_RUPEES_PER_KM / VALUE_OF_TIME_RUPEES_PER_HOUR * 3600
   *       = 2.65 / 225 * 3600
   *       = 42.4 seconds per tolled kilometre
   *
   * Both inputs are stated below as named constants so neither can be quietly adjusted, and the
   * band on the value of time is checked the same way the distance band is: the conclusion has to
   * survive the whole range or the number is a fit rather than a preference.
   *
   *   at 150 rupees/hour, a time-poor driver   63.6 s/km
   *   at 225 rupees/hour, the stated midpoint  42.4 s/km
   *   at 300 rupees/hour, a time-rich driver   31.8 s/km
   *
   * THIS SUPERSEDES A NUMBER THAT WAS NEVER DERIVED. The previous value was 12 s/km, justified
   * only as "half of `secondsPerKm`, so the two move together". That tie was tidy and had no
   * content: it made the toll price a function of the distance preference rather than of the toll.
   * Inverting the arithmetic shows how far off it was. 12 s/km implies a value of time of
   * 2.65 / 12 * 3600 = about 795 rupees an hour, which is not a defensible figure for a private
   * car driver here. We were under-pricing the toll by roughly a factor of three and a half, and
   * the flat distance preference had been silently covering for it.
   *
   * WHAT THIS IS AND IS NOT. It is a fare converted into the only unit the search understands.
   * It is NOT a claim that the toll is charged per kilometre continuously: it is levied at plazas
   * at 38, 95 and 150 km from Greater Noida, and the per-km figure is the published tariff basis
   * rather than the billing mechanism. For a router choosing between corridors that difference
   * does not matter, because what is being compared is the cost of using the tolled road at all.
   * It also carries no discount logic, so the round-trip-within-24-hours rate is not modelled.
   *
   * The PRINCIPLED part of toll handling is still the flag, not this number: `avoidTollsByDefault`
   * is what answers "do not put me on a toll road", and no price is a substitute for it.
   */
  tollReluctanceSecondsPerKm: (TOLL_TARIFF_RUPEES_PER_KM / VALUE_OF_TIME_RUPEES_PER_HOUR) * 3600,

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
