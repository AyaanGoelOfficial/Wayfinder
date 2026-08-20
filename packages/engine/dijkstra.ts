/**
 * Edge-based Dijkstra with turn-restriction support.
 *
 * WHY EDGE-BASED AND NOT VERTEX-BASED: a turn restriction is a statement about the edge you
 * ARRIVED on, so the search state has to be "which directed edge am I on", not "which vertex am
 * I at". A vertex-based search physically cannot express `no_left_turn`, because by the time it
 * is at the junction it has forgotten how it got there. That is the cost of the via-node table
 * chosen at gate 1, and it is paid here.
 *
 * VIA-WAY RESTRICTIONS need one more hop of memory: the banned triple is
 * (from edge, via edge, to edge). The search reads its own predecessor array to recover the
 * from edge, so no extra state is carried per queue entry.
 *
 * HOT PATH: restriction support costs ONE Uint8Array read per expansion. `edgeRestricted` is 1
 * for the 51 edges out of 532,951 that carry any ban, so the branch is predicted false and no
 * Map is touched for the other 99.99%. Both tables are consulted only inside that branch.
 *
 * ALLOCATION: none per query. Distances, parents and the heap are preallocated once and reused,
 * with a GENERATION counter instead of clearing. Clearing a 533k-entry Float64Array per request
 * would cost more than most searches.
 *
 * DETERMINISM: equal-cost ties break on the lower edge index, so a route never changes between
 * runs for heap-ordering reasons. Golden routes depend on this.
 */
import { haversineM } from '../shared/geo.ts';
import { EPE_SEGMENT_NONE, TOLL_GATE_MAINLINE, TOLL_GATE_RAMP } from '../shared/graphfile.ts';
import { tollDisplayOf } from '../shared/toll.ts';

/**
 * Two mainline booth nodes closer than this belong to ONE plaza, so a crossing is billed once.
 *
 * Not a tuning knob: the gap between real barriers on this network is tens of kilometres, and the
 * gap between booth nodes of one plaza is hundreds of metres, so any threshold between the two
 * gives the same answer. 2 km sits in the middle of that gap by two orders of magnitude.
 */
const SAME_PLAZA_M = 2000;
import type {
  LngLat,
  ObjectiveConfig,
  RouteOptions,
  TollConfidence,
  TollDisplay,
  TurnCostConfig,
} from '../shared/index.ts';
import { buildTurnCosts } from './turncost.ts';
import type { TurnCosts } from './turncost.ts';

/**
 * The sub-polyline between two fractions of a polyline's total length, endpoints interpolated.
 *
 * Fractions are by LENGTH, not by point index, because shape points are unevenly spaced: a long
 * straight run may be two points and a tight curve twenty. Indexing by point would put the
 * snapped start metres away from where the snap actually landed.
 */
function clipPolyline(pts: readonly LngLat[], from: number, to: number): LngLat[] {
  if (pts.length < 2) return [...pts];
  if (from <= 0 && to >= 1) return [...pts];

  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i] as LngLat;
    const b = pts[i + 1] as LngLat;
    const d = haversineM(a[1], a[0], b[1], b[0]);
    seg.push(d);
    total += d;
  }
  if (total === 0) return [pts[0] as LngLat];

  const startM = Math.max(0, Math.min(1, from)) * total;
  const endM = Math.max(0, Math.min(1, to)) * total;
  if (endM <= startM) {
    return [pointAt(pts, seg, startM)];
  }

  const out: LngLat[] = [pointAt(pts, seg, startM)];
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const next = acc + (seg[i] as number);
    if (next > startM && next < endM) out.push(pts[i + 1] as LngLat);
    acc = next;
  }
  out.push(pointAt(pts, seg, endM));
  return out;
}

/** The point a given distance along a polyline, interpolating within the containing segment. */
function pointAt(pts: readonly LngLat[], seg: readonly number[], distM: number): LngLat {
  let acc = 0;
  for (let i = 0; i < seg.length; i++) {
    const d = seg[i] as number;
    if (acc + d >= distM) {
      const t = d === 0 ? 0 : (distM - acc) / d;
      const a = pts[i] as LngLat;
      const b = pts[i + 1] as LngLat;
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    }
    acc += d;
  }
  return pts[pts.length - 1] as LngLat;
}

const KMH_TO_MS = 1 / 3.6;

export interface RoutableGraph {
  readonly csrOffset: Int32Array;
  readonly csrEdge: Int32Array;
  readonly edgeFrom: Int32Array;
  readonly edgeTo: Int32Array;
  readonly edgeLengthM: Float64Array;
  readonly edgeSpeedKmh: Uint8Array;
  readonly edgeWayId: Float64Array;
  readonly edgeShape: Int32Array;
  readonly edgeReversed: Uint8Array;
  /** `CLASS_RANK` per edge, 0 for the biggest road. Read only by the turn cost model. */
  readonly edgeClassRank: Uint8Array;
  /** 1 when the edge charges a toll. What that is WORTH lives in the objective, not here. */
  readonly edgeToll: Uint8Array;
  /** Which toll road charges this edge, as an id into `ObjectiveConfig.tollRoads`. 0 for none. */
  readonly edgeTollRoad: Uint8Array;
  /** What toll point this edge contains: 0 none, 1 mainline barrier, 2 ramp booth. */
  readonly edgeTollGate: Uint8Array;
  /** Which inter-plaza span this edge lies in on a closed-system road; 255 when not applicable. */
  readonly edgeTollSegment: Uint8Array;
  /** Index into the artifact's road name table, `NAME_NONE` when unnamed. Read only by instructions. */
  readonly edgeNameId: Int32Array;
  /** 1 when the edge is part of a roundabout or circular junction. Read only by instructions. */
  readonly edgeRoundabout: Uint8Array;
  readonly shapeOffset: Int32Array;
  readonly shapeLat: Int32Array;
  readonly shapeLon: Int32Array;
  readonly vertexLat: Float64Array;
  /** Needed by the A\* heuristic. Present in the artifact since v1; the interface simply omitted it. */
  readonly vertexLon: Float64Array;
}

export interface Restrictions {
  readonly banned: ReadonlyMap<number, ReadonlySet<number>>;
  readonly bannedSequences: ReadonlyMap<number, readonly { fromEdge: number; toEdge: number }[]>;
  readonly edgeRestricted: Uint8Array;
}

export interface RouteResult {
  /** Directed edges traversed, in order. */
  readonly edges: readonly number[];
  /**
   * Total modelled cost, in seconds. This is what the search minimised, and it is NOT a duration.
   *
   * `seconds === driveSeconds + turnSeconds + distanceSeconds + tollSeconds`. Every component is
   * reported separately below because they are different KINDS of number and summing them into one
   * figure hides which preference produced the route. Anything comparing us against another
   * router's duration wants `driveSeconds`.
   */
  readonly seconds: number;
  /** Pure travel time: length over speed, nothing else. The only component comparable to OSRM. */
  readonly driveSeconds: number;
  /** The per-kilometre distance preference charged along this route. */
  readonly distanceSeconds: number;
  /** The toll reluctance charged along this route. Zero when no tolled edge was used. */
  readonly tollSeconds: number;
  /** Metres of this route running on tolled roads. Reported so the flag can be sanity checked. */
  readonly tollMetres: number;
  /**
   * WHAT THE DRIVER PAYS, in rupees, priced per road by that road's own mechanism.
   *
   * NOT `tollSeconds / secondsPerRupee`, and the difference is structural rather than a rounding.
   * The search charges a smooth per-kilometre proxy because that is the only shape a shortest path
   * can minimise; this figure is the billed truth, computed once over the chosen path by each
   * road's exact mechanism, which is a barrier fee for one road and a published entry-exit fare for
   * another. Neither mechanism is additive over edges. See `TollRoad.searchRatePerKm` and the
   * pattern note in `DESIGN.md`.
   */
  readonly tollCost: number;
  /**
   * How certain `tollCost` is, taken as the weakest link across every tolled road the route uses.
   * Decided per continuous RUN, since whether a ramp was involved is a property of the whole run.
   */
  readonly tollConfidence: TollConfidence;
  /** Whether, and how, `tollCost` may be rendered. Derived once, here, never at a call site. */
  readonly tollDisplay: TollDisplay;
  /**
   * The turn penalty portion of `seconds`, alone.
   *
   * Reported separately because the two are different KINDS of number and mixing them hides
   * things. Drive time is comparable against another router's drive time; turn penalties are a
   * modelling choice of ours. Any tool comparing our cost against a path priced from speeds only
   * must subtract this, or it is comparing a model against a measurement.
   */
  readonly turnSeconds: number;
  readonly metres: number;
  /** Full-fidelity geometry, every shape point, clipped to the snapped start and end. */
  readonly geometry: readonly LngLat[];
  /** Search effort, for the gate 5 budget and for spotting a heuristic regression. */
  readonly settled: number;
  readonly relaxed: number;
  /** Turn manoeuvres rejected because a restriction forbade them. */
  readonly restrictionsApplied: number;
}

const COORD_SCALE = 1e7;

// The cost of fully traversing an edge, in seconds, is `length / (speed * KMH_TO_MS)`. It used
// to live here as a function called from inside the relaxation loop. It is now computed once per
// edge into `Router.secs`; see the comment there for why.

/**
 * Preallocated search state, built once per loaded graph and reused for every query.
 * NOT safe for concurrent queries on one instance; the server holds one and routes serially.
 */
