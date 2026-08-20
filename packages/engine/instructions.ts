/**
 * Turn-by-turn instructions, derived from the chosen edge sequence and nothing else.
 *
 * Pure, like the rest of this package: edges and geometry in, `Instruction[]` out, no IO. The
 * inputs are the same arrays the search ran on, so an instruction can never describe a road the
 * route did not take.
 *
 * THE FOUR SIGNALS, and they are read in this order because a later one is only meaningful once
 * the earlier ones have not already explained the manoeuvre:
 *
 *   1. Is this a roundabout?  `edgeRoundabout` says which edges form the circle. Entering it and
 *      leaving it are two instructions and everything in between is counted, never announced.
 *   2. What is the bearing change?  Measured over a ground window, not between adjacent shape
 *      points, so the angle is a property of the road and not of how finely it was surveyed.
 *   3. Did the road name change?  A bend on one continuously named road is not a manoeuvre, however
 *      sharp, and a driver told to "turn right" where the road simply curves stops trusting the
 *      whole list.
 *   4. What class is it?  Joining a motorway from its own slip road is a merge, not a turn.
 *
 * WHY BEARINGS ARE MEASURED OVER A WINDOW. Adjacent shape points on a well-surveyed curve are
 * metres apart, so the angle between them is nearly zero even on a sharp corner, while on a coarsely
 * mapped junction two points can span the whole turn. Reading the bearing over a fixed GROUND
 * DISTANCE either side makes the measurement independent of survey density. This is the same reason
 * and the same constant as the turn-cost estimator in `scripts/diagnose-pair.ts`.
 *
 * ⛔ NEVER EMIT AN INSTRUCTION FOR A MANOEUVRE THE DRIVER DOES NOT MAKE. A vertex exists wherever
 * two ways meet, so a route passing straight through a crossroads produces an edge change with no
 * turn in it. Announcing those is how a 30 km route grows 200 instructions and becomes unreadable.
 * Silence at a junction the driver drives straight through is correct; the only manoeuvres that get
 * announced are the ones that change what the driver does.
 */
import { NAME_NONE } from '../shared/graphfile.ts';
import type { Instruction, LngLat, ManeuverType } from '../shared/index.ts';
import { bearingDelta } from './turncost.ts';

/** What the builder needs from the graph. A strict subset, so toy graphs can supply it by hand. */
export interface InstructionGraph {
  readonly edgeTo: Int32Array;
  readonly edgeLengthM: Float64Array;
  readonly edgeSpeedKmh: Uint8Array;
  readonly edgeClassRank: Uint8Array;
  readonly edgeNameId: Int32Array;
  readonly edgeRoundabout: Uint8Array;
  readonly csrOffset: Int32Array;
  readonly csrEdge: Int32Array;
}

export interface InstructionInput {
  readonly graph: InstructionGraph;
  readonly roadNames: readonly string[];
  /** The chosen edge sequence, in order. */
  readonly edges: readonly number[];
  /** The full-fidelity route line. Instruction positions are indices into THIS array. */
  readonly geometry: readonly LngLat[];
}

/**
 * How far either side of a junction the bearing is read, in metres. See the header note.
 *
 * 30 m is a junction's own scale here: far enough that a single stray shape point cannot swing the
 * angle, near enough that the next corner on a dense urban grid is not inside the window.
 */
const BEARING_WINDOW_M = 30;

/**
 * Below this, a bearing change is not a manoeuvre and gets no instruction.
 *
 * Matches `TURN_COST.straightDeg` in intent but is deliberately a SEPARATE constant: the cost model
 * asks "is this hard enough to slow down for" and this asks "does the driver need telling". Those
 * are different questions and tying them together means retuning the router changes the wording of
 * instructions, which is exactly the kind of hidden coupling that makes both untunable.
 */
const STRAIGHT_DEG = 20;

/** Angle bands, degrees of absolute bearing change. */
const SLIGHT_DEG = 45;
const SHARP_DEG = 120;
const U_TURN_DEG = 160;

/** Below this, two consecutive manoeuvres are one junction and the second is suppressed. */
const MERGE_NEARBY_M = 12;

