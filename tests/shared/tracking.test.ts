/**
 * The tracking engine, against synthetic traces with known ground truth. No browser, no graph.
 *
 * THE DIVIDED-ROAD FIXTURE IS THE POINT OF THIS FILE. `npm run calibrate:tracking` measured that
 * 71.9% of one-way samples in this city have an opposing carriageway inside `SNAP_TRACKING_M`, at
 * a median separation of 19.39 m. So the fixture below puts the two carriageways 20 m apart and
 * places the fix NEARER THE WRONG ONE. Every wrong-side test here carries the control that proves
 * the fixture is genuinely adversarial: with the heading gate disabled, the same fix matches the
 * wrong carriageway. Without that control, a passing test cannot tell a working gate from a
 * fixture where the wrong answer was never reachable.
 */
import { describe, expect, it } from 'vitest';
import { TRACKING } from '../../config/city.ts';
import { haversineM } from '../../packages/shared/geo.ts';
import {
  TrackingEngine,
  cumulativeMetres,
  headingOf,
  judgeFix,
  matchToRoute,
  progressOf,
} from '../../packages/shared/tracking.ts';
import type { Fix, Instruction, LngLat, Route } from '../../packages/shared/index.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_LAT = 28.4712;
const BASE_LON = 77.5031;
/** Degrees of latitude per metre at this latitude. Used to place the second carriageway exactly. */
const DEG_PER_M_LAT = 1 / 110_540;
/** The MEASURED median separation of real divided carriageways in this city. */
const CARRIAGEWAY_SEPARATION_M = 19.39;
const SOUTH_LAT = BASE_LAT - CARRIAGEWAY_SEPARATION_M * DEG_PER_M_LAT;

/**
 * A route that runs east on the north carriageway, crosses over, and returns west on the south
 * carriageway 19.39 m away. This is the shape that breaks a nearest-point matcher: the route
 * passes within metres of itself travelling the other way.
 */
const DIVIDED_ROUTE: readonly LngLat[] = [
  [BASE_LON, BASE_LAT],
  [BASE_LON + 0.005, BASE_LAT],
  [BASE_LON + 0.01, BASE_LAT],
  [BASE_LON + 0.01, SOUTH_LAT],
  [BASE_LON + 0.005, SOUTH_LAT],
  [BASE_LON, SOUTH_LAT],
];

/** A plain straight eastbound road, for tests that are not about carriageways. */
const STRAIGHT: readonly LngLat[] = [
  [BASE_LON, BASE_LAT],
  [BASE_LON + 0.005, BASE_LAT],
  [BASE_LON + 0.01, BASE_LAT],
];

function fix(partial: Partial<Fix> & { point: LngLat; timestamp: number }): Fix {
  return {
    accuracyM: 8,
    headingDeg: null,
    speedMps: 15,
    ...partial,
  };
}

function routeOf(geometry: readonly LngLat[], instructions: readonly Instruction[]): Route {
  const cum = cumulativeMetres(geometry);
  return {
    id: 1,
    cost: 0,
    distanceM: cum[cum.length - 1] as number,
    durationS: 0,
    geometry,
    edgeIds: [],
    instructions,
    profile: 'driving',
    tollCost: 0,
    tollConfidence: 'verified',
    tollDisplay: 'none',
    tollMetres: 0,
  };
}

// ---------------------------------------------------------------------------
// Fix filtering
// ---------------------------------------------------------------------------