export class Router {
  /**
   * `dist`, `parent` and `stamp` INTERLEAVED in one buffer, 16 bytes per edge.
   *
   * They were three separate typed arrays. Every relaxation reads all three at the same edge
   * index, and that index comes from CSR adjacency, so it is effectively random: three separate
   * arrays meant three cache lines touched per relaxation, 1,388,769 times on a cross-city route.
   * Measured symptom before this change: nanoseconds per settle rose with the fraction of the
   * graph searched (391 ns at 6.5%, 603 ns at 92%), which is the signature of memory stalls
   * rather than of arithmetic.
   *
   * Layout per edge i: `dist` is the f64 at `f64[i * 2]`, `parent` is the i32 at `i32[i * 4 + 2]`,
   * `stamp` is the i32 at `i32[i * 4 + 3]`. One 16-byte block, so one cache line serves all three.
   * `settledStamp` stays separate: it is read once per pop at the popped edge, never alongside
   * these three, so folding it in would only widen the stride that made this work.
   */
  private readonly stateBuf: ArrayBuffer;
  private readonly distV: Float64Array;
  private readonly metaV: Int32Array;
  private readonly settledStamp: Int32Array;
  private generation = 0;

  /** Binary min-heap over edge indices, keyed by tentative cost. */
  private readonly heapEdge: Int32Array;
  private readonly heapCost: Float64Array;
  private heapSize = 0;

  /**
   * The BACKWARD search's own state, allocated once alongside the forward search's.
   *
   * Same layout, same generation-counter trick, deliberately separate arrays: the two searches run
   * concurrently over the same query, so they cannot share a distance or settled array.
   *
   * `push`/`pop` are duplicated below rather than parameterised, and that is a considered choice
   * rather than laziness. Parameterising them, or hoisting them into a heap class, would edit the
   * hottest loop in the project on a machine that has just been shown unable to resolve a 10%
   * regression: run-to-run wall time on identical code has moved 6x here. A refactor whose cost
   * cannot be measured is a refactor taken on faith. The duplication is 40 lines, both copies sit
   * together, and `gate:equality` compares the rungs edge by edge.
   */
  private readonly stateBufB: ArrayBuffer;
  private readonly distB: Float64Array;
  private readonly metaB: Int32Array;
  private readonly settledStampB: Int32Array;
  private readonly heapEdgeB: Int32Array;
  private readonly heapCostB: Float64Array;
  private heapSizeB = 0;

  /**
   * REVERSE ADJACENCY: for vertex v, every directed edge e with `edgeTo[e] === v`.
   *
   * The CSR the graph ships lists edges LEAVING a vertex, which is all a forward search needs. A
   * backward search needs the edges arriving at one, and deriving that per query would cost a scan
   * of the whole edge array. Built once, 2.1 MB against 532,951 edges.
   */
  private readonly rcsrOffset: Int32Array;
  private readonly rcsrEdge: Int32Array;

  /**
   * For edge f, its slot within the outgoing CSR block of `edgeFrom[f]`.
   *
   * The turn cost of the manoeuvre e to f is `turnSec[turnOff[e] + slot]`, where slot is f's index
   * inside the outgoing block of the shared vertex. The forward loop gets that slot for free from
   * the cursor it is already walking. The backward loop arrives from the other side and would have
   * to search the block for f, turning one array read into a scan of the vertex's degree. Each edge
   * leaves exactly one vertex and appears in exactly one block, so the slot is a property of the
   * edge and precomputes cleanly.
   */
  private readonly slotOf: Int32Array;

  /** For edge p, its slot within the REVERSE CSR block of `edgeTo[p]`. The mirror of `slotOf`. */
  private readonly predSlotOf: Int32Array;

  /**
   * The state expansion at via-way edges. See the constructor for what it is for and what it costs.
   *
   * `edgeViaWay[e]` is 1 for the keys of `bannedSequences`, read once per relaxation, which is why
   * it is a `Uint8Array` and not a wider one: 64 edges to a cache line rather than 16.
   * `fwdBase`/`bwdBase` give the first state index of that edge's block, or -1 for the vast
   * majority of edges whose state is just the edge index. `stateEdge` maps any state back to its
   * edge, and `stateOther` to the neighbour it commits to: the PREDECESSOR in a forward block, the
   * SUCCESSOR in a backward block, and -1 both for seeds and for every unexpanded state.
   */
  private readonly edgeViaWay: Uint8Array;
  private readonly fwdBase: Int32Array;
  private readonly bwdBase: Int32Array;
  private readonly stateEdge: Int32Array;
  private readonly stateOther: Int32Array;
  private readonly stateCount: number;

  /** Shape id to its (one or two) directed edges, so a snap can seed both directions. */
  private readonly edgesOfShape: Map<number, number[]>;

  /**
   * Traversal cost of every edge in seconds, precomputed once.
   *
   * This used to be `length / (speed * KMH_TO_MS)` evaluated inside the relaxation loop, which
   * put a float DIVISION plus two typed-array reads on the hottest path in the project. It ran
   * 1,388,769 times on one cross-city route. Precomputing costs 4.3 MB against 532,951 edges and
   * turns the inner cost into a single Float64Array read.
   */
  private readonly secs: Float64Array;

  /**
   * Pure travel time per edge, with no preference terms.
   *
   * Kept alongside `secs` because the two answer different questions and conflating them is how a
   * modelled cost gets reported as a duration. `secs` is what the search minimises; `driveSecs` is
   * the only thing comparable to another router's answer.
   */
  private readonly driveSecs: Float64Array;

  /**
   * The distance preference charged per edge, quality weight already applied.
   *
   * Precomputed for the same reason `secs` is, but kept SEPARATELY because the reported
   * `distanceSeconds` can no longer be recovered as `metres * secondsPerKm`: with a per-class
   * weight the charge depends on which classes the route used, not only how far it went. Deriving
   * it from the total would report a number the search never charged.
   */
  private readonly distSecs: Float64Array;

  /**
   * The toll charge per edge in seconds, precomputed for the same reason `distSecs` is: with two
   * mechanisms and a per-road rate it is no longer recoverable from metres, and deriving it from
   * the total would report a number the search never charged.
   */
  private readonly tollSecs: Float64Array;

  /** The objective in force. Held so per-request options can be resolved against it. */
  private readonly obj: ObjectiveConfig;

  /** Priority of the state most recently returned by `pop`. See there for why it is needed. */
  private poppedCost = 0;

  /**
   * Accumulator that exists ONLY so `dijkstra-h-discarded` genuinely evaluates the heuristic
   * rather than having it optimised away. Never read by the router, never part of a result.
   */
  public hSinkForBenchmarks = 0;

  /**
   * THE A\* HEURISTIC RATE: the cheapest seconds per metre any edge in this graph can cost.
   *
   * ADMISSIBILITY PROOF, and it must be read as covering all four cost terms rather than time
   * alone, because this objective is no longer time alone.
   *
   * The heuristic is `h(e) = greatCircle(head(e), target) * hSecondsPerM`. Take any real path P
   * from `head(e)` to the target point, of length `L` metres. Then:
   *
   *   cost(P) = drive(P) + distance(P) + toll(P) + turns(P)
   *
   *   drive(P)    = sum over edges of len/speed  >=  L / vMax          vMax is the fastest edge
   *                                                                   speed present in the graph,
   *                                                                   measured here, not assumed
   *   distance(P) = sum of len * k * quality     >=  L * k * minQuality   k = secondsPerKm/1000
   *   toll(P)     >= 0                           tolls are priced, never credited
   *   turns(P)    >= 0                           every TURN_COST term is non-negative, enforced
   *                                              mechanically at construction
   *
   *   so  cost(P) >= L * (1/vMax + k*minQuality) = L * hSecondsPerM >= greatCircle * hSecondsPerM
   *
   * the last step because a great circle is the shortest path between two points on the sphere,
   * so `L >= greatCircle(head(e), target)` for every P. Therefore `h` never exceeds the true
   * remaining cost, which is admissibility.
   *
   * IT IS ALSO CONSISTENT, which is what licenses settling a state once and never revisiting it.
   * `h` is `hSecondsPerM` times a metric, so `|h(u) - h(v)| <= greatCircle(u,v) * hSecondsPerM`
   * by the triangle inequality, while the arc cost `c(u,v) >= len(u,v) * hSecondsPerM >=
   * greatCircle(u,v) * hSecondsPerM` by the same bound as above. So `h(u) <= c(u,v) + h(v)`.
   *
   * THE TWO PLACES THIS WOULD SILENTLY BREAK, both guarded rather than trusted:
   *   1. A NEGATIVE term anywhere in the objective. Then the bounds above stop holding and A\*
   *      returns wrong routes rather than no routes. `assertNonNegative` and the constructor
   *      checks make that a throw instead.
   *   2. Including the DISTANCE term in `h` but forgetting `minQuality`. Using `k` alone would
   *      overestimate on motorway, where quality is 0.30, and overestimating is inadmissible.
   *
   * Including the distance term at all is optional for correctness and worth it for speed: it
   * makes `h` tighter, so fewer states get settled, and it stays a lower bound because it uses
   * the minimum quality weight rather than the route's actual one.
   */
  private readonly hSecondsPerM: number;

  /**
   * `h` memoised per VERTEX, with the same generation-counter trick as the search state.
   *
   * MEASURED, not preemptive. The first cut evaluated the heuristic on every push, which is once
   * per relaxation, and the benchmark showed nanoseconds per settled state rising from 507 to 714
   * on initial routes. On the long queries that set p95 A\* prunes almost nothing, so that overhead
   * was a straight 41% loss with no saving to pay for it. A vertex's heuristic cannot change during
   * a query, and a vertex is relaxed many times, so caching turns O(relaxations) haversines into
   * O(vertices touched).
   */
  private readonly hCache: Float64Array;
  private readonly hStamp: Int32Array;