/**
 * How far the driver must have gone before a NAME CHANGE alone is worth announcing.
 *
 * Turns and merges are exempt: those are things the driver does, and they are worth saying however
 * soon they come. A name change is only a thing the driver hears, so it competes with the last
 * thing they heard. Without this the Vikas Marg corridor announces itself four times in 2.6 km,
 * because OSM names each structure separately along one continuous road.
 */
const NAME_CHANGE_MIN_M = 250;

/**
 * Trailing words that name a STRUCTURE carrying a road, not a different road.
 *
 * OSM maps the bridge, the underpass and the slip road as separately named ways, so one continuous
 * drive down Vikas Marg reads as `Vikas Marg`, `Vikas Marg Underpass`, `Vikas Marg` in the graph.
 * Announcing each is technically accurate and useless: the driver did not change road. Stripping
 * these before comparing is what makes "did the road change" mean what a driver means by it.
 *
 * `Bypass` is deliberately NOT here. A bypass is a different road with a different route, and
 * merging it into its parent would hide a genuine change.
 */
const STRUCTURE_WORDS = ['flyover', 'underpass', 'overpass', 'ramp', 'bridge', 'tunnel', 'approach', 'slip road'];

/** How far past a junction to look for the name of the road being joined. See `nameAhead`. */
const NAME_LOOKAHEAD_M = 800;

/** A road name with its structure suffixes removed, lowercased, for comparison only. */
function baseName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  let s = name.trim().toLowerCase();
  let changed = true;
  while (changed) {
    changed = false;
    for (const w of STRUCTURE_WORDS) {
      if (s.endsWith(` ${w}`)) {
        s = s.slice(0, -(w.length + 1)).trim();
        changed = true;
      }
    }
  }
  return s === '' ? undefined : s;
}

const KMH_TO_MS = 1 / 3.6;

