/**
 * What it costs to turn. Precomputed once per loaded graph, read once per relaxation.
 *
 * WHY IT EXISTS. Before this, every turn was free. That is a modelling GAP, not a modelling
 * choice: with turns at zero a router prefers a many-turn path through residential streets over a
 * fewer-turn path along an arterial whenever the small path is even slightly shorter, because
 * nothing on the small path costs anything extra. Gate 4 measured the consequence against OSRM.
 *
 * FOUR TERMS, each a separate real cost, kept separate so each can be calibrated and argued about
 * on its own rather than disappearing into one fudge factor:
 *
 *   1. SEVERITY. A bend is free, a square turn costs, a hairpin costs more. Linear in the bearing
 *      change beyond `straightDeg`, so it is monotone and has no cliff a route can sit on.
 *   2. CROSSING ONCOMING TRAFFIC. India drives on the LEFT, so the turn that waits for a gap is
 *      the RIGHT turn. This is the term most likely to be silently inverted, and inverting it
 *      penalises precisely the turns that are actually free, so `drivesOnLeft` is explicit in
 *      `config/city.ts` rather than baked in here.
 *   3. DROPPING ROAD CLASS. Turning off a trunk road onto a residential street costs, per step
 *      down `CLASS_RANK`. This is the term that stops a router threading a housing estate to save
 *      200 m. Climbing back up is free: joining a bigger road is not a manoeuvre worth
 *      discouraging.
 *   4. U-TURN. A penalty, never a ban, because a ban breaks dead ends and legitimate turnarounds
 *      and produces "no route" where a driver would simply turn around. EXEMPT where the junction
 *      has outgoing degree 1, since at a dead end the reverse twin is the only move available and
 *      charging for it prices something the driver has no choice about.
 *
 * ADMISSIBILITY, stated here because A\* depends on it. Every term is NON-NEGATIVE, so turn costs
 * can only increase the cost of a path. Any heuristic that lower-bounds the turn-free cost of the
 * remaining journey therefore still lower-bounds the real cost once turns are priced, and stays
 * admissible without modification. This holds only while every value in `TURN_COST` is >= 0, which
 * `assertNonNegative` enforces at construction rather than leaving to review.
 *
 * BEARINGS ARE MEASURED OVER A BASELINE, not over one shape segment. Shape points are unevenly
 * spaced, and a final segment can be half a metre of survey noise whose bearing is meaningless.
 * Walking back `BEARING_BASELINE_M` before taking the bearing makes the angle reflect the road's
 * actual approach direction. This matters most on curved slip roads, which is exactly where turn
 * pricing has to be right.
 *
 * LAYOUT. Costs are stored in one flat Float32Array indexed by (incoming edge, slot among the
 * outgoing edges of its head vertex). The outgoing set of edge `e` is the CSR range of
 * `edgeTo[e]`, so the search reads `seconds[offset[e] + (i - csrStart)]` with `i` the CSR cursor
 * it is already walking. One sequential array read per relaxation, no branching, no Map.
 */
import type { TurnCostConfig } from '../shared/index.ts';

const DEG = Math.PI / 180;
const COORD_SCALE = 1e7;

/**
 * Metres of road used to measure the approach and departure bearing at a junction.
 *
 * Long enough to average out survey noise in short shape segments, short enough that a genuine
 * curve close to the junction still registers as the direction the driver is actually pointing.
 */
const BEARING_BASELINE_M = 20;

export interface TurnCostGraph {
  readonly csrOffset: Int32Array;
  readonly csrEdge: Int32Array;
  readonly edgeTo: Int32Array;
  readonly edgeShape: Int32Array;
  readonly edgeReversed: Uint8Array;
  readonly edgeClassRank: Uint8Array;
  readonly shapeOffset: Int32Array;
  readonly shapeLat: Int32Array;
  readonly shapeLon: Int32Array;
}

export interface TurnCosts {
  /** Start of edge e's block in `seconds`. Length equals the outdegree of `edgeTo[e]`. */
  readonly offset: Int32Array;
  readonly seconds: Float32Array;
  /** Reverse twin of each edge, or -1 where the road is one-way and has none. */
  readonly twin: Int32Array;
  readonly stats: TurnCostStats;
}