  /**
   * Turn costs, or null when the caller passed no model.
   *
   * Optional on purpose. The toy graphs the ladder is tested on have no meaningful bearings, and
   * forcing a turn model on them would make every unit test assert against angles rather than
   * against the search. Production always passes one; `null` means every turn is free, which is
   * exactly the behaviour this class had before turn costs existed.
   */
  private readonly turns: TurnCosts | null;

  constructor(
    private readonly g: RoutableGraph,
    private readonly r: Restrictions,
    turnCost?: TurnCostConfig,
    objective?: ObjectiveConfig,
  ) {
    const n = g.edgeFrom.length;
    this.turns = turnCost === undefined ? null : buildTurnCosts(g, turnCost);
    // Defaulting to all-zero preferences keeps every toy-graph test asserting on pure travel time,
    // which is what makes a failure there mean the SEARCH is wrong rather than the objective.
    this.obj = objective ?? { secondsPerKm: 0, secondsPerRupee: 0, avoidTollsByDefault: false };
    if (this.obj.qualityByRank !== undefined && this.obj.qualityByRank.some((q) => !(q >= 0))) {
      throw new Error('OBJECTIVE quality weights must be non-negative or A* is no longer admissible.');
    }
    if (this.obj.secondsPerKm < 0 || this.obj.secondsPerRupee < 0) {
      // Same reason the turn costs check: a negative preference does not fail, it silently breaks
      // A* admissibility and returns routes that are wrong rather than routes that are missing.
      throw new Error('OBJECTIVE costs must be non-negative or A* is no longer admissible.');
    }
    // Reverse adjacency, by counting sort into a CSR of the same shape as the forward one. Built
    // before the search arrays because the state expansion below decides how large those are.
    const nv = g.vertexLat.length;
    this.rcsrOffset = new Int32Array(nv + 1);
    this.rcsrEdge = new Int32Array(n);
    this.slotOf = new Int32Array(n);
    this.predSlotOf = new Int32Array(n);
    // Written as explicit read-modify-write rather than `++`: `noUncheckedIndexedAccess` is on
    // repo-wide, so an indexed increment does not type check, and scattering assertions to silence
    // it is exactly what this package's rules forbid.
    for (let e = 0; e < n; e++) {
      const t = (g.edgeTo[e] as number) + 1;
      this.rcsrOffset[t] = (this.rcsrOffset[t] as number) + 1;
    }
    for (let v = 0; v < nv; v++) {
      this.rcsrOffset[v + 1] = (this.rcsrOffset[v + 1] as number) + (this.rcsrOffset[v] as number);
    }
    const cursor = new Int32Array(nv);
    for (let e = 0; e < n; e++) {
      const v = g.edgeTo[e] as number;
      const c = cursor[v] as number;
      this.rcsrEdge[(this.rcsrOffset[v] as number) + c] = e;
      cursor[v] = c + 1;
    }
    for (let v = 0; v < nv; v++) {
      const s = g.csrOffset[v] as number;
      const t = g.csrOffset[v + 1] as number;
      for (let i = s; i < t; i++) this.slotOf[g.csrEdge[i] as number] = i - s;
      const rs = this.rcsrOffset[v] as number;
      const rt = this.rcsrOffset[v + 1] as number;
      for (let i = rs; i < rt; i++) this.predSlotOf[this.rcsrEdge[i] as number] = i - rs;
    }

    /**
     * STATE EXPANSION AT VIA-WAY EDGES. This is what makes the search EXACT there.
     *
     * The search state was one directed edge, with the edge it arrived from recovered by reading
     * the parent array. That is exact for a via-NODE ban, which is a statement about a pair, and it
     * is WRONG for a via-WAY ban, which is a statement about an ordered triple. The parent array
     * holds the CHEAPEST predecessor, so the triple gets judged against that one arrival, and a
     * legal-but-costlier approach to the same via way is never considered.
     *
     * The measured case, from `gate:equality`: the triple 290382 -> 279799 -> 290383 is banned. The
     * search settled 279799 from 290382, judged the continuation banned, and returned an 814.9 m
     * detour. Reaching 279799 from 13974 instead makes the same continuation legal and the route
     * 539.1 m. The route it returned was 51% longer than a legal alternative.
     *
     * So a via-way edge gets one state PER INCOMING EDGE for the forward search, and one state PER
     * OUTGOING EDGE for the backward search, plus one more each for "no predecessor" and "no
     * successor" at a seed. Both directions need it: the backward search has the mirror problem,
     * committing to a single cheapest SUCCESSOR, and if only one side were exact the two rungs
     * would disagree again for the opposite reason.
     *
     * THE PRICE IS TINY AND THAT IS THE POINT. Only the keys of `bannedSequences` are expanded, 12
     * edges in this graph out of 532,951, so the extra states number in the dozens. Slot 0 of each
     * block is the no-neighbour case, so the neighbour slot is `1 + slot`, which needs no degree
     * lookup in the hot path.
     */
    this.edgeViaWay = new Uint8Array(n);
    this.fwdBase = new Int32Array(n).fill(-1);
    this.bwdBase = new Int32Array(n).fill(-1);
    let stateTop = n;
    for (const via of r.bannedSequences.keys()) {
      this.edgeViaWay[via] = 1;
      const uIn = g.edgeFrom[via] as number;
      const vOut = g.edgeTo[via] as number;
      this.fwdBase[via] = stateTop;
      stateTop += (this.rcsrOffset[uIn + 1] as number) - (this.rcsrOffset[uIn] as number) + 1;
      this.bwdBase[via] = stateTop;
      stateTop += (g.csrOffset[vOut + 1] as number) - (g.csrOffset[vOut] as number) + 1;
    }
    this.stateCount = stateTop;
    this.stateEdge = new Int32Array(stateTop);
    this.stateOther = new Int32Array(stateTop).fill(-1);
    for (let e = 0; e < n; e++) this.stateEdge[e] = e;
    for (const via of r.bannedSequences.keys()) {
      const uIn = g.edgeFrom[via] as number;
      const fb = this.fwdBase[via] as number;
      const rs = this.rcsrOffset[uIn] as number;
      const rt = this.rcsrOffset[uIn + 1] as number;
      this.stateEdge[fb] = via;
      for (let i = rs; i < rt; i++) {
        this.stateEdge[fb + 1 + (i - rs)] = via;
        this.stateOther[fb + 1 + (i - rs)] = this.rcsrEdge[i] as number;
      }
      const vOut = g.edgeTo[via] as number;
      const bb = this.bwdBase[via] as number;
      const cs = g.csrOffset[vOut] as number;
      const ct = g.csrOffset[vOut + 1] as number;
      this.stateEdge[bb] = via;
      for (let i = cs; i < ct; i++) {
        this.stateEdge[bb + 1 + (i - cs)] = via;
        this.stateOther[bb + 1 + (i - cs)] = g.csrEdge[i] as number;
      }
    }

    const ns = this.stateCount;
    this.stateBuf = new ArrayBuffer(ns * 16);
    this.distV = new Float64Array(this.stateBuf);
    this.metaV = new Int32Array(this.stateBuf);
    this.settledStamp = new Int32Array(ns);
    this.heapEdge = new Int32Array(ns + 1);
    this.heapCost = new Float64Array(ns + 1);
    this.stateBufB = new ArrayBuffer(ns * 16);
    this.distB = new Float64Array(this.stateBufB);
    this.metaB = new Int32Array(this.stateBufB);
    this.settledStampB = new Int32Array(ns);
    this.heapEdgeB = new Int32Array(ns + 1);
    this.heapCostB = new Float64Array(ns + 1);
    this.secs = new Float64Array(n);
    this.driveSecs = new Float64Array(n);
    // Per-metre so the hot loop never divides by 1000. The toll term is folded in here rather than
    // branched on during relaxation: an edge's toll status cannot change between queries, only
    // whether the query TOLERATES it, and that is a separate check.
    const perM = this.obj.secondsPerKm / 1000;
    /**
     * TOLL SECONDS PER EDGE: THE SEARCH PROXY, and deliberately not what the driver is billed.
     *
     * ⛔ A SHORTEST PATH CAN ONLY MINIMISE AN ADDITIVE COST, and neither real mechanism here is
     * additive. A barrier fee is a step function of position; an entry-exit fare is a function of
     * the whole run. Putting a barrier fee on the one edge that contains the plaza IS additive and
     * was tried, and it produced a measured defect: 140 rupees landed on a single 604 m edge as a
     * 37 minute penalty, and the router answered by leaving the expressway at an interchange and
     * rejoining past the barrier. The cost model was correct edge by edge and wrong as a route.
     *
     * So every road contributes a SMOOTH per-kilometre rate here, close to its own real average,
     * and `priceTolls` computes the billed truth once over the chosen path by that road's exact
     * mechanism. `DESIGN.md` states the pattern once under "The search proxy and the billed truth".
     * The two agree closely and are never required to agree exactly.
     */
    const rupeesPerM = new Float64Array(256);
    for (const r of this.obj.tollRoads ?? []) {
      if (r.id < 0 || r.id > 255) throw new Error(`TOLL_ROADS id ${r.id} is out of the u8 range the artifact stores.`);
      if (r.ratePerKm < 0 || r.feeRupees < 0 || r.searchRatePerKm < 0) {
        // Same reason turn costs and quality weights are checked: a negative toll does not fail
        // loudly, it silently breaks A* admissibility and returns routes that are wrong.
        throw new Error(`TOLL_ROADS entry ${r.key} has a negative amount; A* is no longer admissible.`);
      }
      rupeesPerM[r.id] = r.searchRatePerKm / 1000;
    }
    const secPerRupee = this.obj.secondsPerRupee;
    // The quality weight is resolved to a per-metre rate PER CLASS RANK once, here, so the hot
    // loop never indexes a second table. An absent weights array means a flat rate on every class,
    // which is the pre-quality objective and what the toy graphs want.
    const quality = this.obj.qualityByRank;
    const perMByRank = new Float64Array(256);
    for (let r = 0; r < 256; r++) perMByRank[r] = perM * (quality === undefined ? 1 : (quality[r] ?? 1));
    this.distSecs = new Float64Array(n);
    this.tollSecs = new Float64Array(n);
    this.edgesOfShape = new Map();
    for (let e = 0; e < n; e++) {
      const lenM = g.edgeLengthM[e] as number;
      const drive = lenM / ((g.edgeSpeedKmh[e] as number) * KMH_TO_MS);
      this.driveSecs[e] = drive;
      const dist = lenM * (perMByRank[g.edgeClassRank[e] as number] as number);
      this.distSecs[e] = dist;
      const road = g.edgeTollRoad[e] as number;
      const toll = road === 0 ? 0 : lenM * (rupeesPerM[road] as number) * secPerRupee;
      this.tollSecs[e] = toll;
      this.secs[e] = drive + dist + toll;
      const s = g.edgeShape[e] as number;
      const list = this.edgesOfShape.get(s);
      if (list) list.push(e);
      else this.edgesOfShape.set(s, [e]);
    }

    // MEASURED from the graph, never taken from `CLASS_SPEED_KMH`. A `maxspeed` tag can exceed
    // every class default, and a heuristic built on a speed the graph can beat is inadmissible.
    let vMaxKmh = 1;
    for (let e = 0; e < n; e++) {
      const s = g.edgeSpeedKmh[e] as number;
      if (s > vMaxKmh) vMaxKmh = s;
    }
    // Likewise the SMALLEST quality weight, since that is the cheapest a metre of distance
    // preference can be charged. `?? 1` for ranks the table does not cover, so the minimum is
    // taken against 1 as well.
    const minQuality = quality === undefined ? 1 : Math.min(1, ...quality);
    this.hSecondsPerM = 1 / (vMaxKmh * KMH_TO_MS) + (this.obj.secondsPerKm * minQuality) / 1000;
    this.hCache = new Float64Array(g.vertexLat.length);
    this.hStamp = new Int32Array(g.vertexLat.length);
  }

