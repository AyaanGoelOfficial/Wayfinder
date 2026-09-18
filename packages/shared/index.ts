/**
 * THE CONTRACT. Every type that crosses the server/client boundary lives here.
 *
 * Adding a capability means editing THIS FILE, never reaching across the boundary with an
 * inline shape or a raw string. If a route, channel or error code is not named here, it
 * does not exist as far as either side is concerned.
 */

import type { Profile } from '@config/city.ts';

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

/** [lon, lat]. GeoJSON order, everywhere, no exceptions. See the gotcha in CLAUDE.md. */
export type LngLat = readonly [number, number];

export interface BBox {
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLon: number;
  readonly maxLon: number;
}

// ---------------------------------------------------------------------------
// Snapping
// ---------------------------------------------------------------------------

/** Which radius a snap was performed under. Recorded so a crossed radius is visible. */
export type SnapPurpose = 'tracking' | 'destination';

export interface SnapResult {
  /** The projected point ON the edge, never the input point. */
  readonly point: LngLat;
  readonly edgeId: number;
  /** 0..1 along the edge's full shape geometry. */
  readonly fraction: number;
  readonly distanceM: number;
  readonly purpose: SnapPurpose;
}

/**
 * What a turn costs, in seconds. The VALUES live in `config/city.ts`; this is only their shape.
 *
 * Stated here so `packages/engine/turncost.ts` can take the model as a parameter rather than
 * importing the constant, which is what lets `npm run experiment:turns` sweep it over the
 * validation set without editing config. Every field must be non-negative: the A* admissibility
 * proof rests on turn costs only ever ADDING to a path.
 */
/**
 * What the router minimises beyond raw travel time. VALUES live in `config/city.ts`.
 *
 * Passed in rather than imported so the calibration scripts can vary it without editing config,
 * and so the shape is stated once in the contract rather than inferred from a constant.
 * `secondsPerKm` and `tollReluctanceSecondsPerKm` must be non-negative for the same reason every
 * turn cost must be: A* admissibility depends on nothing ever making a path cheaper.
 */
/**
 * How much of a toll figure we are willing to put in front of a driver.
 *
 * A DELIBERATE DIFFERENCE FROM GOOGLE, which shows an estimated amount for every toll road and
 * gives the reader no way to tell which of those figures it stands behind. We show a rupee amount
 * only where we can defend it, and otherwise say that a toll exists without pretending to know its
 * price. The router is unaffected: an approximated cost still steers, because the uncertainty
 * belongs in what is displayed and not in what the search knows.
 *
 *   verified      mechanism and amount both established from a primary source. Show the rupees
 *                 bare, with no hedge, because we stand behind the figure.
 *   approximated  mechanism established, amount rests on a reported rather than published basis.
 *                 Show the rupees, labelled as an estimate.
 *   unpriced      the road charges, and we have not established what. Show a stand-in rate,
 *                 labelled as an estimate. NEVER treated as free.
 *
 * The line that moved between gate 5 and gate 6 is where the AMOUNT appears, not where the
 * confidence does: `approximated` used to show no figure at all. Once every road had a defensible
 * per-kilometre basis, withholding the number stopped protecting the reader and started leaving
 * them with less than we know. What must never happen is a hedged figure and a certain one looking
 * the same, which is what `TollDisplay` exists to prevent.
 */
export type TollConfidence = 'verified' | 'approximated' | 'unpriced';

/**
 * HOW A ROUTE'S TOLL FIGURE MAY BE RENDERED. Derived from `TollConfidence`, never from the call site.
 *
 *   none        this route pays nothing on a tolled road. Render no toll element at all.
 *   exact       render the amount bare: `140`.
 *   estimated   render the amount behind the estimate label the copy rules define.
 *
 * ⛔ THE PREFIX IS NOT A VIEW DECISION. A component that decides for itself when to write
 * "Estimated" will get it right on the screen it was written for and wrong on the next one, and the
 * failure is silent: an estimate presented as a fact looks exactly like a fact. The server derives
 * this once, from the confidence of every road the route touched, and the client obeys it.
 */
