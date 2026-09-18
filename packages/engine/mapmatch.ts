/**
 * FREE-DRIVE MAP MATCHING. Which road is the vehicle on, when there is no route to project onto?
 *
 * WHY THIS IS A SEPARATE MECHANISM FROM ON-ROUTE MATCHING. With an active route the answer is a
 * projection onto a polyline the client already holds, so it costs no graph and no round trip and
 * lives in `shared/tracking.ts`. With no route the candidate set is the whole network, which means
 * the spatial index, which means 532,951 directed edges that `packages/CLAUDE.md` forbids reaching
 * a browser bundle. So this runs server side behind `/match`.
 *
 * A HIDDEN MARKOV MODEL, and a small one on purpose:
 *
 *   emission    how well a candidate edge explains the observed position, from the distance
 *               between them against the receiver's own stated accuracy
 *   transition  how plausible it is to have moved from the previous candidate to this one,
 *               comparing the on-road distance against the straight-line distance
 *
 * THE HEADING GATE COMES FIRST AND IS NOT PART OF THE PROBABILITY. It is a hard filter, applied
 * before any score is computed, because the measurement says it has to be. `npm run
 * calibrate:tracking`: 71.9% of one-way samples in this city have an opposing carriageway inside
 * `SNAP_TRACKING_M`, at a median separation of 19.39 m and 7.91 m at p5, and every confusable pair
 * is opposed by at least 150 degrees. Folding heading into a score as one term among several means
 * a slightly closer wrong carriageway can outvote it. A gate cannot be outvoted.
 *
 * NO IO, per `packages/CLAUDE.md`. Typed arrays in, plain data out, testable on a toy graph.
 */
import { TRACKING } from '@config/city.ts';
import { SNAP_TRACKING_M } from '@config/city.ts';
import { bearingDeg, bearingGap, haversineM } from '@wayfinder/shared/geo.ts';
import type { Fix, LngLat, MatchResult } from '@wayfinder/shared';
import type { SnapIndex } from './snap.ts';

/** The subset of the graph this matcher reads. Narrow on purpose: it is all that is needed. */
export interface MatchGraph {
  readonly edgeShape: Int32Array;
  readonly edgeReversed: Uint8Array;
  readonly edgeNameId: Int32Array;
  readonly shapeOffset: Int32Array;
  readonly shapeLat: Int32Array;
  readonly shapeLon: Int32Array;
}

const COORD_SCALE = 1e7;

/**
 * Bearing of travel along a directed edge at the point nearest `at`.
 *
 * REVERSAL MATTERS AND IS THE WHOLE POINT. Two directed edges share one shape run, and the
 * reversed one is travelled the other way. Reading the shape in stored order for both would give
 * both directions the same bearing, and the heading gate would then admit the wrong carriageway
 * on every two-way street, which is the exact defect this file exists to prevent.
 */