  // push and pop hoist `this.heapEdge` / `this.heapCost` into locals for the same reason the
  // search loop does: these run millions of times per long route, and a property load per array
  // access is a measurable fraction of the work at that count.

  private push(edge: number, cost: number): void {
    const he = this.heapEdge;
    const hc = this.heapCost;
    let i = ++this.heapSize;
    he[i] = edge;
    hc[i] = cost;
    while (i > 1) {
      const p = i >> 1;
      const pc = hc[p] as number;
      const c = hc[i] as number;
      // Tie-break on edge index so ordering is total and reproducible.
      if (pc < c || (pc === c && (he[p] as number) <= (he[i] as number))) break;
      const te = he[p] as number;
      he[p] = he[i] as number;
      hc[p] = c;
      he[i] = te;
      hc[i] = pc;
      i = p;
    }
  }

  private pop(): number {
    const he = this.heapEdge;
    const hc = this.heapCost;
    const top = he[1] as number;
    // The PRIORITY of the state just popped, recorded because the termination test needs it and it
    // is not recoverable afterwards. Under Dijkstra this equals `dist[top]`; under A* it is
    // `dist[top] + h(top)`, and using `dist` there would stop the search on the wrong quantity.
    this.poppedCost = hc[1] as number;
    he[1] = he[this.heapSize] as number;
    hc[1] = hc[this.heapSize] as number;
    const size = --this.heapSize;
    let i = 1;
    for (;;) {
      const l = i << 1;
      const rr = l + 1;
      let best = i;
      let bc = hc[i] as number;
      if (l <= size) {
        const lc = hc[l] as number;
        if (lc < bc || (lc === bc && (he[l] as number) < (he[best] as number))) {
          best = l;
          bc = lc;
        }
      }
      if (rr <= size) {
        const rc = hc[rr] as number;
        if (rc < bc || (rc === bc && (he[rr] as number) < (he[best] as number))) best = rr;
      }
      if (best === i) break;
      const te = he[best] as number;
      const tc = hc[best] as number;
      he[best] = he[i] as number;
      hc[best] = hc[i] as number;
      he[i] = te;
      hc[i] = tc;
      i = best;
    }
    return top;
  }

  // The backward heap. Identical to `push`/`pop` above on its own arrays; see `stateBufB` for why
  // this is duplicated rather than parameterised.

  private pushB(edge: number, cost: number): void {
    const he = this.heapEdgeB;
    const hc = this.heapCostB;
    let i = ++this.heapSizeB;
    he[i] = edge;
    hc[i] = cost;
    while (i > 1) {
      const p = i >> 1;
      const pc = hc[p] as number;
      const c = hc[i] as number;
      if (pc < c || (pc === c && (he[p] as number) <= (he[i] as number))) break;
      const te = he[p] as number;
      he[p] = he[i] as number;
      hc[p] = c;
      he[i] = te;
      hc[i] = pc;
      i = p;
    }
  }

  private popB(): number {
    const he = this.heapEdgeB;
    const hc = this.heapCostB;
    const top = he[1] as number;
    he[1] = he[this.heapSizeB] as number;
    hc[1] = hc[this.heapSizeB] as number;
    const size = --this.heapSizeB;
    let i = 1;
    for (;;) {
      const l = i << 1;
      const rr = l + 1;
      let best = i;
      let bc = hc[i] as number;
      if (l <= size) {
        const lc = hc[l] as number;
        if (lc < bc || (lc === bc && (he[l] as number) < (he[best] as number))) {
          best = l;
          bc = lc;
        }
      }
      if (rr <= size) {
        const rc = hc[rr] as number;
        if (rc < bc || (rc === bc && (he[rr] as number) < (he[best] as number))) best = rr;
      }
      if (best === i) break;
      const te = he[best] as number;
      const tc = hc[best] as number;
      he[best] = he[i] as number;
      hc[best] = hc[i] as number;
      he[i] = te;
      hc[i] = tc;
      i = best;
    }
    return top;
  }

  /**
   * True when moving out of `via` onto `to` is forbidden.
   *
   * Only ever called when `edgeRestricted[via]` is set, so the Map lookups are off the hot path.
   * `from` is the predecessor of `via`, or -1 at the start of a search, which matches no
   * recorded triple.
   */
  private forbidden(via: number, to: number, from: number): boolean {
    const pair = this.r.banned.get(via);
    if (pair !== undefined && pair.has(to)) return true;
    const seq = this.r.bannedSequences.get(via);
    if (seq !== undefined) {
      for (const s of seq) {
        if (s.toEdge === to && s.fromEdge === from) return true;
      }
    }
    return false;
  }