export interface TurnCostStats {
  readonly pairs: number;
  readonly freePairs: number;
  readonly uTurnPairs: number;
  readonly uTurnExemptPairs: number;
  readonly crossTrafficPairs: number;
  readonly classDropPairs: number;
  readonly meanSeconds: number;
  readonly maxSeconds: number;
  readonly buildSeconds: number;
}

/**
 * Bearing from one point to another, degrees clockwise from north.
 *
 * Great-circle rather than planar. Over 20 m the difference is far below the angular resolution
 * anything here cares about, but writing the planar version invites someone to reuse it over a
 * whole edge, where it is wrong.
 */
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

/** Rough metres between two points. Only ever used to walk out a 20 m baseline. */
function roughM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const kx = Math.cos(((lat1 + lat2) / 2) * DEG) * 111_320;
  const dx = (lon2 - lon1) * kx;
  const dy = (lat2 - lat1) * 110_540;
  return Math.hypot(dx, dy);
}

/**
 * Signed bearing change in (-180, 180]. POSITIVE is clockwise, which is a RIGHT turn.
 *
 * The interval is CLOSED AT +180 deliberately. An exact reversal is the one angle where the two
 * conventions disagree, and mapping it to -180 would classify a hairpin as a left turn and let it
 * escape the crossing penalty. A 180 degree turn crosses oncoming traffic whichever way it swings,
 * so it belongs on the charged side. The obvious one-liner, `((d + 540) % 360) - 180`, returns
 * -180 there, which is why this is written out.
 */
export function bearingDelta(fromDeg: number, toDeg: number): number {
  let d = (toDeg - fromDeg) % 360;
  if (d <= -180) d += 360;
  else if (d > 180) d -= 360;
  return d;
}

/**
 * The severity, crossing and class-drop terms for one manoeuvre. Exported so the toy-graph tests
 * can assert the shape of the function directly instead of inferring it from a route.
 */
export function manoeuvreSeconds(
  deltaDeg: number,
  rankFrom: number,
  rankTo: number,
  cfg: TurnCostConfig,
): number {
  const a = Math.abs(deltaDeg);
  let s = 0;
  if (a > cfg.straightDeg) {
    // Normalised so `turnS` is the cost of a square 90 degree turn; a hairpin costs proportionally
    // more rather than saturating, since a 170 degree turn really is harder than a 90.
    s += (cfg.turnS * (a - cfg.straightDeg)) / (90 - cfg.straightDeg);
  }
  if (a >= cfg.crossMinDeg) {
    const right = deltaDeg > 0;
    if (right === cfg.drivesOnLeft) s += cfg.crossTrafficS;
  }
  const drop = rankTo - rankFrom;
  if (drop > 0) s += cfg.classDropS * drop;
  return s;
}

function assertNonNegative(cfg: TurnCostConfig): void {
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v === 'number' && v < 0) {
      // Named loudly: a negative turn cost does not fail, it silently breaks A* admissibility and
      // returns routes that are wrong rather than routes that are missing.
      throw new Error(`TURN_COST.${k} is ${v}; turn costs must be non-negative or A* is no longer admissible.`);
    }
  }
}

