/**
 * The frame loop and the fix sources. Everything about tracking that is genuinely browser shaped.
 *
 * TWO CHANNELS OUT, AND THE SPLIT IS A PERFORMANCE REQUIREMENT, not a style choice.
 *
 *   onFrame   fires every animation frame, drives the dot and the camera straight into MapLibre
 *   store     written only when COARSE state changes, which is what React re-renders on
 *
 * A store write per frame would re-render the whole rail at 60 Hz, and the target device is a
 * mid-range Android under 4x CPU throttle. The dot has to move every frame; the banner does not,
 * because it says the same words for a hundred frames at a time.
 *
 * NO CADENCE IS ASSUMED ANYWHERE. rAF is not 16.7 ms, and `setInterval(1000)` is not one second.
 * Measured at gate 0 under 4x throttle: a requested 100 ms interval fired at 188, 315, 253 and
 * 117 ms. Elapsed time is measured, never counted.
 */
import { TRACKING } from '@config/city.ts';
import { TrackingEngine } from '@wayfinder/shared/tracking.ts';
import type { Fix, LngLat, MatchResult, Route, TrackingSnapshot } from '@wayfinder/shared';
import { RouteSimulator, SIMULATOR_DEFAULTS } from './simulator.ts';
import type { SimulatorOptions } from './simulator.ts';

// Read once rather than through the config object on every frame, so the hot path carries no
// property lookups.
const ETA_MIN_INTERVAL_MS = TRACKING.etaMinIntervalMs;
const ETA_HYSTERESIS_S = TRACKING.etaHysteresisS;

/** Fixes sent to /match. Mirrors the cap the server applies, so nothing is sent to be discarded. */
const MATCH_WINDOW_FIXES = 12;
/** Minimum gap between /match calls, in ms. One per nominal fix is already more than enough. */
const MATCH_MIN_INTERVAL_MS = 1000;

export type FixSource = 'simulator' | 'device';

export interface CoarseState {
  readonly phase: TrackingSnapshot['phase'];
  readonly quality: TrackingSnapshot['quality'];
  readonly instructionIndex: number;
  /** Metres to the next maneuver, ROUNDED, so the banner does not rewrite every frame. */
  readonly metresToManeuver: number;
  readonly remainingM: number;
  /** Seconds remaining, already passed through the ETA hysteresis. */
  readonly remainingS: number;
  readonly accuracyM: number;
  readonly speedMps: number;
  readonly accepted: number;
  readonly rejectedTotal: number;
}

export interface ControllerHooks {
  /** Every frame. Keep this cheap: it runs at display rate. */
  readonly onFrame: (snapshot: TrackingSnapshot) => void;
  /** Only when a coarse field changes. Safe to write into the store. */
  readonly onCoarse: (state: CoarseState) => void;
  /** The engine wants a new route from here. */
  readonly onReroute: (from: LngLat, headingDeg: number | null) => void;
}

/**
 * Banner distances are rounded before they are compared, so a coarse update happens when the
 * DISPLAYED text would change rather than when the underlying float moves.
 */
function roundManeuver(m: number): number {
  if (m < 100) return Math.round(m / 10) * 10;
  if (m < 1000) return Math.round(m / 50) * 50;
  return Math.round(m / 100) * 100;
}

export class TrackingController {
  private engine: TrackingEngine;
  private simulator: RouteSimulator | null = null;
  private simOptions: SimulatorOptions = SIMULATOR_DEFAULTS;
  private simStartEpochMs = 0;
  private simElapsedMs = 0;
  private simTimer: ReturnType<typeof setTimeout> | null = null;
  private watchId: number | null = null;
  private raf: number | null = null;
  private lastFrameMs = 0;
  private coarse: CoarseState | null = null;
  /** The last ETA actually shown, in seconds. Hysteresis is applied against this, not the raw. */
  private shownRemainingS: number | null = null;
  private lastEtaAtMs = 0;
  private route: Route | null = null;
  private running = false;

  constructor(private readonly hooks: ControllerHooks) {
    this.engine = new TrackingEngine({ onReroute: hooks.onReroute });
  }

  get source(): FixSource | null {
    if (this.simulator !== null) return 'simulator';
    if (this.watchId !== null) return 'device';
    return null;
  }

  setRoute(route: Route | null): void {
    this.route = route;
    this.engine.setRoute(route);
    // A replacement route means a fresh simulated drive from its start, otherwise the synthetic
    // vehicle keeps driving the old line while the new one is on screen.
    if (this.simulator !== null && route !== null) {
      this.simulator = new RouteSimulator(route.geometry, this.simOptions);
      this.simElapsedMs = 0;
      this.simStartEpochMs = performance.timeOrigin + performance.now();
    }
  }