  /**
   * Shortest-time route between two snapped points.
   *
   * `startFraction` and `endFraction` run 0..1 along the DIRECTED edge given. Both directed
   * edges of the snapped segment are seeded, because a driver on a two-way road may legally
   * leave in either direction and picking one arbitrarily produces a route that starts with a
   * phantom U-turn.
   */
  route(
    startEdge: number,
    startFraction: number,
    endEdge: number,
    endFraction: number,
    opts?: RouteOptions,
  ): RouteResult | null {
    const g = this.g;
    const avoidTolls = opts?.avoidTolls ?? this.obj.avoidTollsByDefault;
    if ((opts?.algorithm ?? 'dijkstra') === 'bidirectional') {
      return this.routeBi(startEdge, startFraction, endEdge, endFraction, avoidTolls);
    }
    const gen = ++this.generation;
    this.heapSize = 0;
    let settled = 0;
    let relaxed = 0;
    let restrictionsApplied = 0;

    const endShape = g.edgeShape[endEdge] as number;
    // The end is at most TWO directed edges, the given one and its reverse twin, so they are held
    // as two scalars rather than iterated. `for (const ec of endCandidates)` ran once per pop and
    // allocated an array iterator each time: 490,961 short-lived objects on one cross-city route,
    // all of it pure GC pressure inside the hot loop.
    const endList = this.edgesOfShape.get(endShape);
    const endA = endEdge;
    let endB = -1;
    if (endList !== undefined) {
      for (let i = 0; i < endList.length; i++) {
        const c = endList[i] as number;
        if (c !== endEdge) endB = c;
      }
    }
    // Fraction is measured along the given directed edge; the opposite edge measures from the
    // other end, so it has to be mirrored rather than reused.
    const fracA = endFraction;
    const fracB = 1 - endFraction;

    // THE HEURISTIC TARGET IS THE SNAPPED POINT, not the end edge's far vertex.
    //
    // This matters and is easy to get wrong. `dist[e]` is the cost of reaching the FAR end of `e`,
    // and a route finishing on the end edge gets the unused tail refunded. A heuristic aimed at a
    // vertex would therefore bound a quantity the search never pays. Aiming at the point itself
    // makes `h` a bound on exactly what remains to be paid, refund included, because any path must
    // physically reach that point.
    const algorithm = opts?.algorithm ?? 'dijkstra';
    const useAStar = algorithm === 'astar';
    // Measurement mode: evaluate the heuristic, then discard it. See `RoutingAlgorithm`.
    const discardH = algorithm === 'dijkstra-h-discarded';
    const wantH = useAStar || discardH;
    let targetLat = 0;
    let targetLon = 0;
    if (wantH) {
      const pts = clipPolyline(this.shapeInTravelOrder(endEdge), 0, endFraction);
      const t = pts[pts.length - 1] as LngLat;
      targetLon = t[0];
      targetLat = t[1];
    }
    const hRate = this.hSecondsPerM;
    const vertexLat = g.vertexLat;
    const vertexLon = g.vertexLon;
    /**
     * NEGATIVE on the two end edges, and this was a bug when it was zero.
     *
     * `dist[e]` is the cost of reaching an edge's FAR end, but the goal lies partway ALONG the end
     * edge, so the remaining cost from that far end is a REFUND of the unused tail: a negative
     * number. The first version returned zero here on the reasoning that "no positive bound is
     * valid, and zero always is". Zero is not a lower bound for a negative quantity, so `h` was
     * inadmissible on exactly the two edges the search is aiming at.
     *
     * WHAT IT COST, measured rather than argued: the termination test compares the popped priority
     * against the best completion found. With `h = 0` at the end edges, the search popped the first
     * end edge it reached and stopped, because `dist[endA] >= dist[endA] - refundA` is true for any
     * refund. If the CHEAPER completion arrived on the opposite carriageway, whose refund can be
     * almost a whole edge, it was never examined. `gate:equality` found this by disagreeing with
     * the bidirectional rung on 10 of 190 pairs, all of them legal routes that bidirectional found
     * for less, diverging at ORDINARY junctions rather than at restriction sites.
     *
     * The refund is exact, not a bound, so the heuristic stays consistent: any real path from
     * `head(u)` to the goal through end edge X costs `c(u,X) - refundX`, and `h(u)` already
     * lower-bounds that.
     */
    const refundA = (1 - fracA) * (this.secs[endA] as number);
    const refundB = endB === -1 ? 0 : (1 - fracB) * (this.secs[endB] as number);
    const hCache = this.hCache;
    const hStamp = this.hStamp;
    const h = (e: number): number => {
      if (!wantH) return 0;
      // The end-edge test stays OUTSIDE the cache deliberately. It is a property of the edge, not
      // of its head vertex, and other edges can share that vertex; caching this against the vertex
      // would hand it to them and quietly make the heuristic wrong near the goal.
      if (e === endA) return -refundA;
      if (e === endB) return -refundB;
      const v = g.edgeTo[e] as number;
      if (hStamp[v] !== gen) {
        hStamp[v] = gen;
        hCache[v] = haversineM(vertexLat[v] as number, vertexLon[v] as number, targetLat, targetLon) * hRate;
      }
      return hCache[v] as number;
    };
    /**
     * Adding zero times the heuristic is not the same as not computing it, and it is also not
     * something an optimiser is free to elide, because the value is accumulated into a field the
     * benchmark reads afterwards. That is what makes the measurement mode pay the heuristic's real
     * cost while searching exactly as Dijkstra does.
     */
    const priority = (e: number, g0: number): number => {
      const hv = h(e);
      if (!discardH) return g0 + hv;
      this.hSinkForBenchmarks += hv;
      return g0;
    };

    const startShape = g.edgeShape[startEdge] as number;
    for (const se of this.edgesOfShape.get(startShape) ?? [startEdge]) {
      const frac = se === startEdge ? startFraction : 1 - startFraction;
      const remaining = (1 - frac) * (this.secs[se] as number);
      // Slot 0 of a block is the no-predecessor case, which is exactly what a seed is: the driver
      // did arrive here from somewhere, but nothing in the query says where, so no triple binds.
      const s0 = (this.fwdBase[se] as number) < 0 ? se : (this.fwdBase[se] as number);
      this.distV[s0 * 2] = remaining;
      this.metaV[s0 * 4 + 2] = -1;
      this.metaV[s0 * 4 + 3] = gen;
      this.push(s0, priority(se, remaining));
    }

    // Zero for A\*, whose heuristic now carries the refund exactly. See the termination test.
    const termSlack = useAStar ? 0 : Math.max(refundA, refundB);

    let bestEnd = -1;
    let bestTotal = Infinity;

    // Hoisted out of `this` for the duration of the loop. Every `this.dist[f]` is a property load
    // followed by an element load; at 1.4 million relaxations the property half is not free.
    const distV = this.distV;
    const metaV = this.metaV;
    const settledStamp = this.settledStamp;
    const secs = this.secs;
    const edgeTo = g.edgeTo;
    const csrOffset = g.csrOffset;
    const csrEdge = g.csrEdge;
    const edgeRestricted = this.r.edgeRestricted;
    const edgeToll = g.edgeToll;
    // Hoisted like the rest. `turnSec` is indexed by (incoming edge block, slot), so the inner
    // loop reads it sequentially with the CSR cursor it is already walking: one array read per
    // relaxation, no branch, no lookup. Null when no turn model was supplied, in which case the
    // whole term is skipped by a single predicted-false check per relaxation.
    const turnOff = this.turns === null ? null : this.turns.offset;
    const turnSec = this.turns === null ? null : this.turns.seconds;
    const stateEdge = this.stateEdge;
    const stateOther = this.stateOther;
    const edgeViaWay = this.edgeViaWay;
    const fwdBase = this.fwdBase;
    const predSlotOf = this.predSlotOf;

    while (this.heapSize > 0) {
      const s = this.pop();
      const poppedCost = this.poppedCost;
      if (settledStamp[s] === gen) continue;
      settledStamp[s] = gen;
      settled++;
      const e = stateEdge[s] as number;
      const de = distV[s * 2] as number;

      // Reaching the end segment: stop partway along it rather than at its far vertex.
      if (e === endA || e === endB) {
        const endFrac = e === endA ? fracA : fracB;
        // If this is the seeded start edge, the destination is only reachable without leaving it
        // when it lies FURTHER along the direction of travel. Otherwise the driver must go round,
        // and the search finds that path by arriving on this edge again from elsewhere.
        const seededFrac =
          e === startEdge ? startFraction : g.edgeShape[e] === startShape ? 1 - startFraction : -1;
        if (!(seededFrac >= 0 && (metaV[s * 4 + 2] as number) === -1 && endFrac < seededFrac)) {
          const total = de - (1 - endFrac) * (secs[e] as number);
          if (total < bestTotal) {
            bestTotal = total;
            bestEnd = s;
          }
        }
      }
      // Everything still queued has priority at least `poppedCost`, so once no queued state can
      // complete below the best completion found, there is nothing left that can improve it.
      //
      // `termSlack` IS THE REFUND, and leaving it out was a bug. Priority lower-bounds the cost of
      // reaching an edge's FAR END, but a route stops partway along the end edge and gets the
      // unused tail refunded, so the cheapest completion through a queued state is its priority
      // MINUS that refund. Under A\* the refund is already inside `h`, which now returns the exact
      // negative value on the two end edges, so no slack is needed. Under the h-free rungs nothing
      // accounts for it, so the largest possible refund is subtracted here. The refund can be
      // almost a whole edge on the opposite carriageway, which is exactly the case that was lost:
      // the search stopped at the first end edge it reached and never examined the other direction.
      if (bestEnd !== -1 && poppedCost - termSlack >= bestTotal) break;

      const v = edgeTo[e] as number;
      // THE ARRIVING EDGE, READ FROM THE STATE rather than from the parent array. -1 on every
      // unexpanded state, which is correct rather than lossy: `from` is consulted only by the
      // sequence table, and only via-way edges have entries there, and those are exactly the edges
      // that get a state per predecessor. The parent-array read this replaces was the defect.
      const from = stateOther[s] as number;
      const restricted = edgeRestricted[e] === 1;
      const start = csrOffset[v] as number;
      const end = csrOffset[v + 1] as number;
      const turnBase = turnOff === null ? 0 : (turnOff[e] as number);

      for (let i = start; i < end; i++) {
        const f = csrEdge[i] as number;
        // Excluding a tolled edge is a HARD filter, not a big penalty. "Avoid tolls" means the
        // route must not use one; pricing it very high instead would still return a tolled route
        // when no free one exists, which is the opposite of what the caller asked for.
        if (avoidTolls && edgeToll[f] === 1) continue;
        if (restricted && this.forbidden(e, f, from)) {
          restrictionsApplied++;
          continue;
        }
        // Turn cost is charged on the ARC, so it is part of the tentative distance and is subject
        // to the same relaxation as everything else. Charging it anywhere later would let a cheap
        // arrival win on edge cost and then pay a turn it never competed on.
        const nd =
          de + (secs[f] as number) + (turnSec === null ? 0 : (turnSec[turnBase + (i - start)] as number));
        relaxed++;
        // ONE BYTE read per relaxation, predicted false for 532,939 of 532,951 edges. Deliberately
        // a `Uint8Array` rather than testing `fwdBase[f] < 0`: at 64 edges to a cache line instead
        // of 16, the common case costs a quarter of the misses, and the wider lookup happens only
        // on the twelve edges that need it.
        const ns = edgeViaWay[f] === 0 ? f : (fwdBase[f] as number) + 1 + (predSlotOf[e] as number);
        const m = ns * 4;
        if (metaV[m + 3] !== gen) {
          metaV[m + 3] = gen;
          distV[ns * 2] = nd;
          metaV[m + 2] = s;
          this.push(ns, priority(f, nd));
        } else if (nd < (distV[ns * 2] as number)) {
          distV[ns * 2] = nd;
          metaV[m + 2] = s;
          this.push(ns, priority(f, nd));
        }
      }
    }

    if (bestEnd === -1) return null;

    const states: number[] = [];
    for (let s = bestEnd; s !== -1; s = this.metaV[s * 4 + 2] as number) states.push(s);
    states.reverse();
    const edges = states.map((s) => this.stateEdge[s] as number);

    const firstEdge = edges[0] as number;
    const firstFraction =
      (this.metaV[(states[0] as number) * 4 + 2] as number) === -1
        ? (firstEdge === startEdge ? startFraction : 1 - startFraction)
        : 0;
    // Same mirroring as inside the loop: the fraction is measured along whichever of the two
    // directed edges of the end shape the search actually arrived on.
    const endFrac = (this.stateEdge[bestEnd] as number) === endA ? fracA : fracB;
    return this.finish(edges, firstFraction, endFrac, bestTotal, settled, relaxed, restrictionsApplied);
  }

