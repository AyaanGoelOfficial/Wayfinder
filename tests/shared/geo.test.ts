/**
 * The canonical geometry primitives, against known truth.
 *
 * `bearingDeg` is pinned here because `packages/shared/geo.ts` says it is: two older private
 * copies live in the engine and are deliberately NOT refactored to use it, so this file is what
 * keeps the canonical one honest on its own terms.
 */
import { describe, expect, it } from 'vitest';
import { bearingDeg, bearingGap, haversineM, projectOntoSegment } from '../../packages/shared/geo.ts';

describe('bearingDeg, against directions that cannot be argued with', () => {
  // Due north from Pari Chowk. Same longitude, higher latitude.
  it('is 0 going due north', () => {
    expect(bearingDeg(28.4712, 77.5031, 28.4812, 77.5031)).toBeCloseTo(0, 6);
  });
  it('is 180 going due south', () => {
    expect(bearingDeg(28.4712, 77.5031, 28.4612, 77.5031)).toBeCloseTo(180, 6);
  });

  /**
   * DUE EAST IS NOT 90, AND THAT IS CORRECT. A great circle between two points at equal latitude
   * bows toward the pole, so the INITIAL bearing in the northern hemisphere is slightly less than
   * 90 and the final bearing slightly more. Measured here: 89.9976 over 980 m at this latitude.
   *
   * Asserted as a bounded bow rather than loosened to `toBeCloseTo(90, 2)`, because a loosened
   * tolerance would also pass if the function were subtly wrong in the other direction, and the
   * DIRECTION of the error is the part that says the maths is right.
   */
  it('is just SHORT of 90 going due east, because the great circle bows poleward', () => {
    const b = bearingDeg(28.4712, 77.5031, 28.4712, 77.5131);
    expect(b).toBeLessThan(90);
    expect(b).toBeGreaterThan(89.99);
  });
  it('is just PAST 270 going due west, the same bow mirrored', () => {
    const b = bearingDeg(28.4712, 77.5031, 28.4712, 77.4931);
    expect(b).toBeGreaterThan(270);
    expect(b).toBeLessThan(270.01);
  });
  it('the bow grows with distance, which is what proves it is the geometry and not an offset', () => {
    const near = 90 - bearingDeg(28.4712, 77.5031, 28.4712, 77.5081);
    const far = 90 - bearingDeg(28.4712, 77.5031, 28.4712, 77.6031);
    expect(far).toBeGreaterThan(near * 5);
  });
  it('always lands in [0, 360)', () => {
    for (let i = 0; i < 360; i += 7) {
      const r = (i * Math.PI) / 180;
      const b = bearingDeg(28.47, 77.5, 28.47 + 0.01 * Math.cos(r), 77.5 + 0.01 * Math.sin(r));
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(360);
    }
  });
});

describe('bearingGap wraps, which is the whole reason it exists', () => {
  it('treats 359 and 1 as 2 degrees apart, not 358', () => {
    expect(bearingGap(359, 1)).toBeCloseTo(2, 9);
  });
  it('is symmetric', () => {
    expect(bearingGap(10, 350)).toBeCloseTo(bearingGap(350, 10), 9);
  });
  it('caps at 180 for an exact reversal', () => {
    expect(bearingGap(0, 180)).toBeCloseTo(180, 9);
    expect(bearingGap(90, 270)).toBeCloseTo(180, 9);
  });
  it('never exceeds 180 for any pair', () => {
    for (let a = 0; a < 360; a += 13) {
      for (let b = 0; b < 360; b += 17) {
        expect(bearingGap(a, b)).toBeLessThanOrEqual(180 + 1e-9);
      }
    }
  });
});

describe('haversineM, against a distance that is independently checkable', () => {
  it('measures one degree of latitude as about 111.2 km', () => {
    // A degree of latitude is a meridian arc and does not depend on longitude.
    const d = haversineM(28.0, 77.5, 29.0, 77.5);
    expect(d).toBeGreaterThan(111_100);
    expect(d).toBeLessThan(111_300);
  });
  it('is zero for a point against itself', () => {
    expect(haversineM(28.4712, 77.5031, 28.4712, 77.5031)).toBeCloseTo(0, 9);
  });
  it('is symmetric', () => {
    const ab = haversineM(28.4712, 77.5031, 28.5556, 77.5527);
    const ba = haversineM(28.5556, 77.5527, 28.4712, 77.5031);
    expect(ab).toBeCloseTo(ba, 6);
  });
});

describe('projectOntoSegment', () => {
  const A: [number, number] = [28.4712, 77.5031];
  const B: [number, number] = [28.4712, 77.5131]; // due east of A

  it('puts the foot at the midpoint for a point square above the middle', () => {
    const mid = (77.5031 + 77.5131) / 2;
    const p = projectOntoSegment(28.4722, mid, A[0], A[1], B[0], B[1]);
    expect(p.t).toBeCloseTo(0.5, 2);
    // 0.001 degrees of latitude is about 111 m.
    expect(p.distanceM).toBeGreaterThan(100);
    expect(p.distanceM).toBeLessThan(120);
  });

  it('CLAMPS to the start when the foot falls before the segment', () => {
    const p = projectOntoSegment(28.4712, 77.4931, A[0], A[1], B[0], B[1]);
    expect(p.t).toBe(0);
    expect(p.lat).toBeCloseTo(A[0], 9);
    expect(p.lon).toBeCloseTo(A[1], 9);
  });

  it('CLAMPS to the end when the foot falls past the segment', () => {
    const p = projectOntoSegment(28.4712, 77.5231, A[0], A[1], B[0], B[1]);
    expect(p.t).toBe(1);
    expect(p.lon).toBeCloseTo(B[1], 9);
  });

  it('returns distance zero for a point already on the segment', () => {
    const p = projectOntoSegment(28.4712, 77.5081, A[0], A[1], B[0], B[1]);
    expect(p.distanceM).toBeLessThan(0.01);
  });

  it('does not divide by zero on a degenerate segment', () => {
    const p = projectOntoSegment(28.4722, 77.5031, A[0], A[1], A[0], A[1]);
    expect(Number.isFinite(p.distanceM)).toBe(true);
    expect(p.t).toBe(0);
  });
});