export type TollDisplay = 'none' | 'exact' | 'estimated';

/** How one road charges. Amounts and provenance live in `config/city.ts`. */
export interface TollRoad {
  readonly id: number;
  readonly key: string;
  readonly label: string;
  /**
   * `gate-hybrid` bills a flat fee per mainline barrier plus a per-km ramp charge; `matrix` bills a
   * published entry-exit fare; `per-km` bills distance at a stated stand-in rate.
   */
  readonly mechanism: 'gate-hybrid' | 'matrix' | 'per-km';
  /** Flat fee for one mainline barrier crossing. `gate-hybrid` only. */
  readonly feeRupees: number;
  /**
   * This road's per-kilometre MONEY rate, whose role depends on the mechanism: the ramp charge
   * under `gate-hybrid`, the rate applied to the matrix distance under `matrix`, and the whole
   * charge under `per-km`.
   */
  readonly ratePerKm: number;
  /**
   * Tollable kilometres between every pair of plazas, indexed by plaza. `matrix` only.
   *
   * Symmetric with a zero diagonal. A route occupying inter-plaza spans a..b entered at plaza a and
   * left at plaza b+1, so `matrixKm[a][b+1]` is its billed distance regardless of how far it drove.
   */
  readonly matrixKm?: readonly (readonly number[])[];
  /** Published fares are multiples of this many rupees. `matrix` only. */
  readonly fareRoundingRupees?: number;
  /**
   * WHAT THE SEARCH IS CHARGED PER KILOMETRE ON THIS ROAD, which is NOT what the driver is billed.
   *
   * ⛔ THE PROXY AND THE TRUTH ARE DIFFERENT NUMBERS ON PURPOSE, and this field is where that is
   * declared. A shortest path can only minimise a cost that is additive over edges. Neither real
   * mechanism is: a barrier fee is a step function of position and an entry-exit fare is a function
   * of the whole run. Putting either into the search produced a measured defect, a 140 rupee fee
   * landing on one 604 m edge as a 37 minute penalty, which the router answered by leaving the
   * expressway and rejoining past the barrier.
   *
   * So the SEARCH sees a smooth per-km rate close to the road's real average, and the REPORTED
   * `Route.tollCost` is computed once over the chosen path by that road's exact mechanism. The two
   * agree closely and are never required to agree exactly. `DESIGN.md` states this once, under
   * "The search proxy and the billed truth", for every road rather than per road.
   */
  readonly searchRatePerKm: number;
  /** Confidence when only this road's primary mechanism was exercised. */
  readonly confidence: TollConfidence;
  /** Confidence when a ramp charge or an unmapped-booth fallback was involved. */
  readonly confidenceWithRamp: TollConfidence;
}

export interface ObjectiveConfig {
  /** Seconds charged per kilometre travelled, on top of drive time. The distance preference. */
  readonly secondsPerKm: number;
  /**
   * Multiplier on `secondsPerKm` per `CLASS_RANK`, index 0 motorway to index 7 service. A rough
   * kilometre costs more than a smooth one. Omit for a flat rate on every class, which is what
   * the toy graphs and the pre-quality candidates in the sweeps want.
   *
   * Must be non-negative, and must not COMPRESS the class hierarchy: see `config/city.ts` for the
   * invariant and `tests/engine/quality.test.ts` for the assertion over every class pair.
   */
  readonly qualityByRank?: readonly number[];
  /**
   * Seconds per rupee: what money is worth to the search. The ONE conversion every toll price
   * passes through, whatever mechanism charged it.
   *
   * This replaced a per-kilometre toll reluctance, and the replacement is the point. That constant
   * folded three separate things into one number: what a road charges, how it charges it, and what
   * time is worth. Only the last is a preference of ours; the other two are facts about each road
   * and live in `TOLL_ROADS`.
   */
  readonly secondsPerRupee: number;
  /**
   * Seconds charged per kilometre of `access=private` road. A PENALTY, never a ban.
   *
   * The graph has recorded `edgePrivate` since gate 1 and both `pipeline/graph/CLAUDE.md` and the
   * `Graph` interface described private roads as "routable, but only as a last resort". Nothing
   * read the flag: the snapper had an `excludePrivate` option nobody passed, and the search never
   * looked at it at all. A gated campus service road therefore cost exactly what a public road
   * cost, and a route drove 3.8 km down one.
   *
   * SAME CLASS OF DEFECT AS THE TOLL PLAZA DODGE: a manoeuvre free in the model and impossible on
   * the ground. A ban is the wrong fix, because a destination inside a gated campus must stay
   * reachable; what has to stop is a private road being used as a THROUGH route.
   */
  readonly privateSecondsPerKm?: number | undefined;
  /**
   * The toll table, one entry per road. Optional: the toy graphs have no toll roads and pass
   * nothing, which restores the behaviour this class had before tolls were priced at all.
   */
  readonly tollRoads?: readonly TollRoad[];
  /** Exclude tolled roads entirely unless a request overrides it. */
  readonly avoidTollsByDefault: boolean;
}