  /**
   * A settled edge list turned into a `RouteResult`. Shared by every rung.
   *
   * Extracted so the rungs cannot drift in what they REPORT while agreeing on what they FOUND.
   * `gate:equality` compares edge sequences and costs; it would not catch two rungs that trimmed
   * the first edge differently, and a route whose reported metres disagree with its own geometry is
   * the kind of defect that surfaces as a wrong arrival time long after the search is trusted.
   * Runs once per query, so nothing here is hot.
   */
  private finish(
    edges: readonly number[],
    firstFraction: number,
    endFrac: number,
    total: number,
    settled: number,
    relaxed: number,
    restrictionsApplied: number,
  ): RouteResult {
    const g = this.g;
    const firstEdge = edges[0] as number;
    const lastEdge = edges[edges.length - 1] as number;
    const geometry = this.buildGeometry(edges, firstFraction, endFrac);
    // Components are trimmed with the SAME fractions as `metres`, because the route enters the
    // first edge partway and leaves the last partway. Summing untrimmed would charge distance and
    // toll for road the driver never covers, and the components would stop adding up to `seconds`.
    const sumTrimmed = (per: (e: number) => number): number => {
      let t = 0;
      for (const e of edges) t += per(e);
      t -= firstFraction * per(firstEdge);
      t -= (1 - endFrac) * per(lastEdge);
      return t;
    };
    const metres = sumTrimmed((e) => g.edgeLengthM[e] as number);
    const driveSeconds = sumTrimmed((e) => this.driveSecs[e] as number);
    const tollMetres = sumTrimmed((e) => (g.edgeToll[e] === 1 ? (g.edgeLengthM[e] as number) : 0));
    const distanceSeconds = sumTrimmed((e) => this.distSecs[e] as number);
    const tollSeconds = sumTrimmed((e) => this.tollSecs[e] as number);
    const { tollCost, tollConfidence } = this.priceTolls(edges, firstFraction, endFrac);

    // Recovered from the chosen path rather than accumulated during the search: the search
    // relaxes an edge many times and only the surviving parent chain is the route, so a running
    // total would count turns the route never took.
    let turnSeconds = 0;
    if (this.turns !== null) {
      const off = this.turns.offset;
      const sec = this.turns.seconds;
      for (let k = 0; k + 1 < edges.length; k++) {
        const a = edges[k] as number;
        const b = edges[k + 1] as number;
        const v = g.edgeTo[a] as number;
        const cs = g.csrOffset[v] as number;
        const ce = g.csrOffset[v + 1] as number;
        for (let i = cs; i < ce; i++) {
          if ((g.csrEdge[i] as number) === b) {
            turnSeconds += sec[(off[a] as number) + (i - cs)] as number;
            break;
          }
        }
      }
    }

    return {
      edges,
      seconds: total,
      driveSeconds,
      distanceSeconds,
      tollSeconds,
      tollMetres,
      tollCost,
      tollConfidence,
      tollDisplay: tollDisplayOf(tollConfidence, tollMetres),
      turnSeconds,
      metres,
      geometry,
      settled,
      relaxed,
      restrictionsApplied,
    };
  }