describe('judgeFix rejects garbage, and names the right reason', () => {
  const first = fix({ point: [BASE_LON, BASE_LAT], timestamp: 1_000 });

  it('accepts a clean fix', () => {
    expect(judgeFix(null, first)).toEqual({ ok: true });
  });

  it('rejects accuracy worse than the ceiling, and the ceiling is the snap radius', () => {
    const bad = fix({ point: [BASE_LON, BASE_LAT], timestamp: 2_000, accuracyM: TRACKING.maxAccuracyM + 1 });
    expect(judgeFix(first, bad)).toEqual({ ok: false, reason: 'accuracy' });
    // CONTROL: exactly at the ceiling is accepted, so the test above is about the threshold and
    // not about the fix being malformed in some other way.
    const edge = fix({ point: [BASE_LON, BASE_LAT], timestamp: 2_000, accuracyM: TRACKING.maxAccuracyM });
    expect(judgeFix(first, edge)).toEqual({ ok: true });
  });

  it('rejects a NaN accuracy rather than letting it through a > comparison', () => {
    const nan = fix({ point: [BASE_LON, BASE_LAT], timestamp: 2_000, accuracyM: Number.NaN });
    expect(judgeFix(first, nan)).toEqual({ ok: false, reason: 'accuracy' });
  });

  it('rejects an implied speed above the ceiling', () => {
    // 1 km in 1 s is 3,600 km/h.
    const teleport = fix({ point: [BASE_LON + 0.0102, BASE_LAT], timestamp: 2_000 });
    expect(judgeFix(first, teleport)).toEqual({ ok: false, reason: 'implied-speed' });
    // CONTROL: the same displacement over enough time is legal, proving the rejection is about
    // speed rather than about the distance or the coordinates.
    const slow = fix({ point: [BASE_LON + 0.0102, BASE_LAT], timestamp: 1_000 + 60_000 });
    expect(judgeFix(first, slow)).toEqual({ ok: true });
  });

  /**
   * FOUND BY THE BROWSER GATE, NOT BY THIS FILE, which is why it is pinned here now.
   *
   * `npm run verify:browser` rejected 581 of 1,121 fixes on an ordinary 8 m noise drive. The
   * filter was comparing raw positions, so at the 96 ms interval in that trace a vehicle moving
   * 1.3 m was displaced about 11 m by noise and read as 420 km/h. Over half a normal drive was
   * being discarded and the dot froze.
   *
   * The unit tests missed it because every fixture here stepped at 250 ms or more. The scenario
   * that exposed it used the uneven intervals measured under 4x throttle, where the shortest gap
   * is 96 ms, which is exactly the case the cadence rule in this folder's CLAUDE.md warns about.
   */
  it('does NOT reject ordinary noise across a short interval', () => {
    const a = fix({ point: [BASE_LON, BASE_LAT], timestamp: 1_000, accuracyM: 8 });
    // 96 ms later, displaced 11 m: about 1.3 m of travel plus two 8 m fixes disagreeing.
    const elevenMetresLon = 11 / (111_320 * Math.cos((BASE_LAT * Math.PI) / 180));
    const b = fix({ point: [BASE_LON + elevenMetresLon, BASE_LAT], timestamp: 1_096, accuracyM: 8 });
    // The raw reading really is absurd, which is what makes this a real test and not a tautology.
    const rawKmh = (11 / 1000) / (0.096 / 3600);
    expect(rawKmh).toBeGreaterThan(400);
    expect(judgeFix(a, b)).toEqual({ ok: true });
  });

  it('still rejects a jump that is impossible EVEN allowing for the stated accuracy', () => {
    const a = fix({ point: [BASE_LON, BASE_LAT], timestamp: 1_000, accuracyM: 8 });
    // 500 m in 96 ms. Subtracting 16 m of combined uncertainty leaves 484 m, still 18,150 km/h.
    const farLon = 500 / (111_320 * Math.cos((BASE_LAT * Math.PI) / 180));
    const b = fix({ point: [BASE_LON + farLon, BASE_LAT], timestamp: 1_096, accuracyM: 8 });
    expect(judgeFix(a, b)).toEqual({ ok: false, reason: 'implied-speed' });
  });

  it('rejects an out-of-order fix BEFORE measuring implied speed', () => {
    // A replayed old sample far away would look like an impossible speed. The reason reported has
    // to be the real cause, or diagnosing a stream from rejection counts is misleading.
    const replay = fix({ point: [BASE_LON + 0.0102, BASE_LAT], timestamp: 500 });
    expect(judgeFix(first, replay)).toEqual({ ok: false, reason: 'out-of-order' });
  });

  it('rejects a repeated timestamp, which would divide by zero', () => {
    const same = fix({ point: [BASE_LON + 0.001, BASE_LAT], timestamp: 1_000 });
    expect(judgeFix(first, same)).toEqual({ ok: false, reason: 'out-of-order' });
  });
});