/** Great-circle bearing in degrees, north 0, clockwise. Local flat approximation, fine at 30 m. */
function bearingDeg(a: LngLat, b: LngLat): number {
  const dx = (b[0] - a[0]) * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dy = b[1] - a[1];
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

function metres(a: LngLat, b: LngLat): number {
  const dx = (b[0] - a[0]) * 111_320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dy = (b[1] - a[1]) * 110_540;
  return Math.hypot(dx, dy);
}

/** Bearing entering `at`, averaged back over the window. Null when the window has no room. */
function bearingInto(geom: readonly LngLat[], at: number): number | null {
  let i = at;
  let acc = 0;
  while (i > 0 && acc < BEARING_WINDOW_M) {
    acc += metres(geom[i - 1] as LngLat, geom[i] as LngLat);
    i--;
  }
  if (i === at) return null;
  return bearingDeg(geom[i] as LngLat, geom[at] as LngLat);
}

/** Bearing leaving `at`, averaged forward over the window. Null when the window has no room. */
function bearingOutOf(geom: readonly LngLat[], at: number): number | null {
  let i = at;
  let acc = 0;
  while (i + 1 < geom.length && acc < BEARING_WINDOW_M) {
    acc += metres(geom[i] as LngLat, geom[i + 1] as LngLat);
    i++;
  }
  if (i === at) return null;
  return bearingDeg(geom[at] as LngLat, geom[i] as LngLat);
}

/** Two turns within this, the same way round, are one corner. See the suppression below. */
const SAME_CORNER_M = 40;

/** Which way a manoeuvre swings, or null when it does not swing. */
function turnSide(t: ManeuverType): 'left' | 'right' | null {
  if (t.endsWith('-left')) return 'left';
  if (t.endsWith('-right')) return 'right';
  return null;
}

function turnType(delta: number): ManeuverType {
  const a = Math.abs(delta);
  if (a >= U_TURN_DEG) return 'u-turn';
  const right = delta > 0;
  if (a >= SHARP_DEG) return right ? 'turn-sharp-right' : 'turn-sharp-left';
  if (a >= SLIGHT_DEG) return right ? 'turn-right' : 'turn-left';
  return right ? 'turn-slight-right' : 'turn-slight-left';
}

/**
 * How many ways leave the junction at the end of `edge`, not counting the way back.
 *
 * A "fork" and a "turn" differ only in whether there was a choice, and the choice is a property of
 * the junction rather than of the angle. Read from the CSR, which is the same adjacency the search
 * used, so it cannot disagree with what the router considered legal.
 */
function outDegree(g: InstructionGraph, edge: number): number {
  const v = g.edgeTo[edge] as number;
  return (g.csrOffset[v + 1] as number) - (g.csrOffset[v] as number);
}

/**
 * Builds the instruction list for one route.
 *
 * `geometryIndex` positions are indices into the SAME geometry array the caller passes, which is
 * the one the client draws, so highlighting a manoeuvre never needs a second lookup that could
 * drift from the line.
 */
export function buildInstructions(input: InstructionInput): Instruction[] {
  const { graph: g, roadNames, edges, geometry } = input;
  if (edges.length === 0 || geometry.length < 2) return [];

  const nameOf = (edge: number): string | undefined => {
    const id = g.edgeNameId[edge] as number;
    return id === NAME_NONE ? undefined : roadNames[id];
  };

  /**
   * The name the driver should be given for the road they are joining, looked up AHEAD of the
   * junction rather than at it.
   *
   * The edge immediately after a junction is very often the slip road, and slip roads are
   * overwhelmingly unnamed here. Naming the manoeuvre from that edge produced "merge onto
   * (unnamed)" at the one junction on a 73 km route that most needed a name: the Yamuna
   * Expressway. Reading a short way further finds the road the ramp actually leads to.
   *
   * A structure-free name is preferred over a structural one, so a driver joining Vikas Marg
   * through its underpass is told "Vikas Marg" and not "Vikas Marg Underpass".
   */
  const nameAhead = (fromIndex: number): string | undefined => {
    let travelled = 0;
    let firstAny: string | undefined;
    for (let i = fromIndex; i < edges.length && travelled <= NAME_LOOKAHEAD_M; i++) {
      const n = nameOf(edges[i] as number);
      if (n !== undefined) {
        if (firstAny === undefined) firstAny = n;
        if (baseName(n) === n.trim().toLowerCase()) return n;
      }
      travelled += g.edgeLengthM[edges[i] as number] as number;
    }
    return firstAny;
  };

  // Where each edge's SHARE of the route line ends, as an index into `geometry`. Derived by walking
  // the line and consuming each edge's length rather than by re-deriving shapes, because the caller
  // already trimmed the first and last edges to the snap fractions and the shapes have not been.
  const cumM: number[] = [0];
  for (let i = 1; i < geometry.length; i++) {
    cumM.push((cumM[i - 1] as number) + metres(geometry[i - 1] as LngLat, geometry[i] as LngLat));
  }
  const totalLineM = cumM[cumM.length - 1] as number;
  let totalEdgeM = 0;
  for (const e of edges) totalEdgeM += g.edgeLengthM[e] as number;
  // The line is the trimmed route and the edge lengths are untrimmed, so positions are placed
  // proportionally. Exact at every interior junction, which is where instructions land.
  const scale = totalEdgeM > 0 ? totalLineM / totalEdgeM : 1;

  const junctionIndex: number[] = [];
  {
    let run = 0;
    let cursor = 0;
    for (let k = 0; k < edges.length - 1; k++) {
      run += (g.edgeLengthM[edges[k] as number] as number) * scale;
      // NEAREST point, never the first one past the target, and the difference is a real defect
      // rather than a refinement. `edgeLengthM` is haversine from the pipeline; `cumM` is the flat
      // local approximation used here. They agree to about half a percent, which is nothing over a
      // route and everything at a junction: on a square corner the target fell 2.5 m beyond the
      // corner point, the index advanced one past it, and the bearing was then read from after the
      // turn to further after the turn. Delta came out 0 and a 90 degree left was never announced.
      // Junction spacing is hundreds of metres, so nearest-match is immune to that disagreement.
      while (
        cursor + 1 < cumM.length &&
        Math.abs((cumM[cursor + 1] as number) - run) < Math.abs((cumM[cursor] as number) - run)
      ) {
        cursor++;
      }
      junctionIndex.push(cursor);
    }
  }

  const out: Instruction[] = [];
  const push = (
    type: ManeuverType,
    geometryIndex: number,
    roadName: string | undefined,
    roundaboutExit?: number,
  ): void => {
    const prev = out.length === 0 ? 0 : (out[out.length - 1] as Instruction).geometryIndex;
    const distanceM = (cumM[geometryIndex] as number) - (cumM[prev] as number);
    // Duration from the edges actually spanned, never distance over an average speed: the whole
    // point of a per-edge speed table is that a leg crossing three classes has no single speed.
    let durationS = 0;
    {
      let run = 0;
      const from = (cumM[prev] as number);
      const to = (cumM[geometryIndex] as number);
      for (const e of edges) {
        const len = (g.edgeLengthM[e] as number) * scale;
        const segFrom = run;
        const segTo = run + len;
        run = segTo;
        const lo = Math.max(from, segFrom);
        const hi = Math.min(to, segTo);
        if (hi > lo) durationS += (hi - lo) / ((g.edgeSpeedKmh[e] as number) * KMH_TO_MS);
      }
    }
    const inst: Instruction = {
      type,
      distanceM,
      durationS,
      geometryIndex,
      ...(roadName === undefined ? {} : { roadName }),
      ...(roundaboutExit === undefined ? {} : { roundaboutExit }),
    };
    out.push(inst);
  };

  push('depart', 0, nameOf(edges[0] as number));

  /** The last road name the driver was actually told. See the repeat guard below. */
  let lastLabel: string | undefined = nameOf(edges[0] as number);

  let k = 0;
  while (k < edges.length - 1) {
    const cur = edges[k] as number;
    const next = edges[k + 1] as number;
    const at = junctionIndex[k] as number;

    // ---- roundabouts, handled as a unit -------------------------------------------------------
    if (g.edgeRoundabout[next] === 1 && g.edgeRoundabout[cur] !== 1) {
      // Walk the circle, counting every junction that offers a way OUT. The exit taken is the one
      // where the route finally leaves, and its ordinal is what the driver is told.
      let j = k + 1;
      let exits = 0;
      while (j < edges.length && g.edgeRoundabout[edges[j] as number] === 1) {
        // An exit exists here when the circle edge's end vertex leads anywhere off the circle.
        const v = g.edgeTo[edges[j] as number] as number;
        const cs = g.csrOffset[v] as number;
        const ce = g.csrOffset[v + 1] as number;
        for (let c = cs; c < ce; c++) {
          if (g.edgeRoundabout[g.csrEdge[c] as number] !== 1) {
            exits++;
            break;
          }
        }
        j++;
      }
      push('roundabout-enter', at, nameOf(next));
      if (j < edges.length) {
        // The exit the route takes is the last counted one, since the walk stopped where the route
        // left the circle. Counting is 1-based for the driver.
        push('roundabout-exit', junctionIndex[j - 1] as number, nameOf(edges[j] as number), Math.max(1, exits));
        k = j;
        continue;
      }
      // The route ends on the circle, which is degenerate but must not crash or invent an exit.
      k = j;
      continue;
    }
    if (g.edgeRoundabout[cur] === 1) {
      k++;
      continue;
    }

    // ---- ordinary junctions -------------------------------------------------------------------
    const into = bearingInto(geometry, at);
    const outOf = bearingOutOf(geometry, at);
    if (into === null || outOf === null) {
      k++;
      continue;
    }
    const delta = bearingDelta(into, outOf);
    const curName = nameOf(cur);
    const nextName = nameOf(next);
    // Compared on BASE names, so a road that only changed structure did not change road.
    const nameChanged = baseName(curName) !== baseName(nextName);
    const rankCur = g.edgeClassRank[cur] as number;
    const rankNext = g.edgeClassRank[next] as number;

    const choices = outDegree(g, cur);
    // Still on the same road, by the name the driver would use. See the bend rule below.
    const sameRoad = !nameChanged && curName !== undefined;

    let type: ManeuverType | null = null;
    if (Math.abs(delta) >= STRAIGHT_DEG) {
      // ⛔ A BEND IS NOT A MANOEUVRE. An expressway that curves through 30 degrees over a junction
      // vertex is one road doing what roads do, and "turn slight left onto Noida-Greater Noida
      // Expressway" while already on it is the instruction that makes a driver stop reading the
      // list. It is only a manoeuvre on an unchanged road when it is sharp enough to be a real
      // corner, or when the junction offered somewhere else to go.
      // The band matters, not just the out-degree. Under a slight turn the road is bending, and it
      // bends just as much where a side road happens to leave, so the out-degree escape below must
      // not apply there: it turned a 31 degree curve into "keep right onto Bendy Road" while
      // already on Bendy Road. Above a slight turn it is a real corner and the junction decides:
      // with somewhere else to go it is a manoeuvre, without one it is still just the road curving.
      const bend =
        sameRoad &&
        (Math.abs(delta) < SLIGHT_DEG || (Math.abs(delta) < SHARP_DEG && choices < 3));
      if (bend) type = null;
      else {
        // A fork only when the junction offered a genuine choice, since "bear left" at a place with
        // one way out is noise dressed as guidance.
        type = choices >= 3 && Math.abs(delta) < SLIGHT_DEG
          ? (delta > 0 ? 'fork-right' : 'fork-left')
          : turnType(delta);
      }
    } else if (rankNext <= 1 && rankCur >= 2) {
      // Joining a motorway or trunk from something smaller, without an angle: a merge.
      //
      // NO NAME TEST HERE, and that was a real defect. A merge is defined by the class jump, not by
      // the wording: the slip road onto the Yamuna Expressway is unnamed and so is the road it
      // leaves, so requiring a name change suppressed the single most important instruction on a
      // 73 km route. Joining an expressway is a manoeuvre whether or not anyone named the ramp.
      type = 'merge';
    } else if (rankCur <= 1 && rankNext >= 2 && nameChanged) {
      // LEAVING a motorway or trunk, the mirror of the merge above, and it was missing. A 63 km run
      // down the Eastern Peripheral produced three instructions: depart, merge, arrive. The exit
      // ramps are unnamed and leave at less than 20 degrees, so nothing fired, and the driver was
      // told to join an expressway and then never told to leave it. Phrased as a fork by the side
      // it departs, which is how an exit reads on a sign.
      //
      // THE NAME TEST BELONGS HERE EVEN THOUGH IT DOES NOT BELONG ON THE MERGE, and the asymmetry
      // is the data, not an oversight. Rural trunk roads here flip between trunk and unclassified
      // repeatedly along one continuous carriageway, so a bare class test fired five times in
      // 2.5 km on the Faridabad approach. Leaving a road really does change its name; the tagging
      // flip does not. A merge has no equivalent problem because it is the ramp that is unnamed.
      type = delta > 0 ? 'fork-right' : 'fork-left';
    } else if (nameChanged && nextName !== undefined) {
      // Straight onto a differently named road. Announced without an out-degree test, since leaving
      // a motorway onto a named expressway is a two-way junction and is exactly what must be said.
      type = 'straight';
    }

    if (type !== null) {
      const last = out[out.length - 1] as Instruction;
      const gapM = (cumM[at] as number) - (cumM[last.geometryIndex] as number);
      // Two manoeuvres within a car's length of each other are one junction mapped as two ways.
      // Keeping both produces "turn left, then turn left" at a single corner. A name change has to
      // clear a much larger gap, because it is information rather than an action.
      const floor = type === 'straight' ? NAME_CHANGE_MIN_M : MERGE_NEARBY_M;
      // Named from ahead of the junction, never from the slip road at it. See `nameAhead`.
      const label =
        type === 'merge' || type === 'straight' || type === 'fork-left' || type === 'fork-right'
          ? nameAhead(k + 1)
          : nextName;
      // ⛔ THE DECISION AND THE LABEL MUST USE THE SAME NAME. They did not, and the result was
      // "continue onto Vikas Marg" three times in 7 km: the decision compared the raw way names,
      // which really did change, while the label resolved through `nameAhead` back to the same
      // road each time. Telling a driver to continue onto the road they are already on is worse
      // than saying nothing, so a name announcement that would repeat the last one is dropped.
      const repeats = type === 'straight' && label !== undefined && baseName(label) === baseName(lastLabel);
      // One corner mapped as several short ways reads as several turns. Two turns the SAME WAY
      // within a corner's length are one corner being tracked around its curve; a left followed by
      // a right is a real pair of manoeuvres however close, so direction is what distinguishes them
      // rather than distance alone.
      const sameCorner =
        gapM < SAME_CORNER_M &&
        turnSide(type) !== null &&
        turnSide(type) === turnSide(last.type);
      if (!repeats && !sameCorner && (gapM >= floor || (last.type === 'depart' && type !== 'straight'))) {
        push(type, at, label);
        if (label !== undefined) lastLabel = label;
      }
    }
    k++;
  }

  push('arrive', geometry.length - 1, nameOf(edges[edges.length - 1] as number));
  return out;
}