  setSimulatorOptions(patch: Partial<SimulatorOptions>): void {
    this.simOptions = { ...this.simOptions, ...patch };
    if (this.simulator !== null && this.route !== null) {
      // Rebuilt rather than mutated so the seeded stream restarts deterministically.
      const elapsed = this.simElapsedMs;
      this.simulator = new RouteSimulator(this.route.geometry, this.simOptions);
      this.simElapsedMs = elapsed;
    }
  }

  deviate(): void {
    this.simulator?.deviate();
  }

  rejoin(): void {
    this.simulator?.rejoin();
  }

  get deviating(): boolean {
    return this.simulator?.deviating ?? false;
  }

  start(source: FixSource): void {
    this.stop();
    this.engine = new TrackingEngine({ onReroute: this.hooks.onReroute });
    this.engine.start();
    this.engine.setRoute(this.route);
    this.shownRemainingS = null;
    this.running = true;

    if (source === 'simulator') {
      if (this.route === null) return;
      this.simulator = new RouteSimulator(this.route.geometry, this.simOptions);
      this.simElapsedMs = 0;
      this.simStartEpochMs = performance.timeOrigin + performance.now();
      this.scheduleSimFix();
    } else {
      if (!('geolocation' in navigator)) {
        this.engine.setDenied();
      } else {
        this.watchId = navigator.geolocation.watchPosition(
          (pos) => {
            const deviceFix: Fix = {
              point: [pos.coords.longitude, pos.coords.latitude],
              accuracyM: pos.coords.accuracy,
              headingDeg: pos.coords.heading,
              speedMps: pos.coords.speed,
              // The FIX's own timestamp, never Date.now(). The two disagree, and the fix is right.
              timestamp: pos.timestamp,
            };
            this.engine.onFix(deviceFix);
            // Feeds the free-drive window too, which is what makes /match work with no route.
            this.rememberForMatch(deviceFix);
          },
          () => {
            // Any error here is, from the user's point of view, "the browser will not give us a
            // position". Rendered with a remedy rather than as a spinner that never resolves.
            this.engine.setDenied();
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 },
        );
      }
    }
    this.lastFrameMs = performance.now();
    this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    if (this.simTimer !== null) clearTimeout(this.simTimer);
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.raf = null;
    this.simTimer = null;
    this.watchId = null;
    this.simulator = null;
    this.engine.stop();
    this.coarse = null;
  }

  /**
   * The synthetic fix stream.
   *
   * A CHAIN OF TIMEOUTS, NOT AN INTERVAL, and the elapsed time is MEASURED between them. An
   * interval on a throttled main thread drifts and coalesces; measuring means the simulated
   * vehicle travels the right distance even when the timer fires late, which is exactly the
   * condition the gate 0 measurement recorded.
   */
  private scheduleSimFix(): void {
    const nominalMs = 1000;
    const scheduledAt = performance.now();
    this.simTimer = setTimeout(() => {
      if (!this.running || this.simulator === null) return;
      const actualMs = performance.now() - scheduledAt;
      this.simElapsedMs += actualMs;
      const fix = this.simulator.fixAt(this.simElapsedMs, this.simStartEpochMs);
      // null is a dropout. Deliberately nothing happens: no repeat, no interpolation, no fix.
      if (fix !== null) this.engine.onFix(fix);
      this.scheduleSimFix();
    }, nominalMs);
  }

  /** Inject one fix directly. Used by the browser gate to drive a scripted scenario. */
  injectFix(fix: Fix): void {
    this.engine.onFix(fix);
    this.rememberForMatch(fix);
  }

  /**
   * FREE DRIVE. With no active route there is no polyline to project onto, so the road has to
   * come from the graph, which only the server holds.
   *
   * Deliberately rate limited rather than sent per fix. The matcher is an HMM over a window of
   * fixes, so consecutive calls would re-solve almost the same problem, and at 1 Hz the answer
   * cannot change faster than the window slides. Measured server side at 8 to 51 ms per call.
   *
   * SUPERSESSION, same as every other channel here: a monotonic sequence number plus an abort,
   * because the network is not ordered and a slow answer about where we were must never overwrite
   * a fast answer about where we are. Charter item 6.
   */
  private matchWindow: Fix[] = [];
  private matchSeq = 0;
  private matchAbort: AbortController | null = null;
  private lastMatchAtMs = 0;

  private rememberForMatch(fix: Fix): void {
    this.matchWindow.push(fix);
    if (this.matchWindow.length > MATCH_WINDOW_FIXES) this.matchWindow.shift();
    if (this.route !== null) return; // on-route matching needs no server
    const now = fix.timestamp;
    if (now - this.lastMatchAtMs < MATCH_MIN_INTERVAL_MS) return;
    this.lastMatchAtMs = now;
    void this.requestMatch();
  }

