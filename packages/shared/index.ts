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
  readonly profile: Profile;
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

export const ROUTES = {
  route: '/route',
  snap: '/snap',
  search: '/search',
  health: '/health',
} as const;