export function buildTurnCosts(g: TurnCostGraph, cfg: TurnCostConfig): TurnCosts {
  assertNonNegative(cfg);
  const t0 = performance.now();
  const E = g.edgeTo.length;

  // ---- Reverse twins. Two directed edges of one segment share a shape id.
  const twin = new Int32Array(E).fill(-1);
  {
    const firstOfShape = new Int32Array(g.shapeOffset.length).fill(-1);
    for (let e = 0; e < E; e++) {
      const s = g.edgeShape[e] as number;
      const seen = firstOfShape[s] as number;
      if (seen === -1) firstOfShape[s] = e;
      else {
        twin[e] = seen;
        twin[seen] = e;
      }
    }
  }

  // ---- Approach and departure bearings, over a 20 m baseline at each end.
  const bearingIn = new Float32Array(E);
  const bearingOut = new Float32Array(E);
  for (let e = 0; e < E; e++) {
    const s = g.edgeShape[e] as number;
    const from = g.shapeOffset[s] as number;
    const to = g.shapeOffset[s + 1] as number;
    const n = to - from;
    if (n < 2) continue;
    const rev = g.edgeReversed[e] === 1;
    // Index of the k-th shape point in TRAVEL order.
    const at = (k: number): number => (rev ? to - 1 - k : from + k);
    const latOf = (i: number): number => (g.shapeLat[i] as number) / COORD_SCALE;
    const lonOf = (i: number): number => (g.shapeLon[i] as number) / COORD_SCALE;

    // Departure: walk forward from the first point until the baseline is covered.
    {
      const i0 = at(0);
      let k = 1;
      let acc = 0;
      let i1 = at(1);
      while (k < n - 1 && acc < BEARING_BASELINE_M) {
        const a = at(k - 1);
        const b = at(k);
        acc += roughM(latOf(a), lonOf(a), latOf(b), lonOf(b));
        i1 = b;
        k++;
      }
      bearingOut[e] = bearingDeg(latOf(i0), lonOf(i0), latOf(i1), lonOf(i1));
    }
    // Approach: walk backward from the last point the same way.
    {
      const i1 = at(n - 1);
      let k = n - 2;
      let acc = 0;
      let i0 = at(n - 2);
      while (k > 0 && acc < BEARING_BASELINE_M) {
        const a = at(k);
        const b = at(k + 1);
        acc += roughM(latOf(a), lonOf(a), latOf(b), lonOf(b));
        i0 = a;
        k--;
      }
      bearingIn[e] = bearingDeg(latOf(i0), lonOf(i0), latOf(i1), lonOf(i1));
    }
  }

  // ---- One block per edge, sized by the outdegree of its head vertex.
  const offset = new Int32Array(E + 1);
  for (let e = 0; e < E; e++) {
    const v = g.edgeTo[e] as number;
    offset[e + 1] = (offset[e] as number) + ((g.csrOffset[v + 1] as number) - (g.csrOffset[v] as number));
  }
  const seconds = new Float32Array(offset[E] as number);

  let freePairs = 0;
  let uTurnPairs = 0;
  let uTurnExemptPairs = 0;
  let crossTrafficPairs = 0;
  let classDropPairs = 0;
  let total = 0;
  let maxSeconds = 0;

  for (let e = 0; e < E; e++) {
    const v = g.edgeTo[e] as number;
    const cs = g.csrOffset[v] as number;
    const ce = g.csrOffset[v + 1] as number;
    const outDeg = ce - cs;
    const base = offset[e] as number;
    const rankFrom = g.edgeClassRank[e] as number;
    const bIn = bearingIn[e] as number;
    const tw = twin[e] as number;

    for (let i = cs; i < ce; i++) {
      const f = g.csrEdge[i] as number;
      let cost: number;
      if (f === tw) {
        // Exempt at a dead end: the twin is the only way out, so there is nothing to discourage.
        if (outDeg <= 1) {
          cost = 0;
          uTurnExemptPairs++;
        } else {
          cost = cfg.uTurnS;
          uTurnPairs++;
        }
      } else {
        const d = bearingDelta(bIn, bearingOut[f] as number);
        const rankTo = g.edgeClassRank[f] as number;
        cost = manoeuvreSeconds(d, rankFrom, rankTo, cfg);
        if (Math.abs(d) >= cfg.crossMinDeg && (d > 0) === cfg.drivesOnLeft) crossTrafficPairs++;
        if (rankTo > rankFrom) classDropPairs++;
      }
      seconds[base + (i - cs)] = cost;
      if (cost === 0) freePairs++;
      total += cost;
      if (cost > maxSeconds) maxSeconds = cost;
    }
  }

  const pairs = offset[E] as number;
  return {
    offset,
    seconds,
    twin,
    stats: {
      pairs,
      freePairs,
      uTurnPairs,
      uTurnExemptPairs,
      crossTrafficPairs,
      classDropPairs,
      meanSeconds: pairs === 0 ? 0 : total / pairs,
      maxSeconds,
      buildSeconds: Number(((performance.now() - t0) / 1000).toFixed(3)),
    },
  };
}
