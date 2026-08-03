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
import type { LngLat, ObjectiveConfig, RouteOptions, TurnCostConfig } from '../shared/index.ts';
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

  /** The objective in force. Held so per-request options can be resolved against it. */
  private readonly obj: ObjectiveConfig;

  /** Priority of the state most recently returned by `pop`. See there for why it is needed. */
  private poppedCost = 0;

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
    this.obj = objective ?? { secondsPerKm: 0, tollReluctanceSecondsPerKm: 0, avoidTollsByDefault: false };
    if (this.obj.qualityByRank !== undefined && this.obj.qualityByRank.some((q) => !(q >= 0))) {
      throw new Error('OBJECTIVE quality weights must be non-negative or A* is no longer admissible.');
    }
    if (this.obj.secondsPerKm < 0 || this.obj.tollReluctanceSecondsPerKm < 0) {
      // Same reason the turn costs check: a negative preference does not fail, it silently breaks
      // A* admissibility and returns routes that are wrong rather than routes that are missing.
      throw new Error('OBJECTIVE costs must be non-negative or A* is no longer admissible.');
    }
    this.stateBuf = new ArrayBuffer(n * 16);
    this.distV = new Float64Array(this.stateBuf);
    this.metaV = new Int32Array(this.stateBuf);
    this.settledStamp = new Int32Array(n);
    this.heapEdge = new Int32Array(n + 1);
    this.heapCost = new Float64Array(n + 1);
    this.secs = new Float64Array(n);
    this.driveSecs = new Float64Array(n);
    // Per-metre so the hot loop never divides by 1000. The toll term is folded in here rather than
    // branched on during relaxation: an edge's toll status cannot change between queries, only
    // whether the query TOLERATES it, and that is a separate check.
    const perM = this.obj.secondsPerKm / 1000;
    const tollPerM = this.obj.tollReluctanceSecondsPerKm / 1000;
    // The quality weight is resolved to a per-metre rate PER CLASS RANK once, here, so the hot
    // loop never indexes a second table. An absent weights array means a flat rate on every class,
    // which is the pre-quality objective and what the toy graphs want.
    const quality = this.obj.qualityByRank;
    const perMByRank = new Float64Array(256);
    for (let r = 0; r < 256; r++) perMByRank[r] = perM * (quality === undefined ? 1 : (quality[r] ?? 1));
    this.distSecs = new Float64Array(n);
    this.edgesOfShape = new Map();
    for (let e = 0; e < n; e++) {
      const lenM = g.edgeLengthM[e] as number;
      const drive = lenM / ((g.edgeSpeedKmh[e] as number) * KMH_TO_MS);
      this.driveSecs[e] = drive;
      const dist = lenM * (perMByRank[g.edgeClassRank[e] as number] as number);
      this.distSecs[e] = dist;
      this.secs[e] = drive + dist + (g.edgeToll[e] === 1 ? lenM * tollPerM : 0);
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
    const useAStar = (opts?.algorithm ?? 'dijkstra') === 'astar';
    let targetLat = 0;
    let targetLon = 0;
    if (useAStar) {
      const pts = clipPolyline(this.shapeInTravelOrder(endEdge), 0, endFraction);
      const t = pts[pts.length - 1] as LngLat;
      targetLon = t[0];
      targetLat = t[1];
    }
    const hRate = this.hSecondsPerM;
    const vertexLat = g.vertexLat;
    const vertexLon = g.vertexLon;
    /**
     * Zero on the two end edges, deliberately. The goal lies partway ALONG them, so the remaining
     * cost from their far vertex is a refund rather than a payment and no positive bound is valid
     * there. Zero always is. It costs nothing: those two states are the ones the search is trying
     * to reach, so relaxing their priority can only make them pop sooner.
     */
    const hCache = this.hCache;
    const hStamp = this.hStamp;
    const h = (e: number): number => {
      if (!useAStar) return 0;
      // The end-edge test stays OUTSIDE the cache deliberately. It is a property of the edge, not
      // of its head vertex, and other edges can share that vertex; caching a zero against the
      // vertex would hand it to them and quietly make the heuristic useless near the goal.
      if (e === endA || e === endB) return 0;
      const v = g.edgeTo[e] as number;
      if (hStamp[v] !== gen) {
        hStamp[v] = gen;
        hCache[v] = haversineM(vertexLat[v] as number, vertexLon[v] as number, targetLat, targetLon) * hRate;
      }
      return hCache[v] as number;
    };

    const startShape = g.edgeShape[startEdge] as number;
    for (const se of this.edgesOfShape.get(startShape) ?? [startEdge]) {
      const frac = se === startEdge ? startFraction : 1 - startFraction;
      const remaining = (1 - frac) * (this.secs[se] as number);
      this.distV[se * 2] = remaining;
      this.metaV[se * 4 + 2] = -1;
      this.metaV[se * 4 + 3] = gen;
      this.push(se, remaining + h(se));
    }

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

    while (this.heapSize > 0) {
      const e = this.pop();
      const poppedCost = this.poppedCost;
      if (settledStamp[e] === gen) continue;
      settledStamp[e] = gen;
      settled++;
      const de = distV[e * 2] as number;

      // Reaching the end segment: stop partway along it rather than at its far vertex.
      if (e === endA || e === endB) {
        const endFrac = e === endA ? fracA : fracB;
        // If this is the seeded start edge, the destination is only reachable without leaving it
        // when it lies FURTHER along the direction of travel. Otherwise the driver must go round,
        // and the search finds that path by arriving on this edge again from elsewhere.
        const seededFrac =
          e === startEdge ? startFraction : g.edgeShape[e] === startShape ? 1 - startFraction : -1;
        if (!(seededFrac >= 0 && (metaV[e * 4 + 2] as number) === -1 && endFrac < seededFrac)) {
          const total = de - (1 - endFrac) * (secs[e] as number);
          if (total < bestTotal) {
            bestTotal = total;
            bestEnd = e;
          }
        }
      }
      // Everything still queued has priority at least `poppedCost`, and priority lower-bounds the
      // total cost of any route completed through that state, so once the best completion is
      // cheaper than the frontier there is nothing left that can improve it. Under Dijkstra
      // `poppedCost` IS `de`, so this is the identical test the plain rung has always run.
      if (bestEnd !== -1 && poppedCost >= bestTotal) break;

      const v = edgeTo[e] as number;
      const from = metaV[e * 4 + 2] as number;
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
        const m = f * 4;
        if (metaV[m + 3] !== gen) {
          metaV[m + 3] = gen;
          distV[f * 2] = nd;
          metaV[m + 2] = e;
          this.push(f, nd + h(f));
        } else if (nd < (distV[f * 2] as number)) {
          distV[f * 2] = nd;
          metaV[m + 2] = e;
          this.push(f, nd + h(f));
        }
      }
    }

    if (bestEnd === -1) return null;

    const edges: number[] = [];
    for (let e = bestEnd; e !== -1; e = this.metaV[e * 4 + 2] as number) edges.push(e);
    edges.reverse();

    const firstEdge = edges[0] as number;
    const firstFraction =
      (this.metaV[firstEdge * 4 + 2] as number) === -1
        ? (firstEdge === startEdge ? startFraction : 1 - startFraction)
        : 0;
    // Same mirroring as inside the loop: the fraction is measured along whichever of the two
    // directed edges of the end shape the search actually arrived on.
    const endFrac = bestEnd === endA ? fracA : fracB;
    const geometry = this.buildGeometry(edges, firstFraction, endFrac);
    // Components are trimmed with the SAME fractions as `metres`, because the route enters the
    // first edge partway and leaves the last partway. Summing untrimmed would charge distance and
    // toll for road the driver never covers, and the components would stop adding up to `seconds`.
    const sumTrimmed = (per: (e: number) => number): number => {
      let t = 0;
      for (const e of edges) t += per(e);
      t -= firstFraction * per(firstEdge);
      t -= (1 - endFrac) * per(bestEnd);
      return t;
    };
    const metres = sumTrimmed((e) => g.edgeLengthM[e] as number);
    const driveSeconds = sumTrimmed((e) => this.driveSecs[e] as number);
    const tollMetres = sumTrimmed((e) => (g.edgeToll[e] === 1 ? (g.edgeLengthM[e] as number) : 0));
    const distanceSeconds = sumTrimmed((e) => this.distSecs[e] as number);
    const tollSeconds = (tollMetres / 1000) * this.obj.tollReluctanceSecondsPerKm;

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
      seconds: bestTotal,
      driveSeconds,
      distanceSeconds,
      tollSeconds,
      tollMetres,
      turnSeconds,
      metres,
      geometry,
      settled,
      relaxed,
      restrictionsApplied,
    };
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