// ---------------------------------------------------------------------------
// Heading
// ---------------------------------------------------------------------------

describe('headingOf refuses to invent a heading', () => {
  it('prefers the receiver heading when moving', () => {
    const f = fix({ point: [BASE_LON, BASE_LAT], timestamp: 1_000, headingDeg: 87, speedMps: 12 });
    expect(headingOf([], f)).toBe(87);
  });

  it('ignores the receiver heading below the moving threshold', () => {
    const f = fix({
      point: [BASE_LON, BASE_LAT],
      timestamp: 1_000,
      headingDeg: 87,
      speedMps: TRACKING.headingMinSpeedMps - 0.1,
    });
    // No history to derive from either, so the honest answer is null.
    expect(headingOf([], f)).toBeNull();
  });

  it('returns null when the track is shorter than the noise window', () => {
    const a = fix({ point: [BASE_LON, BASE_LAT], timestamp: 1_000, speedMps: 0 });
    // 10 m of travel, under the 25 m window.
    const b = fix({ point: [BASE_LON + 0.0001, BASE_LAT], timestamp: 2_000, speedMps: 0 });
    expect(haversineM(BASE_LAT, BASE_LON, BASE_LAT, BASE_LON + 0.0001)).toBeLessThan(TRACKING.headingWindowM);
    expect(headingOf([a], b)).toBeNull();
  });

  it('derives a heading once the window is exceeded, and it points the right way', () => {
    const a = fix({ point: [BASE_LON, BASE_LAT], timestamp: 1_000, speedMps: 0 });
    const b = fix({ point: [BASE_LON + 0.0005, BASE_LAT], timestamp: 2_000, speedMps: 0 });
    expect(haversineM(BASE_LAT, BASE_LON, BASE_LAT, BASE_LON + 0.0005)).toBeGreaterThan(
      TRACKING.headingWindowM,
    );
    const h = headingOf([a], b);
    expect(h).not.toBeNull();
    expect(h as number).toBeCloseTo(90, 0); // due east
  });
});

// ---------------------------------------------------------------------------
// Wrong-side matching. Precision charter item 3.
// ---------------------------------------------------------------------------

