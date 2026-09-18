/**
 * THE TRACKING ENGINE. A function from a stream of position fixes to display state.
 *
 * WHY IT LIVES IN shared/ RATHER THAN engine/. The client runs it, and `packages/CLAUDE.md`
 * lets the client import `config/` and `shared/` and nothing else. That rule exists because the
 * engine holds hundreds of MB of typed arrays. On-route matching does not need any of them: the
 * route polyline is already in the client, so matching to it is pure geometry over data already
 * present, with no round trip and no network. Free-drive matching DOES need the spatial index,
 * so it is a server endpoint instead, in `engine/mapmatch.ts`.
 *
 * NO BROWSER ANYWHERE IN THIS FILE. No timers, no `Date.now()`, no rAF, no DOM. Time enters only
 * as fix timestamps and as an explicit `nowMs` argument, which is what makes the whole thing
 * testable against synthetic traces with known ground truth. The browser is where it is verified,
 * not where it lives.
 *
 * THE MATCHER IS HEADING FIRST, AND THAT IS A MEASUREMENT, NOT A PREFERENCE. `npm run
 * calibrate:tracking` reports that 71.9% of one-way road samples in this city have an opposing
 * carriageway inside `SNAP_TRACKING_M`, at a median separation of 19.39 m and 7.91 m at p5. No
 * consumer fix separates those by distance. Every one of those confusable pairs is opposed by at
 * least 150 degrees. So heading GATES the candidates and distance only ranks the survivors.
 * A nearest-point matcher would fail precision charter item 3 across most of the network.
 */
import { TRACKING } from '@config/city.ts';
import { bearingDeg, bearingGap, haversineM, projectOntoSegment } from './geo.ts';
import type {
  Fix,
  FixRejection,
  GpsQuality,
  Instruction,
  LngLat,
  MatchedPosition,
  Route,
  TrackingPhase,
  TrackingProgress,
  TrackingSnapshot,
} from './index.ts';

// ---------------------------------------------------------------------------
// Fix filtering
// ---------------------------------------------------------------------------

export type FixVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: FixRejection };

/**
 * Reject garbage before it reaches anything else.
 *
 * Order matters and is not arbitrary: out-of-order is checked FIRST because a replayed old fix
 * would otherwise be measured against a newer one and produce a nonsense implied speed, which
 * would then be reported as the wrong rejection reason. Diagnosing tracking from rejection
 * counts only works if the counts name the real cause.
 */