/**
 * Which rung of the routing ladder to run.
 *
 * NOT a quality knob. Every rung must return the IDENTICAL route, within 1e-6 on cost; they differ
 * only in how much of the graph they settle to find it. The option exists so the equality suite can
 * run two rungs over one graph and diff them, and so a regression can be bisected to a rung.
 *
 * `dijkstra-h-discarded` is a MEASUREMENT MODE and must never be served. It evaluates the A\*
 * heuristic and then throws the value away, searching exactly as Dijkstra does. That isolates the
 * two things A\* changes at once: against `dijkstra` it prices the heuristic's per-state cost, and
 * against `astar` it prices the pruning at equal per-state cost. Without it, "A\* settled 34% fewer
 * states and took 37% less time" cannot be read as evidence about the memory model, because the
 * per-state cost moved underneath the comparison.
 */
export type RoutingAlgorithm = 'dijkstra' | 'astar' | 'dijkstra-h-discarded' | 'bidirectional';

/** Per-request overrides of the objective. Everything omitted falls back to the config. */
export interface RouteOptions {
  /** Exclude tolled roads from the search entirely. A stated choice, never a hidden default. */
  readonly avoidTolls?: boolean;
  /** Defaults to `dijkstra`, the definition of correct in this package. */
  readonly algorithm?: RoutingAlgorithm;
}