  /**
   * BIDIRECTIONAL DIJKSTRA. Same objective, same answer, a smaller searched region.
   *
   * The forward search grows from the start; the backward search grows from the destination over
   * reversed adjacency. They stop when the two frontiers can no longer improve on the best meeting
   * found, which is `topF + topB >= mu`.
   *
   * WHAT `distB` MEANS, because getting this wrong double counts or drops an edge. `distV[e]` is
   * the cost of reaching the FAR end of `e`, including traversing `e`. `distB[e]` is the cost of
   * getting from that same far end to the destination, NOT including `e`. So `distV[e] + distB[e]`
   * is a whole route through `e` with every edge counted once and the turn at the junction charged
   * exactly once, inside the backward label.
   *
   * The backward seeds are NEGATIVE, and that is correct rather than a hack. A route ends part way
   * along the end edge, so from that edge's far end the remaining cost is a refund of the unused
   * tail: `distB[endA] = -(1 - fracA) * secs[endA]`. It reproduces the forward search's
   * `total = de - (1 - endFrac) * secs[e]` exactly. Dijkstra needs non-negative ARC costs, which
   * still holds; initial labels may be any value.
   *
   * RESTRICTIONS IN REVERSE ORDER, which is the part that silently breaks.
   *
   * `forbidden(via, to, from)` reads: while on `via`, having arrived from `from`, you may not
   * continue to `to`. The forward search knows `from` (its parent) and is choosing `to`. The
   * backward search is walking the same manoeuvre from the other end, so at the moment it steps
   * from `cur` to a predecessor `pred` it knows `cur`'s SUCCESSOR, and the triple it can finally
   * decide is the one centred on `cur`: `forbidden(cur, succ, pred)`. One hop later than forward.
   *
   *   pair ban, decided immediately:  forbidden(pred, cur, -1)      may I go pred -> cur at all
   *   triple ban, deferred one hop:   forbidden(cur, succ, pred)    pred -> cur -> succ
   *
   * THE TRAP is writing that second call as `forbidden(cur, pred, succ)`. It type checks, it runs,
   * and it is invisible wherever the banned triple happens to read the same in both directions.
   * `gate:equality` audits for that mechanically: it counts how many of the via-way sites have a
   * triple whose reverse is NOT also banned, and fails the suite if that count is zero, because a
   * suite of only symmetric triples cannot detect this class of bug at all. It currently reports
   * 12 order-asymmetric sites and 0 symmetric.
   *
   * A MEETING IS ONLY TAKEN WHEN THE FAR SIDE IS SETTLED. A tentative label describes a real path,
   * so it would give a valid cost, but its parent chain can still change, and then the cost
   * reported would not be the cost of the path returned. Requiring both sides settled makes both
   * labels and both chains final. It stays complete: for the optimal route, whichever of the two
   * adjacent states is settled second relaxes across the junction while the other is already
   * settled, so the meeting is examined from one side or the other.
   */
  private routeBi(
    startEdge: number,
    startFraction: number,
    endEdge: number,
    endFraction: number,
    avoidTolls: boolean,
  ): RouteResult | null {
    const g = this.g;
    const gen = ++this.generation;
    this.heapSize = 0;
    this.heapSizeB = 0;
    let settled = 0;
    let relaxed = 0;
    let restrictionsApplied = 0;

    const startShape = g.edgeShape[startEdge] as number;
    const endShape = g.edgeShape[endEdge] as number;
    const endList = this.edgesOfShape.get(endShape);
    const endA = endEdge;
    let endB = -1;
    if (endList !== undefined) {
      for (let i = 0; i < endList.length; i++) {
        const c = endList[i] as number;
        if (c !== endEdge) endB = c;
      }
    }
    const fracA = endFraction;
    const fracB = 1 - endFraction;

    const distV = this.distV;
    const metaV = this.metaV;
    const settledStamp = this.settledStamp;
    const distB = this.distB;
    const metaB = this.metaB;
    const settledStampB = this.settledStampB;
    const secs = this.secs;
    const edgeTo = g.edgeTo;
    const edgeFrom = g.edgeFrom;
    const csrOffset = g.csrOffset;
    const csrEdge = g.csrEdge;
    const rcsrOffset = this.rcsrOffset;
    const rcsrEdge = this.rcsrEdge;
    const slotOf = this.slotOf;
    const predSlotOf = this.predSlotOf;
    const stateEdge = this.stateEdge;
    const stateOther = this.stateOther;
    const edgeViaWay = this.edgeViaWay;
    const fwdBase = this.fwdBase;
    const bwdBase = this.bwdBase;
    const edgeRestricted = this.r.edgeRestricted;
    const edgeToll = g.edgeToll;
    const turnOff = this.turns === null ? null : this.turns.offset;
    const turnSec = this.turns === null ? null : this.turns.seconds;

    // Seeded exactly as the forward rung does, tolled start and end edges included. `avoidTolls` is
    // a filter on edges the route may ENTER; refusing to seed the edge the driver is already on
    // would answer "no route" for a driver standing on a toll road.
    // Slot 0 of each block is the no-neighbour case, which is what a seed is in both directions.
    for (const se of this.edgesOfShape.get(startShape) ?? [startEdge]) {
      const frac = se === startEdge ? startFraction : 1 - startFraction;
      const remaining = (1 - frac) * (secs[se] as number);
      const s0 = (fwdBase[se] as number) < 0 ? se : (fwdBase[se] as number);
      distV[s0 * 2] = remaining;
      metaV[s0 * 4 + 2] = -1;
      metaV[s0 * 4 + 3] = gen;
      this.push(s0, remaining);
    }
    const seedBackward = (e: number, frac: number): void => {
      const refund = -(1 - frac) * (secs[e] as number);
      const s0 = (bwdBase[e] as number) < 0 ? e : (bwdBase[e] as number);
      distB[s0 * 2] = refund;
      metaB[s0 * 4 + 2] = -1;
      metaB[s0 * 4 + 3] = gen;
      this.pushB(s0, refund);
    };
    seedBackward(endA, fracA);
    if (endB !== -1) seedBackward(endB, fracB);

    let mu = Infinity;
    let meet = -1;
    let meetParentState = -1;
    let meetSuccState = -1;

    /**
     * `f` is the meeting edge, `pState` the forward state the route ARRIVES FROM, `succState` the
     * backward state the route CONTINUES INTO, and `total` the whole route's cost.
     *
     * Both neighbours are named as the states on either SIDE of `f`, never as a state on `f`
     * itself. That is deliberate: at a backward relaxation the meeting edge is the predecessor
     * being relaxed, whose own backward state does not exist yet, and an earlier version passed the
     * state sitting on the edge already settled instead. It type checked, cost nothing, and dropped
     * exactly one edge from every reconstructed path, which the cost-against-path check caught.
     *
     * States rather than edges because at a via-way edge several states share one edge, and which
     * pair meets decides the route.
     */
    const considerMeet = (f: number, pState: number, succState: number, total: number): void => {
      if (!(total < mu)) return;
      const p = pState === -1 ? -1 : (stateEdge[pState] as number);
      const succ = succState === -1 ? -1 : (stateEdge[succState] as number);
      // The same guard the forward rung applies: if the route would consist only of the seeded
      // start edge, the destination has to lie FURTHER along the direction of travel. Otherwise the
      // driver must go round, and that route arrives on this edge from elsewhere with a parent set.
      if (pState === -1 && succState === -1) {
        const seededFrac =
          f === startEdge ? startFraction : g.edgeShape[f] === startShape ? 1 - startFraction : -1;
        const endFracF = f === endA ? fracA : fracB;
        if (seededFrac >= 0 && endFracF < seededFrac) return;
      }
      // The one triple neither search could decide alone: it spans the junction where they met.
      // `succ` is exact here because a via-way edge carries one backward state per successor.
      if (edgeRestricted[f] === 1 && succ !== -1 && this.forbidden(f, succ, p)) {
        restrictionsApplied++;
        return;
      }
      mu = total;
      meet = f;
      meetParentState = pState;
      meetSuccState = succState;
    };

    /**
     * Every state the OTHER search can hold on edge `x`. One for an ordinary edge, a small block
     * for a via-way edge. Written as an explicit index pair rather than a callback so the hot loop
     * allocates no closure: the caller loops `lo` to `hi` inclusive.
     *
     * This is why the meeting is a block-against-block test rather than one index against the same
     * index. Once a via-way edge holds several forward states and several backward states, the
     * cheapest LEGAL join can be between a forward state that is not the cheapest and a backward
     * state that is not the cheapest, and only enumerating the small blocks finds it.
     */
    const backLo = (x: number): number => {
      const b = bwdBase[x] as number;
      return b < 0 ? x : b;
    };
    const backHi = (x: number): number => {
      const b = bwdBase[x] as number;
      if (b < 0) return x;
      const vo = edgeTo[x] as number;
      return b + ((csrOffset[vo + 1] as number) - (csrOffset[vo] as number));
    };
    const fwdLo = (x: number): number => {
      const b = fwdBase[x] as number;
      return b < 0 ? x : b;
    };
    const fwdHi = (x: number): number => {
      const b = fwdBase[x] as number;
      if (b < 0) return x;
      const ui = edgeFrom[x] as number;
      return b + ((rcsrOffset[ui + 1] as number) - (rcsrOffset[ui] as number));
    };

    for (;;) {
      const topF = this.heapSize > 0 ? (this.heapCost[1] as number) : Infinity;
      const topB = this.heapSizeB > 0 ? (this.heapCostB[1] as number) : Infinity;
      if (topF === Infinity && topB === Infinity) break;
      // Nothing still queued on either side can complete a route cheaper than this, because a
      // priority lower-bounds every route through that state and arc costs are non-negative.
      if (topF + topB >= mu) break;

      if (topF <= topB) {
        const sf = this.pop();
        if (settledStamp[sf] === gen) continue;
        settledStamp[sf] = gen;
        settled++;
        const e = stateEdge[sf] as number;
        const de = distV[sf * 2] as number;
        // Read from the STATE, not the parent array. Exact wherever a triple can consult it.
        const from = stateOther[sf] as number;
        for (let sb = backLo(e); sb <= backHi(e); sb++) {
          if (settledStampB[sb] === gen) {
            considerMeet(e, metaV[sf * 4 + 2] as number, metaB[sb * 4 + 2] as number, de + (distB[sb * 2] as number));
          }
        }
        const v = edgeTo[e] as number;
        const restricted = edgeRestricted[e] === 1;
        const start = csrOffset[v] as number;
        const end = csrOffset[v + 1] as number;
        const turnBase = turnOff === null ? 0 : (turnOff[e] as number);
        for (let i = start; i < end; i++) {
          const f = csrEdge[i] as number;
          if (avoidTolls && edgeToll[f] === 1) continue;
          if (restricted && this.forbidden(e, f, from)) {
            restrictionsApplied++;
            continue;
          }
          const nd =
            de + (secs[f] as number) + (turnSec === null ? 0 : (turnSec[turnBase + (i - start)] as number));
          relaxed++;
          const isVia = edgeViaWay[f] === 1;
          if (!isVia) {
            if (settledStampB[f] === gen) {
              considerMeet(f, sf, metaB[f * 4 + 2] as number, nd + (distB[f * 2] as number));
            }
          } else {
            for (let sb = backLo(f); sb <= backHi(f); sb++) {
              if (settledStampB[sb] === gen) {
                considerMeet(f, sf, metaB[sb * 4 + 2] as number, nd + (distB[sb * 2] as number));
              }
            }
          }
          const ns = !isVia ? f : (fwdBase[f] as number) + 1 + (predSlotOf[e] as number);
          const m = ns * 4;
          if (metaV[m + 3] !== gen) {
            metaV[m + 3] = gen;
            distV[ns * 2] = nd;
            metaV[m + 2] = sf;
            this.push(ns, nd);
          } else if (nd < (distV[ns * 2] as number)) {
            distV[ns * 2] = nd;
            metaV[m + 2] = sf;
            this.push(ns, nd);
          }
        }
      } else {
        const sb = this.popB();
        if (settledStampB[sb] === gen) continue;
        settledStampB[sb] = gen;
        settled++;
        const cur = stateEdge[sb] as number;
        const dc = distB[sb * 2] as number;
        // The committed successor of this state. -1 on every unexpanded state, which is correct:
        // only a via-way edge has sequences, and only a via-way edge is expanded.
        const succ = stateOther[sb] as number;
        for (let sfx = fwdLo(cur); sfx <= fwdHi(cur); sfx++) {
          if (settledStamp[sfx] === gen) {
            considerMeet(cur, metaV[sfx * 4 + 2] as number, metaB[sb * 4 + 2] as number, (distV[sfx * 2] as number) + dc);
          }
        }
        const restrictedCur = edgeRestricted[cur] === 1;
        // Predecessors of `cur` are the edges arriving at the vertex `cur` leaves from.
        const u = edgeFrom[cur] as number;
        const rs = rcsrOffset[u] as number;
        const re = rcsrOffset[u + 1] as number;
        // `cur`'s slot inside that vertex's outgoing block is the same for every predecessor, so
        // the turn cost of `pred -> cur` is one read at `turnOff[pred] + slot`.
        const slot = slotOf[cur] as number;
        const through = (secs[cur] as number) + dc;
        for (let i = rs; i < re; i++) {
          const pred = rcsrEdge[i] as number;
          if (avoidTolls && edgeToll[pred] === 1) continue;
          // May the driver make the manoeuvre pred -> cur at all. Decided by pred's own pair table.
          if (edgeRestricted[pred] === 1 && this.forbidden(pred, cur, -1)) {
            restrictionsApplied++;
            continue;
          }
          // And the deferred triple centred on `cur`: arrived from `pred`, continuing to `succ`.
          // Argument order is the trap named in this method's comment.
          if (restrictedCur && succ !== -1 && this.forbidden(cur, succ, pred)) {
            restrictionsApplied++;
            continue;
          }
          const nd =
            through +
            (turnSec === null || turnOff === null ? 0 : (turnSec[(turnOff[pred] as number) + slot] as number));
          relaxed++;
          const isVia = edgeViaWay[pred] === 1;
          if (!isVia) {
            if (settledStamp[pred] === gen) {
              considerMeet(pred, metaV[pred * 4 + 2] as number, sb, (distV[pred * 2] as number) + nd);
            }
          } else {
            for (let sfx = fwdLo(pred); sfx <= fwdHi(pred); sfx++) {
              if (settledStamp[sfx] === gen) {
                considerMeet(pred, metaV[sfx * 4 + 2] as number, sb, (distV[sfx * 2] as number) + nd);
              }
            }
          }
          const nsb = !isVia ? pred : (bwdBase[pred] as number) + 1 + (slotOf[cur] as number);
          const m = nsb * 4;
          if (metaB[m + 3] !== gen) {
            metaB[m + 3] = gen;
            distB[nsb * 2] = nd;
            metaB[m + 2] = sb;
            this.pushB(nsb, nd);
          } else if (nd < (distB[nsb * 2] as number)) {
            distB[nsb * 2] = nd;
            metaB[m + 2] = sb;
            this.pushB(nsb, nd);
          }
        }
      }
    }

    if (meet === -1) return null;

    const edges: number[] = [];
    for (let s = meetParentState; s !== -1; s = metaV[s * 4 + 2] as number) edges.push(stateEdge[s] as number);
    edges.reverse();
    edges.push(meet);
    for (let s = meetSuccState; s !== -1; s = metaB[s * 4 + 2] as number) {
      edges.push(stateEdge[s] as number);
    }

    // The forward chain always terminates at a state whose parent is -1, and only seeds have that,
    // so `edges[0]` is always a seeded start edge and always carries the seeded fraction. Stated
    // rather than re-derived per case: the forward rung reaches the same conclusion by a condition
    // that is likewise always true.
    const firstEdge = edges[0] as number;
    const firstFraction = firstEdge === startEdge ? startFraction : 1 - startFraction;
    const lastEdge = edges[edges.length - 1] as number;
    const endFrac = lastEdge === endA ? fracA : fracB;
    return this.finish(edges, firstFraction, endFrac, mu, settled, relaxed, restrictionsApplied);
  }