export function edgeBearingAt(g: MatchGraph, edgeId: number, at: LngLat): number {
  const s = g.edgeShape[edgeId] as number;
  const from = g.shapeOffset[s] as number;
  const to = g.shapeOffset[s + 1] as number;
  if (to - from < 2) return 0;

  let bestI = from;
  let bestD = Infinity;
  for (let i = from; i < to - 1; i++) {
    const alat = (g.shapeLat[i] as number) / COORD_SCALE;
    const alon = (g.shapeLon[i] as number) / COORD_SCALE;
    const d = haversineM(at[1], at[0], alat, alon);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  const alat = (g.shapeLat[bestI] as number) / COORD_SCALE;
  const alon = (g.shapeLon[bestI] as number) / COORD_SCALE;
  const blat = (g.shapeLat[bestI + 1] as number) / COORD_SCALE;
  const blon = (g.shapeLon[bestI + 1] as number) / COORD_SCALE;
  const forward = bearingDeg(alat, alon, blat, blon);
  return g.edgeReversed[edgeId] === 1 ? (forward + 180) % 360 : forward;
}

export interface MatchOptions {
  /** Names table from the artifact, for reporting the matched road. */
  readonly nameOf?: ((nameId: number) => string | undefined) | undefined;
}

interface Candidate {
  readonly edgeId: number;
  readonly point: LngLat;
  readonly bearingDeg: number;
  readonly offsetM: number;
  /** Log probability. Kept in logs so a long sequence cannot underflow to zero. */
  logp: number;
  previous: Candidate | null;
}

/**
 * Most probable edge for the LAST fix in the window, given the whole window.
 *
 * Returns null when nothing survives the heading gate, and that is a designed answer rather than a
 * failure: it means the evidence does not justify naming a road. The caller shows the raw fix and
 * says so, which is charter item 10, instead of asserting a road it cannot defend.
 */
export function matchFreeDrive(
  g: MatchGraph,
  index: SnapIndex,
  fixes: readonly Fix[],
  opts: MatchOptions = {},
): MatchResult | null {
  if (fixes.length === 0) return null;

  let previousLayer: Candidate[] = [];
  let previousFix: Fix | null = null;

  for (const fix of fixes) {
    // The receiver's own accuracy is the emission sigma, floored so an implausibly confident fix
    // cannot collapse the distribution onto a single candidate.
    const sigma = Math.max(TRACKING.emissionSigmaFloorM, fix.accuracyM);
    const heading =
      fix.headingDeg !== null &&
      Number.isFinite(fix.headingDeg) &&
      fix.speedMps !== null &&
      fix.speedMps >= TRACKING.headingMinSpeedMps
        ? fix.headingDeg
        : null;

    const raw = index.candidates(fix.point, SNAP_TRACKING_M, TRACKING.maxCandidates);
    const layer: Candidate[] = [];
    for (const c of raw) {
      const b = edgeBearingAt(g, c.edgeId, c.point);
      // THE GATE. Applied before any score exists, so it cannot be outvoted by proximity.
      if (heading !== null && bearingGap(b, heading) > TRACKING.headingAgreementDeg) continue;
      layer.push({
        edgeId: c.edgeId,
        point: c.point,
        bearingDeg: b,
        offsetM: c.distanceM,
        // Gaussian emission, in logs. The constant term is dropped: it is identical for every
        // candidate in a layer, so it cannot change which one wins.
        logp: -0.5 * (c.distanceM / sigma) ** 2,
        previous: null,
      });
    }
    if (layer.length === 0) {
      // Nothing credible for this fix. Keep the previous layer rather than throwing the whole
      // window away: one obstructed sample should not lose the track.
      continue;
    }

    if (previousLayer.length > 0 && previousFix !== null) {
      const straightM = haversineM(
        previousFix.point[1],
        previousFix.point[0],
        fix.point[1],
        fix.point[0],
      );
      for (const c of layer) {
        let bestPrev: Candidate | null = null;
        let bestScore = -Infinity;
        for (const p of previousLayer) {
          // On-road distance approximated by the distance between the two matched points. The
          // classic false transition is a hop to the opposite carriageway, which on the road
          // network costs a U-turn and lands far outside the tolerance.
          const roadM = haversineM(p.point[1], p.point[0], c.point[1], c.point[0]);
          const excess = Math.abs(roadM - straightM);
          const transition = -excess / TRACKING.transitionToleranceM;
          const score = p.logp + transition;
          if (score > bestScore) {
            bestScore = score;
            bestPrev = p;
          }
        }
        c.logp += bestScore;
        c.previous = bestPrev;
      }
    }
    previousLayer = layer;
    previousFix = fix;
  }

  if (previousLayer.length === 0) return null;

  let winner = previousLayer[0] as Candidate;
  for (const c of previousLayer) if (c.logp > winner.logp) winner = c;

  // Posterior over the final layer, via softmax on the log scores. Reported so the UI can say
  // "probably" instead of drawing a confident dot on a coin flip.
  let sum = 0;
  for (const c of previousLayer) sum += Math.exp(c.logp - winner.logp);
  const probability = sum === 0 ? 1 : 1 / sum;

  const nameId = g.edgeNameId[winner.edgeId] as number;
  const roadName = opts.nameOf?.(nameId);
  return {
    point: winner.point,
    edgeId: winner.edgeId,
    bearingDeg: winner.bearingDeg,
    offsetM: winner.offsetM,
    probability,
    roadName,
  };
}