  private async requestMatch(): Promise<void> {
    const seq = ++this.matchSeq;
    this.matchAbort?.abort();
    const ctl = new AbortController();
    this.matchAbort = ctl;
    try {
      const res = await fetch('/match', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fixes: this.matchWindow }),
        signal: ctl.signal,
      });
      if (seq !== this.matchSeq || !res.ok) return;
      const body = (await res.json()) as { match: MatchResult | null };
      if (seq !== this.matchSeq) return;
      // A null match is the server declining to name a road, which is a real answer. The dot then
      // stays on the raw fix rather than being moved onto a road we cannot defend.
      if (body.match !== null) this.engine.setFreeDriveMatch(body.match.point, body.match.bearingDeg);
    } catch {
      // An abort is the expected outcome of fixes arriving quickly, not a failure to report, and
      // a network failure in free drive degrades to an unmatched dot rather than to an error.
    }
  }

  /**
   * SCRIPTED MODE, for `npm run verify:browser`.
   *
   * Starts the engine and the frame loop with NO FIX SOURCE. The gate supplies both the fixes and
   * the clock, so a scenario is a pure function of its trace and reruns identically. Anything
   * driven by `setTimeout` or rAF would assert against the scheduler instead, and the gate 0
   * measurement is exactly why that is not acceptable here: under 4x throttle a requested 100 ms
   * interval fired at 188, 315, 253 and 117 ms.
   */
  lastScriptedNowMs = 0;

  beginScripted(route: Route | null): void {
    this.stop();
    this.route = route;
    this.engine = new TrackingEngine({ onReroute: this.hooks.onReroute });
    this.engine.start();
    this.engine.setRoute(route);
    this.shownRemainingS = null;
    this.lastEtaAtMs = 0;
    this.coarse = null;
    this.running = true;
    this.lastScriptedNowMs = 0;
    this.matchWindow = [];
    this.lastMatchAtMs = 0;
    // No source, no rAF: `stepScripted` is the only thing that advances anything.
  }

  /** Advance the engine to an exact time and publish, exactly as the frame loop would. */
  stepScripted(nowMs: number, dtMs: number): TrackingSnapshot {
    this.lastScriptedNowMs = nowMs;
    const snapshot = this.engine.frame(nowMs, dtMs);
    this.hooks.onFrame(snapshot);
    this.publishCoarse(snapshot, nowMs);
    return snapshot;
  }

  private loop = (): void => {
    if (!this.running) return;
    const now = performance.now();
    const dt = now - this.lastFrameMs;
    this.lastFrameMs = now;

    const epochNow = performance.timeOrigin + now;
    const snapshot = this.engine.frame(epochNow, dt);
    this.hooks.onFrame(snapshot);
    this.publishCoarse(snapshot, epochNow);

    this.raf = requestAnimationFrame(this.loop);
  };

  /**
   * Push to the store only when the DISPLAYED value would change.
   *
   * The ETA carries two separate guards, both from `config/city.ts` and both charter item 5.
   * `etaMinIntervalMs` stops it recomputing more than once a second. `etaHysteresisS` stops it
   * moving at all for a change smaller than a driver could act on: the speed model is a class
   * default for 98.5% of ways, so an ETA quoted finer than half a minute asserts precision the
   * model does not have.
   */
  private publishCoarse(s: TrackingSnapshot, nowMs: number): void {
    const p = s.progress;
    let remainingS = this.shownRemainingS ?? p?.remainingS ?? 0;
    if (p !== null) {
      const dueForUpdate = nowMs - this.lastEtaAtMs >= ETA_MIN_INTERVAL_MS;
      const movedEnough =
        this.shownRemainingS === null || Math.abs(p.remainingS - this.shownRemainingS) >= ETA_HYSTERESIS_S;
      if (dueForUpdate && movedEnough) {
        remainingS = p.remainingS;
        this.shownRemainingS = remainingS;
        this.lastEtaAtMs = nowMs;
      }
    }

    const next: CoarseState = {
      phase: s.phase,
      quality: s.quality,
      instructionIndex: p?.instructionIndex ?? -1,
      metresToManeuver: roundManeuver(p?.metresToManeuver ?? 0),
      remainingM: Math.round((p?.remainingM ?? 0) / 10) * 10,
      remainingS: Math.round(remainingS),
      accuracyM: Math.round(s.accuracyM),
      speedMps: Math.round(s.speedMps),
      accepted: s.accepted,
      rejectedTotal: s.rejected.accuracy + s.rejected['implied-speed'] + s.rejected['out-of-order'],
    };

    const c = this.coarse;
    if (
      c !== null &&
      c.phase === next.phase &&
      c.quality === next.quality &&
      c.instructionIndex === next.instructionIndex &&
      c.metresToManeuver === next.metresToManeuver &&
      c.remainingM === next.remainingM &&
      c.remainingS === next.remainingS &&
      c.accuracyM === next.accuracyM &&
      c.speedMps === next.speedMps &&
      c.accepted === next.accepted &&
      c.rejectedTotal === next.rejectedTotal
    ) {
      return;
    }
    this.coarse = next;
    this.hooks.onCoarse(next);
  }
}