export interface TurnCostConfig {
  readonly straightDeg: number;
  readonly turnS: number;
  readonly crossTrafficS: number;
  readonly crossMinDeg: number;
  readonly classDropS: number;
  readonly uTurnS: number;
  /** True where traffic drives on the left, so the turn that crosses oncoming traffic is a right. */
  readonly drivesOnLeft: boolean;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export type ManeuverType =
  | 'depart'
  | 'turn-left'
  | 'turn-right'
  | 'turn-slight-left'
  | 'turn-slight-right'
  | 'turn-sharp-left'
  | 'turn-sharp-right'
  | 'straight'
  | 'roundabout-enter'
  | 'roundabout-exit'
  | 'merge'
  | 'fork-left'
  | 'fork-right'
  | 'u-turn'
  | 'arrive';

export interface Instruction {
  readonly type: ManeuverType;
  /** Street name, when the way is named. Absent is normal and must render sensibly. */
  readonly roadName?: string;
  /** Distance from the previous maneuver to this one. */
  readonly distanceM: number;
  readonly durationS: number;
  /** Index into the route geometry where this maneuver occurs. */
  readonly geometryIndex: number;
  /** 1-based exit number. Only for roundabout-exit. */
  readonly roundaboutExit?: number;
}

/**
 * The gap between where a route physically ends and where the user actually asked to go.
 *
 * A destination is snapped to the nearest legal road, and presenting arrival there is a small lie
 * whenever the real place is set back from it: Dadri sits 43.9 m from a drivable road and Gautam
 * Buddha University is inside a gated campus behind `access=private` ways, so the route legitimately
 * stops at the gate.
 *
 * ⛔ THIS IS NOT PART OF THE DRIVEN ROUTE, and nothing may quietly fold it in. It is excluded from
 * `distanceM`, from `durationS`, and from `instructions`, because a driver cannot drive it and an
 * ETA that includes it is wrong. It is drawn as a DASHED STRAIGHT LINE, never a path: we have no
 * pedestrian routing and must not imply one by drawing something that looks routed.
 */
export interface Approach {
  /** Where the driving ends: the snapped point on the road. */
  readonly from: LngLat;
  /** Where the user actually asked to go. */
  readonly to: LngLat;
  /** Straight-line distance. Not a walking distance, and never presented as one. */
  readonly metres: number;
}

export interface Route {
  /**
   * Monotonically increasing per server process. The client discards anything that is not
   * the latest. Precision charter item 6.
   */
  readonly id: number;
  readonly cost: number;
  readonly distanceM: number;
  readonly durationS: number;
  /**
   * FULL-FIDELITY geometry from packed edge shapes, never vertex-to-vertex straight lines.
   * Precision charter item 1. Simplification beyond sub-pixel at max zoom is a defect.
   */
  readonly geometry: readonly LngLat[];
  readonly edgeIds: readonly number[];
  readonly instructions: readonly Instruction[];
  /**
   * Present only when the start point is further from its snapped road point than
   * `APPROACH_MIN_M`. Absent is the common case and must render as nothing at all.
   */
  readonly originApproach?: Approach;
  /** Present only when the destination is further from its snapped road point than the threshold. */
  readonly destinationApproach?: Approach;
  readonly profile: Profile;
  /**
   * What the driver pays in rupees, priced per road by that road's own exact mechanism.
   *
   * ⛔ NEVER RENDER THIS WITHOUT OBEYING `tollDisplay`. The number is always computed, because an
   * estimated price still has to steer the router, but whether it may be shown bare or must be
   * labelled an estimate is decided here and not in the view. A competitor estimates every toll
   * road and marks none of them; the difference is the label, so the label is part of the contract.
   *
   * NOT `tollSeconds / secondsPerRupee`. The search paid a smooth per-km proxy; this is the billed
   * truth over the chosen path. See `TollRoad.searchRatePerKm`.
   */
  readonly tollCost: number;
  /** The weakest link across every tolled road this route uses, ramp charges included. */
  readonly tollConfidence: TollConfidence;
  /** Whether, and how, `tollCost` may be shown. Derived from `tollConfidence`, never re-derived. */
  readonly tollDisplay: TollDisplay;
  /** Metres of this route on tolled roads. Non-zero whenever a toll element should appear at all. */
  readonly tollMetres: number;
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

export type PlaceKind =
  | 'place'
  | 'highway'
  | 'amenity'
  | 'shop'
  | 'leisure'
  | 'tourism'
  | 'office'
  | 'building'
  | 'railway';

export interface Place {
  readonly id: number;
  readonly name: string;
  readonly kind: PlaceKind;
  /** The raw OSM tag value, e.g. "village", "tertiary", "clinic". */
  readonly category: string;
  readonly point: LngLat;
  /** Higher ranks first. place > major POI > shop > road. */
  readonly importance: number;
}

export interface SearchHit extends Place {
  /** How the query matched. Used by tests to prove the fuzzy path actually ran. */
  readonly matchType: 'prefix' | 'fuzzy' | 'token';
  readonly score: number;
  readonly distanceM?: number;
}

// ---------------------------------------------------------------------------
// Errors. Every failure a user can cause has a designed, actionable shape.
// Precision charter item 10: no silent failure.
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'POINT_TOO_FAR_FROM_ROAD'
  | 'NO_ROUTE_FOUND'
  | 'OUTSIDE_BUILD_AREA'
  | 'INVALID_PARAMETER'
  | 'ARTIFACTS_NOT_BUILT';

export interface ApiError {
  readonly code: ErrorCode;
  /** User-facing. Must state a remedy, not just a fact. Governed by rules/copy.md. */
  readonly message: string;
  readonly detail?: Record<string, number | string>;
}

// ---------------------------------------------------------------------------
// Responses. Every one carries per-phase timings.
// ---------------------------------------------------------------------------

export interface Timing {
  readonly [phase: string]: number;
}

export interface RouteResponse {
  readonly route: Route;
  readonly timingMs: Timing;
}

export interface SnapResponse {
  readonly snap: SnapResult;
  readonly timingMs: Timing;
}

export interface SearchResponse {
  readonly hits: readonly SearchHit[];
  readonly timingMs: Timing;
}

/** Build provenance. Served by /health so a running server can be traced to its inputs. */
export interface BuildReport {
  readonly builtAt: string;
  readonly buildArea: BBox;
  readonly relationId: number;
  readonly extracts: readonly {
    readonly name: string;
    readonly md5: string;
    readonly bytes: number;
    readonly lastModified: string;
    readonly snapshotUrl: string;
    readonly archiveUrl: string;
  }[];
  readonly graph: {
    readonly vertices: number;
    readonly edges: number;
    readonly sccCoveragePct: number;
    readonly turnRestrictions: number;
    readonly kmByClass: Readonly<Record<string, number>>;
    readonly buildMs: number;
    readonly peakRssBytes: number;
    readonly bytesOnDisk: number;
  };
  /** Proof the two extracts were merged rather than concatenated. Zero here is a bug. */
  readonly dedupe: {
    readonly duplicateNodes: number;
    readonly duplicateWays: number;
    readonly duplicateRelations: number;
  };
  readonly places: { readonly count: number; readonly bytesOnDisk: number };
  readonly tiles: { readonly bytesOnDisk: number; readonly buildMs: number; readonly peakRssBytes: number };
}

// ---------------------------------------------------------------------------
// Live tracking. Precision charter items 3, 4, 5, 6 and 10.
// ---------------------------------------------------------------------------

/**
 * One position report, narrowed to the fields we actually use.
 *
 * `timestamp` IS THE CLOCK. Never `Date.now()`, never an assumed cadence. Measured under 4x CPU
 * throttle, a requested 100 ms interval fired at 188, 315, 253 and 117 ms, so anything that
 * dead-reckons from a nominal 1 Hz is correct on a laptop and wrong on the target phone.
 */
export interface Fix {
  readonly point: LngLat;
  /** The receiver's own 68% confidence radius, in metres. Displayed honestly, never hidden. */
  readonly accuracyM: number;
  /** Degrees clockwise from true north, or null when the receiver reports none. */
  readonly headingDeg: number | null;
  /** Metres per second, or null when the receiver reports none. */
  readonly speedMps: number | null;
  /** Epoch milliseconds, from the fix itself. */
  readonly timestamp: number;
}

/**
 * Why a fix was refused. Counted and surfaced rather than swallowed: a silently discarded fix
 * stream and a stationary vehicle look identical on screen, which is charter item 10.
 */
export type FixRejection =
  /** `accuracyM` worse than `TRACKING.maxAccuracyM`. */
  | 'accuracy'
  /** Travel since the previous accepted fix implies more than `TRACKING.maxImpliedSpeedKmh`. */
  | 'implied-speed'
  /** Timestamp at or before the previous accepted fix. Receivers do replay old samples. */
  | 'out-of-order';

/** Where the matcher believes the vehicle is, ON THE ROAD, never the raw fix. */
export interface MatchedPosition {
  /** The projected point on the road or route, never the input point. */
  readonly point: LngLat;
  /** Bearing of the road at the matched point, degrees from true north. */
  readonly bearingDeg: number;
  /** Metres from the raw fix to this point. The lateral error, reported rather than hidden. */
  readonly offsetM: number;
  /** Metres travelled along the active route. Measured from edge offsets, not accumulated. */
  readonly routeDistanceM: number;
  /** Index of the route geometry vertex at or before the match. */
  readonly geometryIndex: number;
}

/** What the navigator is doing. Drives which chrome renders and which copy applies. */
export type TrackingPhase =
  /** Not tracking. */
  | 'idle'
  /** Tracking asked for, no fix accepted yet. */
  | 'acquiring'
  /** Following an active route. */
  | 'navigating'
  /** Off the route beyond the threshold; a replacement has been requested. */
  | 'rerouting'
  /** Tracking with no active route. Matching runs server side over the spatial index. */
  | 'free-drive'
  /** Within arrival distance of the destination. */
  | 'arrived';

/**
 * How much the fix stream can be believed right now. Charter item 10: the UI must degrade
 * honestly rather than keep drawing a confident dot on stale data.
 */
export type GpsQuality =
  /** Fixes arriving and being accepted. */
  | 'good'
  /** Fixes arriving but accuracy is at the edge, or some are being rejected. */
  | 'poor'
  /** Nothing accepted for longer than the dropout window. */
  | 'lost'
  /** The browser refused the permission. A remedy, not a spinner. */
  | 'denied';

/** Progress along the active route. Every field derived from `routeDistanceM`, never per frame. */
export interface TrackingProgress {
  readonly remainingM: number;
  /** Seconds remaining, from the per-edge speed model over the remaining instructions. */
  readonly remainingS: number;
  /** Which instruction is current. Index into `Route.instructions`. */
  readonly instructionIndex: number;
  /** Metres from the matched position to the current instruction's maneuver point. */
  readonly metresToManeuver: number;
  /** Route geometry up to this index is behind the vehicle and renders as covered. */
  readonly coveredIndex: number;
}

/** Everything a view needs to render one animation frame. The engine's whole output. */
export interface TrackingSnapshot {
  readonly phase: TrackingPhase;
  readonly quality: GpsQuality;
  /** The ANIMATED position. Interpolated and eased, never the raw fix. Charter item 4. */
  readonly display: LngLat | null;
  /** Bearing the dot and the chase camera point along, eased. */
  readonly displayBearingDeg: number;
  /** Metres per second, smoothed. Drives the speed-based camera zoom. */
  readonly speedMps: number;
  /** Last accepted accuracy, in metres. Rendered as the accuracy circle, at true size. */
  readonly accuracyM: number;
  readonly matched: MatchedPosition | null;
  readonly progress: TrackingProgress | null;
  /** How long the vehicle has been continuously off-corridor, in ms. Drives the re-route. */
  readonly offRouteMs: number;
  /** Accepted and rejected counts, by reason. Surfaced in the dev panel and the browser gate. */
  readonly accepted: number;
  readonly rejected: Readonly<Record<FixRejection, number>>;
}

/**
 * FREE-DRIVE MATCHING, server side.
 *
 * Runs here rather than in the client because it needs the spatial index over 532,951 directed
 * edges, and `packages/CLAUDE.md` forbids the client importing `engine/` for exactly that reason.
 * On-route matching needs no graph, so it stays in the client where it costs no round trip.
 */
export interface MatchRequest {
  /** Most recent fixes, oldest first. The HMM needs a short history to judge transitions. */
  readonly fixes: readonly Fix[];
}

export interface MatchResult {
  readonly point: LngLat;
  readonly edgeId: number;
  readonly bearingDeg: number;
  readonly offsetM: number;
  /** Posterior probability of the winning candidate, 0..1. Below 0.5 the UI says so. */
  readonly probability: number;
  /** Name of the matched road, when it has one. */
  readonly roadName?: string | undefined;
}

export interface MatchResponse {
  /** Null when no candidate survived the heading gate. Not an error: it means "do not claim". */
  readonly match: MatchResult | null;
  readonly timingMs: Timing;
}

export const ROUTES = {
  route: '/route',
  snap: '/snap',
  search: '/search',
  match: '/match',
  health: '/health',
} as const;