export function judgeFix(previous: Fix | null, fix: Fix): FixVerdict {
  if (previous !== null && fix.timestamp <= previous.timestamp) {
    return { ok: false, reason: 'out-of-order' };
  }
  if (!(fix.accuracyM <= TRACKING.maxAccuracyM)) {
    // Written as a failed <=, not as >, so a NaN accuracy is rejected rather than accepted.
    return { ok: false, reason: 'accuracy' };
  }
  if (previous !== null) {
    const dtS = (fix.timestamp - previous.timestamp) / 1000;
    const dM = haversineM(previous.point[1], previous.point[0], fix.point[1], fix.point[0]);
    /**
     * THE UNCERTAINTY IS SUBTRACTED BEFORE THE SPEED IS COMPUTED, and that is not a softening.
     *
     * A fix is impossible only if it is impossible ALLOWING FOR THE ERROR THE RECEIVER ITSELF
     * DECLARED. Two fixes each accurate to 8 m can sit 16 m apart while the vehicle never moved,
     * so the smallest travel consistent with the pair is `d - (a1 + a2)`, and anything at or below
     * zero is consistent with standing still.
     *
     * MEASURED, NOT REASONED. Comparing raw positions rejected 581 of 1,121 fixes on the browser
     * gate's noise scenario. At the 96 ms interval in that trace a vehicle at 14 m/s travels 1.3 m
     * while 8 m noise displaces it by around 11 m, which reads as 420 km/h. The filter was
     * discarding over half of a perfectly ordinary noisy drive, and the dot froze because of it.
     * The ceiling itself is untouched at 150 km/h.
     */
    const uncertaintyM = fix.accuracyM + previous.accuracyM;
    const travelledM = Math.max(0, dM - uncertaintyM);
    const kmh = dtS <= 0 ? Infinity : travelledM / 1000 / (dtS / 3600);
    if (kmh > TRACKING.maxImpliedSpeedKmh) return { ok: false, reason: 'implied-speed' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Heading
// ---------------------------------------------------------------------------

/**
 * The direction of travel, or null when there is not enough evidence for one.
 *
 * TWO SOURCES, AND A REFUSAL. The receiver's own heading is Doppler-derived and preferred when it
 * reports one and the vehicle is moving. Otherwise a bearing is derived from the track, but only
 * once `TRACKING.headingWindowM` of displacement has accumulated: at the 8 m noise the simulator
 * injects, a shorter baseline lets position noise masquerade as a turn, and a spurious turn is
 * exactly what flips a match to the opposite carriageway.
 *
 * Returning null is a real answer and callers must honour it. A stopped vehicle has no heading,
 * and inventing one is how a stationary car at a divided-road junction gets matched across the
 * median.
 */
export function headingOf(history: readonly Fix[], fix: Fix): number | null {
  const moving = fix.speedMps !== null && fix.speedMps >= TRACKING.headingMinSpeedMps;
  if (moving && fix.headingDeg !== null && Number.isFinite(fix.headingDeg)) return fix.headingDeg;

  // Walk back until the baseline is long enough to out-argue the noise.
  for (let i = history.length - 1; i >= 0; i--) {
    const older = history[i] as Fix;
    const d = haversineM(older.point[1], older.point[0], fix.point[1], fix.point[0]);
    if (d >= TRACKING.headingWindowM) {
      return bearingDeg(older.point[1], older.point[0], fix.point[1], fix.point[0]);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cumulative route geometry
// ---------------------------------------------------------------------------

/**
 * Distance from the route start to each geometry vertex, in metres.
 *
 * Computed ONCE per route and carried, never accumulated per frame. Charter item 8 names this
 * directly: a per-frame running total drifts, and the drift shows up as an ETA that disagrees
 * with the drawn line by the end of a long trip.
 */
export function cumulativeMetres(geometry: readonly LngLat[]): Float64Array {
  const cum = new Float64Array(geometry.length);
  for (let i = 1; i < geometry.length; i++) {
    const a = geometry[i - 1] as LngLat;
    const b = geometry[i] as LngLat;
    cum[i] = (cum[i - 1] as number) + haversineM(a[1], a[0], b[1], b[0]);
  }
  return cum;
}

// ---------------------------------------------------------------------------
// On-route matching
// ---------------------------------------------------------------------------

export interface RouteMatchOptions {
  /** Direction of travel, or null when unknown. Null disables the heading gate. */
  readonly headingDeg: number | null;
  /**
   * Where along the route the vehicle was last seen, in metres. Restricts the search to a window
   * around it so a route that doubles back on itself cannot match the wrong pass.
   */
  readonly lastRouteDistanceM: number | null;
  /** How far forward and back of `lastRouteDistanceM` to look, in metres. */
  readonly windowM: number;
}

/**
 * Project a fix onto the active route.
 *
 * THE HEADING GATE RUNS FIRST AND IS NOT A TIEBREAK. Segments whose bearing disagrees with travel
 * by more than `TRACKING.headingAgreementDeg` are removed from consideration entirely, before any
 * distance is compared. On a divided road the route occupies one carriageway and the opposing one
 * is 19 m away at the median, so a nearest-point rule picks the wrong side whenever the lateral
 * error exceeds half the separation. It is the gate, not the ranking, that prevents that.
 *
 * Returns null when nothing survives the gate. That is a refusal to claim, not a failure: the
 * caller holds the previous match rather than jumping to a road it cannot justify.
 */
export function matchToRoute(
  geometry: readonly LngLat[],
  cum: Float64Array,
  fix: Fix,
  opts: RouteMatchOptions,
): MatchedPosition | null {
  if (geometry.length < 2) return null;

  let lo = 0;
  let hi = geometry.length - 1;
  if (opts.lastRouteDistanceM !== null) {
    const from = opts.lastRouteDistanceM - opts.windowM;
    const to = opts.lastRouteDistanceM + opts.windowM;
    while (lo < geometry.length - 1 && (cum[lo + 1] as number) < from) lo++;
    while (hi > lo + 1 && (cum[hi - 1] as number) > to) hi--;
  }

  let best: MatchedPosition | null = null;
  let bestOffset = Infinity;
  for (let i = lo; i < hi; i++) {
    const a = geometry[i] as LngLat;
    const b = geometry[i + 1] as LngLat;
    const segBearing = bearingDeg(a[1], a[0], b[1], b[0]);
    if (opts.headingDeg !== null && bearingGap(segBearing, opts.headingDeg) > TRACKING.headingAgreementDeg) {
      continue; // THE GATE. Wrong direction of travel, so this segment is not a candidate at all.
    }
    const p = projectOntoSegment(fix.point[1], fix.point[0], a[1], a[0], b[1], b[0]);
    if (p.distanceM >= bestOffset) continue;
    bestOffset = p.distanceM;
    const segLen = (cum[i + 1] as number) - (cum[i] as number);
    best = {
      point: [p.lon, p.lat],
      bearingDeg: segBearing,
      offsetM: p.distanceM,
      routeDistanceM: (cum[i] as number) + p.t * segLen,
      geometryIndex: i,
    };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * Where the vehicle is in the instruction list, and what is left.
 *
 * EVERY FIELD DERIVES FROM `routeDistanceM`. Nothing here counts fixes, integrates speed, or
 * accumulates per frame, which is what keeps the banner, the covered line and the ETA consistent
 * with each other and with the drawn geometry. Charter item 8.
 */
export function progressOf(
  route: Route,
  cum: Float64Array,
  matched: MatchedPosition,
): TrackingProgress {
  const totalM = cum[cum.length - 1] as number;
  const remainingM = Math.max(0, totalM - matched.routeDistanceM);

  // Distance at which each instruction's maneuver happens, from its geometry index.
  let instructionIndex = route.instructions.length - 1;
  let maneuverAtM = totalM;
  for (let i = 0; i < route.instructions.length; i++) {
    const at = cum[Math.min(cum.length - 1, (route.instructions[i] as Instruction).geometryIndex)] as number;
    // The CURRENT instruction is the first whose maneuver is still ahead of us.
    if (at >= matched.routeDistanceM - 1e-6) {
      instructionIndex = i;
      maneuverAtM = at;
      break;
    }
  }

  // Remaining seconds from the instruction legs still ahead, plus the unfinished part of the
  // current one. `Route.durationS` is the modelled COST and is not a duration, so it is not used.
  let remainingS = 0;
  for (let i = instructionIndex + 1; i < route.instructions.length; i++) {
    remainingS += (route.instructions[i] as Instruction).durationS;
  }
  const current = route.instructions[instructionIndex] as Instruction | undefined;
  if (current !== undefined && current.distanceM > 0) {
    const fractionLeft = Math.max(0, Math.min(1, (maneuverAtM - matched.routeDistanceM) / current.distanceM));
    remainingS += current.durationS * fractionLeft;
  }

  return {
    remainingM,
    remainingS,
    instructionIndex,
    metresToManeuver: Math.max(0, maneuverAtM - matched.routeDistanceM),
    coveredIndex: matched.geometryIndex,
  };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface TrackingEngineOptions {
  /** Fired when the vehicle has been off-corridor for longer than `TRACKING.offRouteMs`. */
  readonly onReroute?: ((from: LngLat, headingDeg: number | null) => void) | undefined;
  /** Distance to the destination, in metres, at which the trip counts as finished. */
  readonly arriveWithinM?: number | undefined;
}

const DEFAULT_ARRIVE_WITHIN_M = 25;
/** No accepted fix for this long and the dot stops claiming to know where it is. */
const DROPOUT_MS = 5000;
/** Half-width of the along-route search window, in metres. Wide enough to absorb a dropout. */
const MATCH_WINDOW_M = 250;
/** Fixes kept for heading derivation. At 1 Hz this is 15 s, far more than the window needs. */
const HISTORY = 15;

/**
 * Stream of fixes in, display state out.
 *
 * The instance holds only what a stream genuinely requires: the last accepted fix, a short
 * history for heading, the eased display position, and the off-route timer. Everything else is
 * recomputed, because state that could have been derived is state that can disagree with itself.
 */
export class TrackingEngine {
  private route: Route | null = null;
  private cum: Float64Array = new Float64Array(0);
  private history: Fix[] = [];
  private lastFix: Fix | null = null;
  private matched: MatchedPosition | null = null;

  /** The animated position. Charter item 4: it is eased toward `matched`, never assigned it. */
  private display: LngLat | null = null;
  private displayBearing = 0;
  private smoothedSpeed = 0;

  private offRouteSinceMs: number | null = null;
  private rerouteRequested = false;
  private phase: TrackingPhase = 'idle';
  private denied = false;

  private accepted = 0;
  private readonly rejected: Record<FixRejection, number> = {
    accuracy: 0,
    'implied-speed': 0,
    'out-of-order': 0,
  };

  constructor(private readonly opts: TrackingEngineOptions = {}) {}

  /**
   * Adopt a route, or drop to free drive with null.
   *
   * Deliberately resets the off-route timer and the re-route latch: a freshly delivered route
   * means the deviation that caused it is answered. Leaving the latch set is how a single wrong
   * turn produces a re-route storm.
   */
  setRoute(route: Route | null): void {
    this.route = route;
    this.cum = route === null ? new Float64Array(0) : cumulativeMetres(route.geometry);
    this.matched = null;
    this.offRouteSinceMs = null;
    this.rerouteRequested = false;
    if (this.phase !== 'idle') this.phase = route === null ? 'free-drive' : 'navigating';
  }

  /** The browser refused permission. A state with a remedy, not a silent stall. */
  setDenied(): void {
    this.denied = true;
    this.phase = 'idle';
  }

  start(): void {
    this.denied = false;
    this.phase = 'acquiring';
  }

  stop(): void {
    this.phase = 'idle';
    this.display = null;
    this.matched = null;
    this.history = [];
    this.lastFix = null;
  }

  /**
   * Take one fix. Returns whether it was accepted, so a caller can react to the reason.
   *
   * A REJECTED FIX CHANGES NOTHING. It does not move the dot, does not advance the off-route
   * timer, and does not become the baseline for the next implied-speed check. Letting a rejected
   * fix set the baseline would make one wild sample reject the good fix that follows it.
   */
  onFix(fix: Fix): FixVerdict {
    const verdict = judgeFix(this.lastFix, fix);
    if (!verdict.ok) {
      this.rejected[verdict.reason]++;
      return verdict;
    }
    this.accepted++;

    const heading = headingOf(this.history, fix);
    this.history.push(fix);
    if (this.history.length > HISTORY) this.history.shift();
    this.lastFix = fix;

    if (fix.speedMps !== null && Number.isFinite(fix.speedMps)) {
      // Eased so the camera zoom does not pump on a noisy speed channel.
      this.smoothedSpeed = this.smoothedSpeed === 0 ? fix.speedMps : this.smoothedSpeed * 0.7 + fix.speedMps * 0.3;
    }

    if (this.route !== null) {
      const m = matchToRoute(this.route.geometry, this.cum, fix, {
        headingDeg: heading,
        lastRouteDistanceM: this.matched?.routeDistanceM ?? null,
        windowM: MATCH_WINDOW_M,
      });
      // Null means nothing survived the heading gate. Hold the previous match rather than
      // claiming a road we cannot justify.
      if (m !== null) {
        this.matched = m;
        this.judgeCorridor(m, fix);
      }
      if (this.phase === 'acquiring' && this.matched !== null) this.phase = 'navigating';
      if (this.matched !== null && this.arrived()) this.phase = 'arrived';
    } else if (this.phase === 'acquiring') {
      this.phase = 'free-drive';
    }

    if (this.display === null) {
      // First accepted fix: place the dot rather than easing it in from nowhere.
      this.display = this.matched?.point ?? fix.point;
      this.displayBearing = this.matched?.bearingDeg ?? heading ?? 0;
    }
    return verdict;
  }

  /** Adopt a server-side free-drive match. Kept separate: it arrives asynchronously. */
  setFreeDriveMatch(point: LngLat, roadBearingDeg: number): void {
    this.matched = {
      point,
      bearingDeg: roadBearingDeg,
      offsetM: this.lastFix === null ? 0 : haversineM(this.lastFix.point[1], this.lastFix.point[0], point[1], point[0]),
      routeDistanceM: 0,
      geometryIndex: 0,
    };
  }

  private arrived(): boolean {
    if (this.route === null || this.matched === null) return false;
    const total = this.cum[this.cum.length - 1] as number;
    const within = this.opts.arriveWithinM ?? DEFAULT_ARRIVE_WITHIN_M;
    return total - this.matched.routeDistanceM <= within;
  }

  /**
   * Off-route detection, with the dwell time the config derives.
   *
   * Deliberately requires the departure to be SUSTAINED. One fix beyond the corridor is common
   * near a junction where the route geometry cuts a corner; three seconds of it is a driver who
   * has actually gone somewhere else.
   */
  private judgeCorridor(m: MatchedPosition, fix: Fix): void {
    if (m.offsetM > TRACKING.offRouteM) {
      if (this.offRouteSinceMs === null) this.offRouteSinceMs = fix.timestamp;
      const dwell = fix.timestamp - this.offRouteSinceMs;
      if (dwell >= TRACKING.offRouteMs && !this.rerouteRequested) {
        this.rerouteRequested = true;
        this.phase = 'rerouting';
        this.opts.onReroute?.(fix.point, headingOf(this.history, fix));
      }
    } else {
      this.offRouteSinceMs = null;
      this.rerouteRequested = false;
      if (this.phase === 'rerouting') this.phase = 'navigating';
    }
  }

  /**
   * Advance the animation to `nowMs` and return what to draw.
   *
   * `nowMs` IS AN ARGUMENT, not a clock read. That is the single decision that makes the whole
   * engine testable without a browser and immune to the timer unreliability measured at gate 0,
   * where a requested 100 ms interval fired at 188, 315, 253 and 117 ms under 4x throttle.
   *
   * The step is bounded by `TRACKING.maxDisplayStepM` per frame, which is the assertion the
   * simulator tests. Charter item 4: the dot eases, it never teleports.
   */
  frame(nowMs: number, dtMs: number): TrackingSnapshot {
    const target = this.matched?.point ?? this.lastFix?.point ?? null;
    if (target !== null && this.display !== null) {
      // Exponential ease toward the target, expressed against elapsed time rather than frames so
      // a dropped frame does not slow the correction down.
      const alpha = 1 - Math.exp(-Math.max(0, dtMs) / TRACKING.smoothingTauMs);
      const dLat = (target[1] - this.display[1]) * alpha;
      const dLon = (target[0] - this.display[0]) * alpha;
      let nextLat = this.display[1] + dLat;
      let nextLon = this.display[0] + dLon;

      const step = haversineM(this.display[1], this.display[0], nextLat, nextLon);
      if (step > TRACKING.maxDisplayStepM) {
        const k = TRACKING.maxDisplayStepM / step;
        nextLat = this.display[1] + dLat * k;
        nextLon = this.display[0] + dLon * k;
      }
      this.display = [nextLon, nextLat];

      const targetBearing = this.matched?.bearingDeg ?? this.displayBearing;
      // Rotate the short way round, so 350 to 10 goes forward through north rather than backward.
      let delta = ((targetBearing - this.displayBearing + 540) % 360) - 180;
      this.displayBearing = (this.displayBearing + delta * alpha + 360) % 360;
    }

    return {
      phase: this.phase,
      quality: this.qualityAt(nowMs),
      display: this.display,
      displayBearingDeg: this.displayBearing,
      speedMps: this.smoothedSpeed,
      accuracyM: this.lastFix?.accuracyM ?? 0,
      matched: this.matched,
      progress:
        this.route === null || this.matched === null ? null : progressOf(this.route, this.cum, this.matched),
      offRouteMs: this.offRouteSinceMs === null ? 0 : Math.max(0, nowMs - this.offRouteSinceMs),
      accepted: this.accepted,
      rejected: { ...this.rejected },
    };
  }

  /**
   * How much the stream can be believed. Charter item 10.
   *
   * `denied` outranks everything: a refused permission is not a poor signal and must not render
   * as one, because the remedy is completely different.
   */
  private qualityAt(nowMs: number): GpsQuality {
    if (this.denied) return 'denied';
    if (this.lastFix === null) return 'lost';
    if (nowMs - this.lastFix.timestamp > DROPOUT_MS) return 'lost';
    // At the edge of the accepted band, or matching further from the road than the corridor.
    if (this.lastFix.accuracyM > TRACKING.maxAccuracyM / 2) return 'poor';
    if (this.matched !== null && this.matched.offsetM > TRACKING.offRouteM) return 'poor';
    return 'good';
  }
}
