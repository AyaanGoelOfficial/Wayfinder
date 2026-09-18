/**
 * THE ROUTE SIMULATOR. Replays a computed route as a synthetic fix stream.
 *
 * NOT DECORATION, AND NOT A DEMO. All tracking development and every tracking test run against
 * this; the phone is for final verification only. A navigator that can only be exercised by
 * driving a car is a navigator that never gets exercised, and the failure modes that matter,
 * noise, dropouts, and a deliberate wrong turn, are exactly the ones a real drive will not
 * reproduce on demand.
 *
 * TIME IS AN ARGUMENT, NEVER A CLOCK READ. `fixAt` is a pure function of elapsed milliseconds, so
 * a test can step it 188, 315, 253, 117 ms, the intervals actually measured under 4x CPU throttle,
 * and get a deterministic answer. The React layer supplies real elapsed time; nothing in here
 * assumes a cadence.
 *
 * SEEDED, so the same run produces the same trace. A change in a committed screenshot then means
 * a change in the tracking engine rather than a change in the dice.
 */
import type { Fix, LngLat } from '@wayfinder/shared';
import { haversineM } from '@wayfinder/shared/geo.ts';

/** Mulberry32, the same generator `scripts/validate-osrm.ts` uses, for the same reason. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulatorOptions {
  /** Metres per second along the route. */
  readonly speedMps: number;
  /**
   * Standard deviation of the injected position error, in metres.
   *
   * 8 m is the design point the tracking thresholds were derived against: it is roughly what a
   * phone reports in an Indian urban canyon, and `TRACKING.headingWindowM` is set so a bearing
   * derived over that window survives exactly this much noise.
   */
  readonly noiseSigmaM: number;
  /** Probability that any given fix is dropped entirely, simulating a lost lock. */
  readonly dropoutProbability: number;
  readonly seed: number;
}

export const SIMULATOR_DEFAULTS: SimulatorOptions = {
  speedMps: 14,
  noiseSigmaM: 8,
  dropoutProbability: 0,
  seed: 20260731,
};

const DEG_PER_M_LAT = 1 / 110_540;

/**
 * Ratio of the 95% confidence radius to sigma, for circular (Rayleigh) position error.
 * sqrt(-2 * ln(0.05)) = 2.4477. This is the number that converts the noise we inject into the
 * accuracy a spec-compliant receiver would report for it.
 */
const RAYLEIGH_95 = Math.sqrt(-2 * Math.log(0.05));

export class RouteSimulator {
  private readonly cum: number[] = [];
  private readonly random: () => number;
  /** Lateral offset in metres, applied on top of the route. The wrong-turn button drives this. */
  private deviationM = 0;
  private deviationRampMps = 0;
  private lastElapsedMs = 0;

  constructor(
    private readonly geometry: readonly LngLat[],
    private readonly opts: SimulatorOptions = SIMULATOR_DEFAULTS,
  ) {
    this.random = rng(opts.seed);
    this.cum.push(0);
    for (let i = 1; i < geometry.length; i++) {
      const a = geometry[i - 1] as LngLat;
      const b = geometry[i] as LngLat;
      this.cum.push((this.cum[i - 1] as number) + haversineM(a[1], a[0], b[1], b[0]));
    }
  }

  get totalM(): number {
    return this.cum[this.cum.length - 1] ?? 0;
  }

  distanceAt(elapsedMs: number): number {
    return (elapsedMs / 1000) * this.opts.speedMps;
  }

  finishedAt(elapsedMs: number): boolean {
    return this.distanceAt(elapsedMs) >= this.totalM;
  }

  /**
   * Start driving off the route, sideways, at a plausible rate.
   *
   * RAMPED, NOT TELEPORTED. A vehicle cannot step 50 m sideways between two fixes, and a
   * simulator that does so is rejected by the implied-speed filter, which would make the off-route
   * scenario test the filter instead of the off-route detector. The ramp is capped below the
   * driving speed so the total step stays physically possible.
   */
  deviate(): void {
    this.deviationRampMps = Math.min(6, this.opts.speedMps * 0.45);
  }

  rejoin(): void {
    this.deviationRampMps = 0;
    this.deviationM = 0;
  }