describe('matchToRoute does not cross to the opposing carriageway', () => {
  const cum = cumulativeMetres(DIVIDED_ROUTE);
  // Placed between the two carriageways but NEARER THE WRONG ONE: 13.4 m from the eastbound leg
  // it is really on, 6.0 m from the westbound leg it must not match.
  const strayLat = BASE_LAT - 13.4 * DEG_PER_M_LAT;
  const stray = fix({ point: [BASE_LON + 0.005, strayLat], timestamp: 1_000 });

  it('the fixture is genuinely adversarial: the wrong leg IS nearer', () => {
    const toEast = haversineM(strayLat, BASE_LON + 0.005, BASE_LAT, BASE_LON + 0.005);
    const toWest = haversineM(strayLat, BASE_LON + 0.005, SOUTH_LAT, BASE_LON + 0.005);
    expect(toWest).toBeLessThan(toEast);
  });

  it('CONTROL: with no heading, the nearest-point rule picks the WRONG carriageway', () => {
    const m = matchToRoute(DIVIDED_ROUTE, cum, stray, {
      headingDeg: null,
      lastRouteDistanceM: null,
      windowM: 1e9,
    });
    expect(m).not.toBeNull();
    // The westbound return leg runs at bearing 270.
    expect((m as { bearingDeg: number }).bearingDeg).toBeCloseTo(270, 0);
  });

  it('with an eastbound heading it picks the correct carriageway despite being further', () => {
    const m = matchToRoute(DIVIDED_ROUTE, cum, stray, {
      headingDeg: 90,
      lastRouteDistanceM: null,
      windowM: 1e9,
    });
    expect(m).not.toBeNull();
    expect((m as { bearingDeg: number }).bearingDeg).toBeCloseTo(90, 0);
    // And it reports the real lateral error rather than hiding it.
    expect((m as { offsetM: number }).offsetM).toBeGreaterThan(12);
  });

  it('REFUSES rather than guessing when nothing survives the gate', () => {
    // Travelling due north, across both carriageways. Neither agrees within the gate.
    const m = matchToRoute(DIVIDED_ROUTE, cum, stray, {
      headingDeg: 0,
      lastRouteDistanceM: null,
      windowM: 1e9,
    });
    expect(m).toBeNull();
  });

  it('the gate is wide enough for ordinary curvature', () => {
    // 30 degrees off the segment bearing is normal inside a bend and must still match.
    const m = matchToRoute(DIVIDED_ROUTE, cum, stray, {
      headingDeg: 90 - 30,
      lastRouteDistanceM: null,
      windowM: 1e9,
    });
    expect(m).not.toBeNull();
    expect((m as { bearingDeg: number }).bearingDeg).toBeCloseTo(90, 0);
  });
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

describe('progressOf derives everything from distance along the route', () => {
  const instructions: readonly Instruction[] = [
    { type: 'depart', distanceM: 488, durationS: 60, geometryIndex: 1 },
    { type: 'turn-right', distanceM: 488, durationS: 60, geometryIndex: 2 },
    { type: 'arrive', distanceM: 0, durationS: 0, geometryIndex: 2 },
  ];
  const route = routeOf(STRAIGHT, instructions);
  const cum = cumulativeMetres(STRAIGHT);

  it('counts remaining distance from the total, not by accumulation', () => {
    const m = matchToRoute(STRAIGHT, cum, fix({ point: [BASE_LON + 0.005, BASE_LAT], timestamp: 1 }), {
      headingDeg: 90,
      lastRouteDistanceM: null,
      windowM: 1e9,
    });
    const p = progressOf(route, cum, m as NonNullable<typeof m>);
    const total = cum[cum.length - 1] as number;
    expect(p.remainingM).toBeCloseTo(total / 2, 0);
  });

  it('advances the instruction index as the vehicle passes each maneuver', () => {
    const atStart = matchToRoute(STRAIGHT, cum, fix({ point: [BASE_LON + 0.001, BASE_LAT], timestamp: 1 }), {
      headingDeg: 90,
      lastRouteDistanceM: null,
      windowM: 1e9,
    });
    const late = matchToRoute(STRAIGHT, cum, fix({ point: [BASE_LON + 0.009, BASE_LAT], timestamp: 2 }), {
      headingDeg: 90,
      lastRouteDistanceM: null,
      windowM: 1e9,
    });
    const early = progressOf(route, cum, atStart as NonNullable<typeof atStart>);
    const later = progressOf(route, cum, late as NonNullable<typeof late>);
    expect(later.instructionIndex).toBeGreaterThan(early.instructionIndex);
  });

  it('counts down to the maneuver, never up', () => {
    // Spans the WHOLE route, so the second instruction is genuinely reached. An earlier version
    // of this test only travelled as far as the first maneuver, so the branch it claimed to
    // check never ran; the guard at the end is what caught that.
    let previous = Infinity;
    let samples = 0;
    for (let i = 1; i <= 9; i++) {
      const m = matchToRoute(
        STRAIGHT,
        cum,
        fix({ point: [BASE_LON + i * 0.001, BASE_LAT], timestamp: i }),
        { headingDeg: 90, lastRouteDistanceM: null, windowM: 1e9 },
      );
      const p = progressOf(route, cum, m as NonNullable<typeof m>);
      if (p.instructionIndex === 1) {
        expect(p.metresToManeuver).toBeLessThanOrEqual(previous);
        previous = p.metresToManeuver;
        samples++;
      }
    }
    expect(samples).toBeGreaterThan(2); // the loop actually exercised the branch, more than once
  });

  it('never reports negative remaining distance past the end', () => {
    const past = matchToRoute(STRAIGHT, cum, fix({ point: [BASE_LON + 0.02, BASE_LAT], timestamp: 1 }), {
      headingDeg: 90,
      lastRouteDistanceM: null,
      windowM: 1e9,
    });
    const p = progressOf(route, cum, past as NonNullable<typeof past>);
    expect(p.remainingM).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// The engine, over traces with UNEVEN timestamps
// ---------------------------------------------------------------------------

/** Deliberately uneven, from the gate 0 measurement under 4x throttle: 188, 315, 253, 117 ms. */
const UNEVEN_MS = [188, 315, 253, 117, 402, 96, 271, 333, 149, 208];

/**
 * Degrees of longitude per metre at this latitude.
 *
 * TRACES MUST BE PHYSICALLY POSSIBLE. An earlier version of this file stepped a fixed 0.0004
 * degrees per tick, which over a 188 ms tick is 39 m, or 750 km/h. The engine correctly rejected
 * every one of those fixes for implied speed and the tests failed, which is the filter doing its
 * job against a fixture that could not happen. Positions here advance by speed times elapsed
 * time, so the trace describes a vehicle rather than a teleport.
 */
const DEG_PER_M_LON = 1 / (111_320 * Math.cos((BASE_LAT * Math.PI) / 180));
const CRUISE_MPS = 14; // about 50 km/h, an ordinary arterial speed here

describe('TrackingEngine over a clean eastbound drive', () => {
  const instructions: readonly Instruction[] = [
    { type: 'depart', distanceM: 488, durationS: 60, geometryIndex: 1 },
    { type: 'arrive', distanceM: 0, durationS: 0, geometryIndex: 2 },
  ];

  function driveEast(engine: TrackingEngine, steps: number): Fix[] {
    const fixes: Fix[] = [];
    let t = 1_000;
    let lon = BASE_LON;
    for (let i = 0; i < steps; i++) {
      const dt = UNEVEN_MS[i % UNEVEN_MS.length] as number;
      t += dt;
      lon += CRUISE_MPS * (dt / 1000) * DEG_PER_M_LON;
      const f = fix({ point: [lon, BASE_LAT], timestamp: t, headingDeg: 90, speedMps: CRUISE_MPS });
      fixes.push(f);
      engine.onFix(f);
      engine.frame(t, dt);
    }
    return fixes;
  }

  it('accepts every fix of a clean trace and reaches navigating', () => {
    const e = new TrackingEngine();
    e.start();
    e.setRoute(routeOf(STRAIGHT, instructions));
    const fixes = driveEast(e, 10);
    const snap = e.frame(fixes[fixes.length - 1]?.timestamp ?? 20_000, 16);
    expect(snap.accepted).toBe(10);
    expect(snap.rejected.accuracy).toBe(0);
    expect(snap.rejected['implied-speed']).toBe(0);
    expect(snap.rejected['out-of-order']).toBe(0);
    expect(['navigating', 'arrived']).toContain(snap.phase);
  });

  it('reports remaining distance that only ever decreases', () => {
    const e = new TrackingEngine();
    e.start();
    e.setRoute(routeOf(STRAIGHT, instructions));
    let previous = Infinity;
    let samples = 0;
    let t = 1_000;
    let lon = BASE_LON;
    for (let i = 0; i < 20; i++) {
      const dt = UNEVEN_MS[i % UNEVEN_MS.length] as number;
      t += dt;
      lon += CRUISE_MPS * (dt / 1000) * DEG_PER_M_LON;
      e.onFix(fix({ point: [lon, BASE_LAT], timestamp: t, headingDeg: 90, speedMps: CRUISE_MPS }));
      const s = e.frame(t, dt);
      if (s.progress !== null) {
        expect(s.progress.remainingM).toBeLessThanOrEqual(previous + 0.5);
        previous = s.progress.remainingM;
        samples++;
      }
    }
    expect(samples).toBeGreaterThan(10); // the assertion above actually ran
  });
});

describe('the display dot never teleports, charter item 4', () => {
  it('bounds the per-frame step even across an injected discontinuity', () => {
    const e = new TrackingEngine();
    e.start();
    e.setRoute(null); // free drive: the dot follows the fix directly, the hardest case for easing
    e.onFix(fix({ point: [BASE_LON, BASE_LAT], timestamp: 1_000 }));
    e.frame(1_000, 16);

    // A legal but large jump: 300 m in 10 s is 108 km/h, inside the implied-speed ceiling, so the
    // filter accepts it and the smoother is the only thing standing between it and a teleport.
    const jump = fix({ point: [BASE_LON + 0.00307, BASE_LAT], timestamp: 11_000 });
    expect(judgeFix(fix({ point: [BASE_LON, BASE_LAT], timestamp: 1_000 }), jump)).toEqual({ ok: true });
    e.onFix(jump);

    let previous = e.frame(11_000, 16).display as LngLat;
    let moved = 0;
    for (let i = 0; i < 400; i++) {
      const s = e.frame(11_000 + i * 16, 16);
      const now = s.display as LngLat;
      const step = haversineM(previous[1], previous[0], now[1], now[0]);
      expect(step).toBeLessThanOrEqual(TRACKING.maxDisplayStepM + 1e-6);
      moved += step;
      previous = now;
    }
    // CONTROL: the bound is not passing because the dot sat still. It really did travel.
    expect(moved).toBeGreaterThan(50);
  });

  it('places the dot on the first fix instead of easing in from nowhere', () => {
    const e = new TrackingEngine();
    e.start();
    e.setRoute(null);
    e.onFix(fix({ point: [BASE_LON, BASE_LAT], timestamp: 1_000 }));
    const s = e.frame(1_000, 16);
    expect(s.display).not.toBeNull();
    const d = s.display as LngLat;
    expect(haversineM(d[1], d[0], BASE_LAT, BASE_LON)).toBeLessThan(0.5);
  });
});

describe('off-route detection fires within the configured window', () => {
  const instructions: readonly Instruction[] = [
    { type: 'depart', distanceM: 976, durationS: 120, geometryIndex: 1 },
    { type: 'arrive', distanceM: 0, durationS: 0, geometryIndex: 2 },
  ];

  /**
   * Drives east on the route, then peels off to a lateral `offsetM` and holds there.
   *
   * The departure RAMPS at a plausible rate rather than jumping sideways: a 50 m lateral step in
   * one 250 ms tick is 200 m/s and the filter would rightly reject it, so a fixture built that
   * way would test nothing. Here each fix moves at most CRUISE_MPS times the elapsed time.
   *
   * `firedAtMs` is measured from the moment the offset first EXCEEDS the corridor, not from the
   * start of the peel-off, because that is the instant the dwell timer is specified to start.
   */
  function runDeparture(offsetM: number, holdMs: number): { fired: boolean; firedAtMs: number | null } {
    let fired = false;
    let firedAtMs: number | null = null;
    const e = new TrackingEngine({
      onReroute: () => {
        fired = true;
      },
    });
    e.start();
    e.setRoute(routeOf(STRAIGHT, instructions));

    const TICK = 250;
    const perTickM = CRUISE_MPS * (TICK / 1000); // 3.5 m of travel per tick
    let t = 1_000;
    let lon = BASE_LON;
    for (let i = 0; i < 6; i++) {
      t += TICK;
      lon += perTickM * DEG_PER_M_LON;
      e.onFix(fix({ point: [lon, BASE_LAT], timestamp: t, headingDeg: 90, speedMps: CRUISE_MPS }));
      e.frame(t, TICK);
    }

    let lateral = 0;
    let exceededAt: number | null = null;
    for (;;) {
      t += TICK;
      // Split the per-tick budget between forward and sideways so the total step stays legal.
      const sideways = Math.min(offsetM - lateral, perTickM * 0.9);
      lateral += Math.max(0, sideways);
      lon += perTickM * 0.4 * DEG_PER_M_LON;
      e.onFix(
        fix({
          point: [lon, BASE_LAT + lateral * DEG_PER_M_LAT],
          timestamp: t,
          headingDeg: 90,
          speedMps: CRUISE_MPS,
        }),
      );
      e.frame(t, TICK);
      if (exceededAt === null && lateral > TRACKING.offRouteM) exceededAt = t;
      if (fired && firedAtMs === null && exceededAt !== null) firedAtMs = t - exceededAt;
      const since = exceededAt === null ? 0 : t - exceededAt;
      if (exceededAt !== null && since > holdMs) break;
      // A corridor-hugging run never exceeds, so bound the loop by wall distance instead.
      if (exceededAt === null && t - 1_000 > holdMs + 60_000) break;
    }
    return { fired, firedAtMs };
  }

  it('does NOT fire for a departure shorter than the dwell time', () => {
    const r = runDeparture(TRACKING.offRouteM + 20, TRACKING.offRouteMs - 1_000);
    expect(r.fired).toBe(false);
  });

  it('fires once the departure is sustained past the dwell time', () => {
    const r = runDeparture(TRACKING.offRouteM + 20, TRACKING.offRouteMs + 2_000);
    expect(r.fired).toBe(true);
    expect(r.firedAtMs as number).toBeGreaterThanOrEqual(TRACKING.offRouteMs);
    // And not much later than the window: a re-route that arrives late is a re-route that missed.
    expect(r.firedAtMs as number).toBeLessThan(TRACKING.offRouteMs + 1_000);
  });

  it('CONTROL: does not fire at all while inside the corridor, however long the drive', () => {
    const r = runDeparture(TRACKING.offRouteM - 10, TRACKING.offRouteMs * 3);
    expect(r.fired).toBe(false);
  });

  it('fires only ONCE for one continuous departure', () => {
    let count = 0;
    const e = new TrackingEngine({ onReroute: () => { count++; } });
    e.start();
    e.setRoute(routeOf(STRAIGHT, instructions));
    // Starts already off-corridor and stays there. A re-route storm would show up as count > 1.
    const lat = BASE_LAT + (TRACKING.offRouteM + 30) * DEG_PER_M_LAT;
    let t = 1_000;
    let lon = BASE_LON;
    for (let i = 0; i < 60; i++) {
      t += 250;
      lon += CRUISE_MPS * 0.25 * DEG_PER_M_LON;
      e.onFix(fix({ point: [lon, lat], timestamp: t, headingDeg: 90, speedMps: CRUISE_MPS }));
      e.frame(t, 250);
    }
    expect(count).toBe(1);
  });
});

describe('quality degrades honestly, charter item 10', () => {
  it('reports lost before any fix arrives', () => {
    const e = new TrackingEngine();
    e.start();
    expect(e.frame(1_000, 16).quality).toBe('lost');
  });

  it('reports denied rather than poor when permission was refused', () => {
    const e = new TrackingEngine();
    e.start();
    e.onFix(fix({ point: [BASE_LON, BASE_LAT], timestamp: 1_000 }));
    e.setDenied();
    // Denied outranks everything: the remedy is completely different from a weak signal.
    expect(e.frame(1_000, 16).quality).toBe('denied');
  });

  it('reports lost after a dropout, even though a good fix was seen earlier', () => {
    const e = new TrackingEngine();
    e.start();
    e.onFix(fix({ point: [BASE_LON, BASE_LAT], timestamp: 1_000 }));
    expect(e.frame(1_000, 16).quality).toBe('good');
    expect(e.frame(30_000, 16).quality).toBe('lost');
  });

  it('reports poor when accuracy is at the edge of the accepted band', () => {
    const e = new TrackingEngine();
    e.start();
    e.onFix(
      fix({ point: [BASE_LON, BASE_LAT], timestamp: 1_000, accuracyM: TRACKING.maxAccuracyM - 1 }),
    );
    expect(e.frame(1_000, 16).quality).toBe('poor');
  });
});

describe('a rejected fix changes nothing', () => {
  it('does not become the baseline for the next implied-speed check', () => {
    const e = new TrackingEngine();
    e.start();
    e.setRoute(null);
    e.onFix(fix({ point: [BASE_LON, BASE_LAT], timestamp: 1_000 }));
    // A wild sample, rejected for accuracy.
    e.onFix(fix({ point: [BASE_LON + 0.5, BASE_LAT], timestamp: 2_000, accuracyM: 400 }));
    // The next good fix is a normal step from the LAST ACCEPTED one, so it must be accepted. If
    // the rejected fix had become the baseline, this would look like a 50 km jump backwards.
    const verdict = e.onFix(fix({ point: [BASE_LON + 0.0002, BASE_LAT], timestamp: 3_000 }));
    expect(verdict).toEqual({ ok: true });
    const s = e.frame(3_000, 16);
    expect(s.accepted).toBe(2);
    expect(s.rejected.accuracy).toBe(1);
  });
});