  /**
   * WHAT THE DRIVER PAYS, priced per road by that road's own mechanism, plus how much of that
   * figure we are willing to show.
   *
   * Runs once per query over the chosen path, never during the search. That is what lets it do the
   * two things a shortest-path cost cannot:
   *
   *   THE FLOOR. A closed system bills `max(floor, rate * km)` for a run, which is not additive
   *   over edges. Here the path is known, so each CONTINUOUS RUN on a road can be measured and the
   *   floor applied to it. A route that leaves a tolled road and rejoins it pays twice, which is
   *   what a closed system actually does, so runs are counted separately rather than summed.
   *
   *   THE CONFIDENCE. It is the WEAKEST LINK across every tolled road used, not an average and not
   *   the first one found. One `unpriced` road anywhere on the route means no rupee figure is
   *   defensible for the route as a whole.
   *
   * The trimming fractions matter: a route enters the first edge and leaves the last one part way,
   * and charging the untravelled remainder would bill for road the driver never covers.
   */
  private priceTolls(
    edges: readonly number[],
    firstFraction: number,
    endFrac: number,
  ): { tollCost: number; tollConfidence: TollConfidence } {
    const roads = this.obj.tollRoads;
    if (roads === undefined || edges.length === 0) return { tollCost: 0, tollConfidence: 'verified' };
    const byId = new Map(roads.map((r) => [r.id, r]));
    const g = this.g;

    let cost = 0;
    let worst: TollConfidence = 'verified';
    const seen = (c: TollConfidence): void => {
      if (c === 'unpriced' || worst === 'unpriced') worst = 'unpriced';
      else if (c === 'approximated') worst = 'approximated';
    };

    // One continuous run on one road. A route that leaves a tolled road and rejoins it pays twice,
    // which is what a closed system actually does, so runs are priced separately and never summed
    // into one journey.
    let runRoad = 0;
    let runMetres = 0;
    let runMainlineGates = 0;
    let runRampBooths = 0;
    let metresSinceLastMainline = 0;
    let runMinSegment = EPE_SEGMENT_NONE;
    let runMaxSegment = EPE_SEGMENT_NONE;

    const closeRun = (): void => {
      const r = byId.get(runRoad);
      runRoad = 0;
      if (r === undefined) return;
      const km = runMetres / 1000;

      // CONFIDENCE IS A PROPERTY OF THE RUN, NOT OF AN EDGE, so it is decided here and not during
      // the sweep. Whether a ramp was involved is not knowable until the run ends: a route that
      // crosses a barrier only on its last edge is a mainline crossing throughout, and judging each
      // edge as it passed would have marked the whole thing an estimate.
      //
      // CONFIDENCE TRACKS ROADS TRAVERSED, NOT ROADS CHARGED. A route can run 12 km on a
      // barrier-charged expressway and pay nothing because it exits first. Recording confidence
      // only where money changed hands would report that route as `verified` on the strength of
      // having charged nothing, when what the reader needs to know is that it used a road whose
      // tariff we do or do not stand behind.
      const rampInvolved = r.mechanism === 'gate-hybrid' && (runRampBooths > 0 || runMainlineGates === 0);
      seen(rampInvolved ? r.confidenceWithRamp : r.confidence);

      if (r.mechanism === 'matrix') {
        // ENTRY AND EXIT, NOT DISTANCE DRIVEN. Spans a..b mean the driver entered at plaza a and
        // left at plaza b+1, so the billed distance is the published cell for that pair however
        // far they actually drove. A run with no span at all is a ramp-only movement inside one
        // interchange, which is entry and exit at the same plaza and costs nothing.
        if (runMinSegment === EPE_SEGMENT_NONE) return;
        const entry = runMinSegment;
        const exit = runMaxSegment + 1;
        const km2 = r.matrixKm?.[entry]?.[exit];
        if (km2 === undefined) return;
        const step = r.fareRoundingRupees ?? 1;
        const charge = step * Math.round((r.ratePerKm * km2) / step);
        cost += charge;
        return;
      }

      if (r.mechanism === 'gate-hybrid') {
        if (runMainlineGates > 0) {
          // Each barrier crossed bills whole, plus the ramp rate on whatever was driven after the
          // last one, which is the stretch a mainline fee does not cover.
          const charge = runMainlineGates * r.feeRupees + (metresSinceLastMainline / 1000) * r.ratePerKm;
          cost += charge;
          return;
        }
        // No barrier crossed. Either the route used a ramp plaza, or it crossed no MAPPED booth at
        // all, which our data allows because OSM holds five booths where the operator runs at least
        // ten. Both bill by distance. Charging zero is the one error that actively steers a driver
        // onto an unpriced toll road, so a run on this road is never free.
        const charge = km * r.ratePerKm;
        cost += charge;
        return;
      }

      const charge = km * r.ratePerKm;
      cost += charge;
    };

    const resetRun = (road: number): void => {
      runRoad = road;
      runMetres = 0;
      runMainlineGates = 0;
      runRampBooths = 0;
      metresSinceLastMainline = 0;
      runMinSegment = EPE_SEGMENT_NONE;
      runMaxSegment = EPE_SEGMENT_NONE;
    };

    for (let i = 0; i < edges.length; i++) {
      const e = edges[i] as number;
      const road = g.edgeTollRoad[e] as number;
      let m = g.edgeLengthM[e] as number;
      if (i === 0) m -= firstFraction * m;
      if (i === edges.length - 1) m -= (1 - endFrac) * m;

      if (road !== runRoad) {
        closeRun();
        resetRun(road);
      }
      if (road === 0) continue;

      runMetres += m;
      const gate = g.edgeTollGate[e] as number;
      // Accumulate FIRST, then decide, then reset. Order matters and getting it wrong is not
      // visible in the result: resetting before accumulating made two consecutive barrier edges
      // always measure zero apart, so any number of barriers collapsed into one however far apart
      // they were. Caught by the multi-plaza control in `tests/engine/objective.test.ts`.
      metresSinceLastMainline += m;
      if (gate === TOLL_GATE_MAINLINE) {
        // BOOTH NODES ARE NOT PLAZAS, and a flat fee is charged per PLAZA. One plaza is several
        // booth nodes, one per lane and direction, and OSM places them along the carriageway rather
        // than at a point: the Chhajju Nagar plaza is two nodes 0.4 km apart, both on the through
        // carriageway, so a single crossing meets both. Counting nodes would bill that twice.
        // Barriers on this network are tens of kilometres apart, so anything within a couple of
        // kilometres of the last one is the same plaza.
        if (runMainlineGates === 0 || metresSinceLastMainline > SAME_PLAZA_M) runMainlineGates++;
        // Restart the measurement here. The part of this edge beyond the booth is not counted
        // toward the post-barrier ramp charge, which is below the resolution of a booth whose
        // position within its edge we do not know.
        metresSinceLastMainline = 0;
      } else if (gate === TOLL_GATE_RAMP) {
        runRampBooths++;
      }
      const seg = g.edgeTollSegment[e] as number;
      if (seg !== EPE_SEGMENT_NONE) {
        if (runMinSegment === EPE_SEGMENT_NONE || seg < runMinSegment) runMinSegment = seg;
        if (runMaxSegment === EPE_SEGMENT_NONE || seg > runMaxSegment) runMaxSegment = seg;
      }
    }
    closeRun();
    return { tollCost: cost, tollConfidence: worst };
  }

  /**
   * Every shape point of every edge, in travel order, trimmed at both ends.
   *
   * Charter item 1: the route line must lie exactly on the drawn road, so the geometry is the
   * road's own shape points, never the straight vertex-to-vertex chords. A reversed edge shares
   * the forward edge's shape and must be walked backwards.
   */
  private buildGeometry(
    edges: readonly number[],
    firstFraction: number,
    lastFraction: number,
  ): LngLat[] {
    const g = this.g;
    const out: LngLat[] = [];

    for (let idx = 0; idx < edges.length; idx++) {
      const e = edges[idx] as number;
      const pts = this.shapeInTravelOrder(e);
      const isFirst = idx === 0;
      const isLast = idx === edges.length - 1;

      // Trim to the snapped positions. Without this the line starts at the road's nearest
      // junction rather than beside the car, which is exactly the "route line does not match
      // where I am" defect charter item 1 forbids.
      const from = isFirst ? firstFraction : 0;
      const to = isLast ? lastFraction : 1;
      const clipped = clipPolyline(pts, from, to);

      for (const p of clipped) {
        // Consecutive edges share a vertex; emitting it twice leaves a zero-length segment,
        // which some renderers turn into a visible spike at every junction.
        const last = out[out.length - 1];
        if (last !== undefined && last[0] === p[0] && last[1] === p[1]) continue;
        out.push(p);
      }
    }
    return out;
  }

  /** An edge's shape points ordered along the direction of travel. */
  private shapeInTravelOrder(e: number): LngLat[] {
    const g = this.g;
    const s = g.edgeShape[e] as number;
    const from = g.shapeOffset[s] as number;
    const to = g.shapeOffset[s + 1] as number;
    const reversed = g.edgeReversed[e] === 1;
    const pts: LngLat[] = [];
    const count = to - from;
    for (let k = 0; k < count; k++) {
      const i = reversed ? to - 1 - k : from + k;
      pts.push([(g.shapeLon[i] as number) / COORD_SCALE, (g.shapeLat[i] as number) / COORD_SCALE]);
    }
    return pts;
  }
}