  get deviating(): boolean {
    return this.deviationRampMps > 0;
  }

  /**
   * The fix at `elapsedMs`, or null when this sample was dropped.
   *
   * A dropout returns null rather than a stale fix. The tracking engine then sees a gap and its
   * quality falls to `lost`, which is the honest thing to render. Repeating the last position
   * would draw a confident stationary dot on data we do not have, which is charter item 10.
   */
  fixAt(elapsedMs: number, startEpochMs: number): Fix | null {
    const dtS = Math.max(0, elapsedMs - this.lastElapsedMs) / 1000;
    this.lastElapsedMs = elapsedMs;
    this.deviationM += this.deviationRampMps * dtS;

    if (this.random() < this.opts.dropoutProbability) return null;

    const along = Math.min(this.distanceAt(elapsedMs), this.totalM);
    const { point, bearing } = this.pointAt(along);

    // Gaussian noise, Box-Muller. Applied in metres and converted, so the error is circular on the
    // ground rather than stretched by the longitude scale at this latitude.
    const u1 = Math.max(1e-9, this.random());
    const u2 = this.random();
    const mag = this.opts.noiseSigmaM * Math.sqrt(-2 * Math.log(u1));
    const noiseLatM = mag * Math.cos(2 * Math.PI * u2);
    const noiseLonM = mag * Math.sin(2 * Math.PI * u2);

    // The deviation is applied PERPENDICULAR to the direction of travel, which is what driving
    // off a road actually looks like. Adding it to latitude would be a departure that vanishes
    // whenever the route happens to run north.
    const perp = ((bearing + 90) * Math.PI) / 180;
    const devLatM = this.deviationM * Math.cos(perp);
    const devLonM = this.deviationM * Math.sin(perp);

    const lat = point[1] + (noiseLatM + devLatM) * DEG_PER_M_LAT;
    const metresPerDegLon = 111_320 * Math.cos((point[1] * Math.PI) / 180);
    const lon = point[0] + (noiseLonM + devLonM) / metresPerDegLon;

    return {
      point: [lon, lat],
      /**
       * THE 95% RADIUS, NOT SIGMA. The W3C Geolocation spec defines `accuracy` as the radius of a
       * 95% confidence circle, and everything downstream reads it that way: the fix filter
       * subtracts it before judging implied speed, and the accuracy ring is drawn at it.
       *
       * For circular Gaussian error the 95% radius is sigma * sqrt(-2 ln 0.05) = 2.448 sigma.
       * This used to report 1.2 sigma, which made the simulated receiver claim roughly twice the
       * precision it actually had. The browser gate caught the consequence rather than the cause:
       * 116 of 1,121 fixes on an ordinary noise drive were rejected as impossibly fast, because
       * the filter was allowed to subtract far less uncertainty than the trace really contained.
       */
      accuracyM: Math.round(this.opts.noiseSigmaM * RAYLEIGH_95),
      headingDeg: bearing,
      speedMps: this.opts.speedMps,
      timestamp: startEpochMs + elapsedMs,
    };
  }

  /** True position and direction of travel at `along` metres. The ground truth a test asserts on. */
  pointAt(along: number): { point: LngLat; bearing: number } {
    if (this.geometry.length === 0) return { point: [0, 0], bearing: 0 };
    if (this.geometry.length === 1) return { point: this.geometry[0] as LngLat, bearing: 0 };

    let i = 0;
    while (i < this.cum.length - 2 && (this.cum[i + 1] as number) < along) i++;
    const a = this.geometry[i] as LngLat;
    const b = this.geometry[i + 1] as LngLat;
    const segStart = this.cum[i] as number;
    const segLen = (this.cum[i + 1] as number) - segStart;
    const t = segLen === 0 ? 0 : Math.max(0, Math.min(1, (along - segStart) / segLen));
    const lon = a[0] + t * (b[0] - a[0]);
    const lat = a[1] + t * (b[1] - a[1]);

    const kx = Math.cos((lat * Math.PI) / 180);
    const bearing = ((Math.atan2((b[0] - a[0]) * kx, b[1] - a[1]) * 180) / Math.PI + 360) % 360;
    return { point: [lon, lat], bearing };
  }
}
