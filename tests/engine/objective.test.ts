/**
 * The objective: the distance preference and the toll terms.
 *
 * These exist because minimising time alone has no tiebreaker. Two routes can be near-tied in time
 * while one is 37% longer, and the search will happily return the long one and call it optimal. The
 * measured case was `gautam-buddha-university to jewar`: 12 extra km, on a toll road, to save 2.7
 * minutes.
 *
 * THE DECISION BOUNDARY IS COMPUTED, NOT HARDCODED. Every test derives the exchange rate at which
 * the router should flip from the graph's own measured lengths and speeds, then asserts the flip
 * happens on the correct side of it. Hardcoding "route B wins at 24 s/km" would pass just as well
 * against a router that always returns B, and would have to be edited every time a coordinate
 * moves. Deriving the boundary tests the arithmetic instead of the answer.
 *
 * TURN COSTS ARE OFF THROUGHOUT. One variable at a time: with turn costs on, a class-drop penalty
 * would also separate these two routes and a failure would not say which model was wrong.
 */
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../packages/pipeline/graph/build.ts';
import { buildTurnTable } from '../../packages/pipeline/graph/restrictions.ts';
import { Router } from '../../packages/engine/dijkstra.ts';
import { IdMap } from '../../packages/pipeline/clip/idset.ts';
import {
  EPE_CARRIAGEWAY_KM,
  EPE_PLAZAS,
  EPE_TOLLABLE_KM,
  OBJECTIVE,
  TOLL_ROADS,
  TOLL_TAGGING_ERRORS,
} from '../../config/city.ts';
import { tollDisplayOf } from '../../packages/shared/toll.ts';
import { CLASS_RANK } from '../../packages/pipeline/graph/profile.ts';
import type { ObjectiveConfig, TollRoad } from '../../packages/shared/index.ts';
import type { Clipped, ClipStats, ClippedWay } from '../../packages/pipeline/clip/clip.ts';

const SCALE = 1e7;

const EMPTY_STATS: ClipStats = {
  perFile: [], nodesInAreaSummed: 0, nodesInAreaUnion: 0, seamOverlapNodes: 0,
  duplicates: { nodes: 0, ways: 0, relations: 0 },
  sampleDuplicateWayIds: [], sampleDuplicateNodeIds: [],
  keptNodes: 0, keptWays: 0, keptWaysWithHighway: 0, keptRelations: 0, keptRestrictions: 0,
  relationsOutsideArea: 0, nestedRelationMembers: 0, extraNodesForCompleteWays: 0,
  pass1Seconds: 0, pass2Seconds: 0, writeSeconds: 0, peakRssBytes: 0, cacheBytes: 0,
};

// `| undefined` explicitly, because `exactOptionalPropertyTypes` is on repo-wide: an optional
// property may be ABSENT but may not be set to undefined unless its type says so, and the toy
// builders below pass undefined to mean "no booth here".
interface N { id: number; lat: number; lon: number; tags?: Record<string, string> | undefined }
interface W { id: number; refs: number[]; tags: Record<string, string> }

function build(nodes: readonly N[], ways: readonly W[]) {
  const nodeIndex = new IdMap(1024);
  const nodeIds = new Float64Array(nodes.length);
  const nodeLat = new Int32Array(nodes.length);
  const nodeLon = new Int32Array(nodes.length);
  nodes.forEach((nd, i) => {
    nodeIndex.set(nd.id, i);
    nodeIds[i] = nd.id;
    nodeLat[i] = Math.round(nd.lat * SCALE);
    nodeLon[i] = Math.round(nd.lon * SCALE);
  });
  const built: ClippedWay[] = ways.map((w) => ({ id: w.id, refs: w.refs, tags: new Map(Object.entries(w.tags)) }));
  // Node tags carry `barrier=toll_booth`, which is the only way a toy graph can exercise a barrier
  // charge at all. Empty for every test that does not need one, which is how this read before.
  const nodeTags = new Map<number, Map<string, string>>();
  for (const nd of nodes) {
    if (nd.tags !== undefined) nodeTags.set(nd.id, new Map(Object.entries(nd.tags)));
  }
  const clipped: Clipped = {
    nodeIds, nodeLat, nodeLon, nodeTags, ways: built, relations: [], stats: EMPTY_STATS, nodeIndex,
  };
  const graph = buildGraph(clipped);
  const vertexOfNodeId = new Map<number, number>();
  for (let v = 0; v < graph.vertexNodeId.length; v++) vertexOfNodeId.set(graph.vertexNodeId[v] as number, v);
  const turns = buildTurnTable(graph, [], vertexOfNodeId, clipped);
  return { graph, turns, vertexOfNodeId };
}

function edgeOf(
  graph: ReturnType<typeof buildGraph>,
  vertexOfNodeId: Map<number, number>,
  wayId: number,
  fromNode: number,
  toNode: number,
): number {
  const a = vertexOfNodeId.get(fromNode);
  const b = vertexOfNodeId.get(toNode);
  for (let e = 0; e < graph.edgeWayId.length; e++) {
    if ((graph.edgeWayId[e] as number) !== wayId) continue;
    if ((graph.edgeFrom[e] as number) === a && (graph.edgeTo[e] as number) === b) return e;
  }
  throw new Error(`no edge on way ${wayId} from ${fromNode} to ${toNode}`);
}

const NO_PREF: ObjectiveConfig = { secondsPerKm: 0, secondsPerRupee: 0, avoidTollsByDefault: false };

/**
 * Two ways between the same pair of vertices, with an approach stub and an exit stub.
 *
 * The stubs are not decoration. Without them the start and the end sit on the same edge and there
 * is no choice for the router to make, so the test would pass against a router with no objective at
 * all. Routing from the approach to the exit forces a decision at vertex 1 about how to reach
 * vertex 2, which is the decision under test.
 *
 * `DIRECT` is short and slow, `DETOUR` is long and marginally faster: the near-tie shape that
 * produced the landmark divergence. `maxspeed` is tagged so the speeds are exact rather than
 * whatever the class table happens to say.
 */
const APPROACH = 10;
const EXIT = 20;
const DIRECT = 100;
const DETOUR = 200;

function nearTie(detourTolled: boolean) {
  return build(
    [
      // Node id 5, not 0: id 0 is IdMap's empty sentinel and storing it throws.
      { id: 5, lat: 28.495, lon: 77.500 },
      { id: 1, lat: 28.500, lon: 77.500 },
      { id: 2, lat: 28.550, lon: 77.500 },
      { id: 3, lat: 28.525, lon: 77.550 },
      { id: 4, lat: 28.555, lon: 77.500 },
    ],
    [
      { id: APPROACH, refs: [5, 1], tags: { highway: 'secondary', maxspeed: '40' } },
      { id: EXIT, refs: [2, 4], tags: { highway: 'secondary', maxspeed: '40' } },
      { id: DIRECT, refs: [1, 2], tags: { highway: 'secondary', maxspeed: '25' } },
      {
        id: DETOUR,
        refs: [1, 3, 2],
        tags: detourTolled
          ? { highway: 'secondary', maxspeed: '52', toll: 'yes' }
          : { highway: 'secondary', maxspeed: '52' },
      },
    ],
  );
}

/** The way ids a route travelled, in order. */
function waysOf(graph: ReturnType<typeof buildGraph>, edges: readonly number[]): number[] {
  return edges.map((e) => graph.edgeWayId[e] as number);
}

describe('the distance preference', () => {
  it('flips the chosen route at exactly the derived exchange rate, in BOTH directions', () => {
    const { graph, turns, vertexOfNodeId } = nearTie(false);
    const start = edgeOf(graph, vertexOfNodeId, APPROACH, 5, 1);
    const end = edgeOf(graph, vertexOfNodeId, EXIT, 2, 4);

    const direct = edgeOf(graph, vertexOfNodeId, DIRECT, 1, 2);
    const detour = edgeOf(graph, vertexOfNodeId, DETOUR, 1, 2);
    const lenDirect = graph.edgeLengthM[direct] as number;
    const lenDetour = graph.edgeLengthM[detour] as number;
    const tDirect = lenDirect / ((graph.edgeSpeedKmh[direct] as number) / 3.6);
    const tDetour = lenDetour / ((graph.edgeSpeedKmh[detour] as number) / 3.6);

    // The setup must actually be a near-tie, or the test proves nothing about tiebreaking.
    expect(lenDetour).toBeGreaterThan(lenDirect);
    expect(tDetour).toBeLessThan(tDirect);

    // Rate, in seconds per km, at which the two costs are equal.
    const flipSPerKm = ((tDirect - tDetour) / (lenDetour - lenDirect)) * 1000;
    expect(flipSPerKm).toBeGreaterThan(0);

    const pick = (secondsPerKm: number): number => {
      const r = new Router(graph, turns, undefined, { ...NO_PREF, secondsPerKm });
      const res = r.route(start, 0, end, 1);
      expect(res).not.toBeNull();
      // Which of the two middle ways did the winning route travel on?
      const ways = waysOf(graph, (res as NonNullable<typeof res>).edges);
      expect(ways).toContain(APPROACH);
      expect(ways).toContain(EXIT);
      return ways.includes(DETOUR) ? DETOUR : DIRECT;
    };

    // POSITIVE CONTROL: with no distance preference the faster, longer route wins. Without this,
    // "the short route won" would also pass against a router that could never find the long one.
    expect(pick(0)).toBe(DETOUR);
    expect(pick(flipSPerKm * 0.5)).toBe(DETOUR);
    // Past the boundary the shorter route wins.
    expect(pick(flipSPerKm * 2)).toBe(DIRECT);
    // The shipped preference sits on the short-route side of this near-tie, which is the point.
    expect(OBJECTIVE.secondsPerKm).toBeGreaterThan(flipSPerKm);
    expect(pick(OBJECTIVE.secondsPerKm)).toBe(DIRECT);
  });

  it('reports components that sum exactly to the total cost', () => {
    const { graph, turns, vertexOfNodeId } = nearTie(true);
    const start = edgeOf(graph, vertexOfNodeId, APPROACH, 5, 1);
    const end = edgeOf(graph, vertexOfNodeId, EXIT, 2, 4);
    const r = new Router(graph, turns, undefined, OBJECTIVE);
    const res = r.route(start, 0, end, 1);
    expect(res).not.toBeNull();
    const x = res as NonNullable<typeof res>;
    expect(x.driveSeconds + x.turnSeconds + x.distanceSeconds + x.tollSeconds).toBeCloseTo(x.seconds, 6);
  });

  it('charges the distance preference in proportion to the metres actually driven', () => {
    const { graph, turns, vertexOfNodeId } = nearTie(false);
    const start = edgeOf(graph, vertexOfNodeId, APPROACH, 5, 1);
    const end = edgeOf(graph, vertexOfNodeId, EXIT, 2, 4);
    const r = new Router(graph, turns, undefined, OBJECTIVE);
    const res = r.route(start, 0, end, 1);
    expect(res).not.toBeNull();
    const x = res as NonNullable<typeof res>;
    // Every way in this fixture is `secondary`, so the whole route carries ONE quality weight and
    // the charge is still a clean multiple of the metres. The weight has to appear explicitly:
    // asserting the unweighted rate would now pass only if the weights were being ignored.
    const q = OBJECTIVE.qualityByRank[CLASS_RANK['secondary'] as number] as number;
    expect(x.distanceSeconds).toBeCloseTo((x.metres / 1000) * OBJECTIVE.secondsPerKm * q, 6);
  });
});

describe('tolls', () => {
  it('prices a tolled road by default rather than banning it', () => {
    const { graph, turns, vertexOfNodeId } = nearTie(true);
    const start = edgeOf(graph, vertexOfNodeId, DETOUR, 1, 2);
    const r = new Router(graph, turns, undefined, { ...NO_PREF, secondsPerRupee: 16, tollRoads: TOLL_ROADS });
    const res = r.route(start, 0, start, 1);
    expect(res).not.toBeNull();
    const x = res as NonNullable<typeof res>;
    // The tolled road is still usable, and the reluctance is charged and reported.
    expect(x.tollMetres).toBeGreaterThan(0);
    // The toy way is tagged `toll=yes` with no name, so it falls to the `unpriced` entry, which is
    // the point: a road we cannot price is charged, never quietly freed.
    const unpriced = TOLL_ROADS.find((t) => t.key === 'unpriced') as (typeof TOLL_ROADS)[number];
    expect(x.tollSeconds).toBeCloseTo((x.tollMetres / 1000) * unpriced.ratePerKm * 16, 6);
    expect(x.tollConfidence).toBe('unpriced');
  });

  it('EXCLUDES tolled roads entirely under avoidTolls, and the control proves they were reachable', () => {
    const { graph, turns, vertexOfNodeId } = nearTie(true);
    const start = edgeOf(graph, vertexOfNodeId, APPROACH, 5, 1);
    const end = edgeOf(graph, vertexOfNodeId, EXIT, 2, 4);
    const r = new Router(graph, turns, undefined, NO_PREF);

    // CONTROL: with tolls allowed and no preferences at all, the tolled detour is the winner.
    const allowed = r.route(start, 0, end, 1);
    expect(allowed).not.toBeNull();
    expect(waysOf(graph, (allowed as NonNullable<typeof allowed>).edges)).toContain(DETOUR);

    // With tolls excluded, the route falls back to the slower free road and pays no toll at all.
    const avoided = r.route(start, 0, end, 1, { avoidTolls: true });
    expect(avoided).not.toBeNull();
    const x = avoided as NonNullable<typeof avoided>;
    expect(waysOf(graph, x.edges)).toContain(DIRECT);
    expect(waysOf(graph, x.edges)).not.toContain(DETOUR);
    expect(x.tollMetres).toBe(0);
    expect(x.tollSeconds).toBe(0);
  });

  it('returns no route rather than a tolled one when every path is tolled', () => {
    const { graph, turns, vertexOfNodeId } = build(
      [
        { id: 1, lat: 28.500, lon: 77.500 },
        { id: 2, lat: 28.510, lon: 77.500 },
        { id: 3, lat: 28.520, lon: 77.500 },
      ],
      [
        { id: 100, refs: [1, 2], tags: { highway: 'secondary' } },
        { id: 300, refs: [2, 3], tags: { highway: 'secondary', toll: 'yes' } },
      ],
    );
    const start = edgeOf(graph, vertexOfNodeId, 100, 1, 2);
    const end = edgeOf(graph, vertexOfNodeId, 300, 2, 3);
    const r = new Router(graph, turns, undefined, NO_PREF);

    // CONTROL: the destination is reachable when tolls are allowed.
    expect(r.route(start, 0, end, 1)).not.toBeNull();
    // Excluding tolls is a HARD filter: no route, rather than a tolled route at a high price.
    expect(r.route(start, 0, end, 1, { avoidTolls: true })).toBeNull();
  });
});

describe('the shipped objective', () => {
  it('is non-negative, which the A* admissibility proof depends on', () => {
    expect(OBJECTIVE.secondsPerKm).toBeGreaterThanOrEqual(0);
    expect(OBJECTIVE.secondsPerRupee).toBeGreaterThanOrEqual(0);
    for (const t of TOLL_ROADS) {
      expect(t.ratePerKm).toBeGreaterThanOrEqual(0);
      expect(t.feeRupees).toBeGreaterThanOrEqual(0);
      expect(t.searchRatePerKm).toBeGreaterThanOrEqual(0);
    }
  });

  it('REFUSES a negative preference rather than silently returning wrong routes', () => {
    const { graph, turns } = nearTie(false);
    expect(() => new Router(graph, turns, undefined, { ...NO_PREF, secondsPerKm: -1 })).toThrow(/admissible/);
    expect(() => new Router(graph, turns, undefined, { ...NO_PREF, secondsPerRupee: -1 })).toThrow(/admissible/);
    // And a negative AMOUNT in the table, which is the same defect one level down.
    const bad = TOLL_ROADS.map((t) => (t.key === 'unpriced' ? { ...t, ratePerKm: -1 } : t));
    expect(() => new Router(graph, turns, undefined, { ...NO_PREF, tollRoads: bad })).toThrow(/admissible/);
  });

  it('allows tolls by default, since the fastest road in this city is tolled', () => {
    expect(OBJECTIVE.avoidTollsByDefault).toBe(false);
  });

  it('bounds every toll amount to what a source can support, so a fitted number fails here', () => {
    // The guard against the failure mode these constants are most exposed to: being quietly nudged
    // toward whatever makes the OSRM divergence smaller. Each can only sit where a real board or a
    // defensible judgement puts it, so a fitted number fails in tests rather than in review. This
    // is the pattern that was applied to the old single tariff, kept as the table replaced it.
    // Read through the CONTRACT type, not the const literal. `matrixKm` is optional and only the
    // matrix road carries it, so the narrowed literal union would hide it behind a mechanism check
    // and the assertion would silently test nothing.
    const yamuna = TOLL_ROADS.find((t) => t.key === 'yamuna-expressway') as TollRoad;
    const epe = TOLL_ROADS.find((t) => t.key === 'eastern-peripheral') as TollRoad;

    // Yamuna bills at BARRIERS, verified from a plaza rate board and corroborated to the rupee by
    // three cumulative Google Maps probes. A pure per-km model here would mean the mechanism was
    // lost, and a zero ramp rate would restore the barrier dodge the hybrid exists to close.
    expect(yamuna.mechanism).toBe('gate-hybrid');
    expect(yamuna.feeRupees).toBe(140);
    expect(yamuna.ratePerKm).toBeGreaterThan(0);
    expect(yamuna.confidence).toBe('verified');
    // A ramp charge rests on a reported basis, not a published one, so it can never be `verified`.
    expect(yamuna.confidenceWithRamp).not.toBe('verified');

    // EPE bills a published entry-exit matrix. Its DISTANCES are statutory, so the mechanism must
    // carry the matrix itself: a per-km fallback would silently discard the notification.
    expect(epe.mechanism).toBe('matrix');
    expect(epe.matrixKm?.length).toBe(EPE_PLAZAS.length);
    expect(epe.fareRoundingRupees).toBe(5);

    // THE RATE IS THE FITTED ONE, AND THE FIT IS THE TEST. A rate is admissible only if EVERY cell
    // of the current rate board reproduces at it, under the published rounding. This is what stops
    // the rate being nudged toward whatever makes the OSRM divergence smaller: a fitted number
    // fails here rather than in review.
    const SIHOL = EPE_PLAZAS.findIndex((p) => p.label === 'Pelak/Sihol');
    const SIHOL_BOARD: readonly (readonly [string, number])[] = [
      ['Main Plaza Jakhauli', 280], ['Mawikalan', 245], ['Badagaon', 225], ['Duhai', 180],
      ['NE3 Interchange', 165], ['Dasna', 160], ['Bilakbarpur', 120], ['Fatehpur Rampur', 95],
      ['Maujpur', 35], ['Main Plaza Chhajju Nagar', 25],
    ];
    const fare = (rate: number, km: number): number => 5 * Math.round((rate * km) / 5);
    const fits = (rate: number): number => {
      let ok = 0;
      for (const [label, posted] of SIHOL_BOARD) {
        const j = EPE_PLAZAS.findIndex((p) => p.label === label);
        const km = epe.matrixKm?.[SIHOL]?.[j];
        if (km !== undefined && fare(rate, km) === posted) ok++;
      }
      return ok;
    };
    expect(fits(epe.ratePerKm)).toBe(SIHOL_BOARD.length);

    // CONTROL on that assertion: the fit is TIGHT, so it can actually reject. The admissible band
    // is [1.9457, 1.9526), narrower than a paisa either way, and both the superseded 1.71 estimate
    // and the older board's own rate fail it. Without this, a check that passes at any rate would
    // prove nothing.
    expect(fits(1.71)).toBeLessThan(SIHOL_BOARD.length);
    expect(fits(1.89)).toBeLessThan(SIHOL_BOARD.length);
    expect(fits(1.99)).toBeLessThan(SIHOL_BOARD.length);

    // Seconds per rupee is the cost of an hour of driving inverted. Note the inversion: a LOWER
    // cost per hour makes a rupee of toll worth MORE seconds of detour.
    expect(OBJECTIVE.secondsPerRupee).toBeCloseTo(3600 / 550, 9);

    // CONTROL on the objective itself: the superseded 225 rupees/hour really is outside this, so a
    // silent revert would be caught. At 16 s per rupee a 140 rupee barrier bought 37 minutes of
    // detour, which is the defect the move was made to fix.
    expect(3600 / 225).toBeGreaterThan(OBJECTIVE.secondsPerRupee * 2);
  });

  it('bills a barrier once per PLAZA, not once per booth node', () => {
    // A plaza is several booth nodes, one per lane and direction, and OSM strings them along the
    // carriageway rather than placing them at a point: the Chhajju Nagar plaza is two nodes 0.4 km
    // apart, both on the through carriageway, so ONE crossing meets both. Counting nodes bills that
    // crossing twice. Measured on the real graph, which is where this shape came from.
    const YAMUNA = TOLL_ROADS.find((t) => t.key === 'yamuna-expressway') as TollRoad;
    const tags = { highway: 'motorway', name: 'Yamuna Expressway', toll: 'yes', oneway: 'no', maxspeed: '100' };
    const booth = { barrier: 'toll_booth' };
    const obj: ObjectiveConfig = { ...NO_PREF, secondsPerRupee: 1, tollRoads: TOLL_ROADS };

    /**
     * Booths on SEPARATE edges, which is the only arrangement that can double-bill. A vertex exists
     * only where ways meet, so two booths on one edge already collapse by construction; the stub at
     * node 7 forces the carriageway to split. `spanDeg` sets how far apart the two booths sit.
     */
    function crossing(spanDeg: number, withBooths: boolean): number {
      const b = withBooths ? booth : undefined;
      const g = build(
        [
          { id: 5, lat: 28.5, lon: 77.5 },
          { id: 6, lat: 28.5 + spanDeg * 0.25, lon: 77.5, tags: b },
          { id: 7, lat: 28.5 + spanDeg * 0.5, lon: 77.5 },
          { id: 8, lat: 28.5 + spanDeg * 0.75, lon: 77.5, tags: b },
          { id: 9, lat: 28.5 + spanDeg, lon: 77.5 },
          { id: 11, lat: 28.5 + spanDeg * 0.5, lon: 77.51 },
        ],
        [
          { id: 100, refs: [5, 6, 7, 8, 9], tags },
          // A side road, solely so node 7 becomes a vertex and splits the carriageway in two.
          { id: 101, refs: [7, 11], tags: { highway: 'secondary' } },
        ],
      );
      const r = new Router(g.graph, g.turns, undefined, obj);
      const start = edgeOf(g.graph, g.vertexOfNodeId, 100, 5, 7);
      const end = edgeOf(g.graph, g.vertexOfNodeId, 100, 7, 9);
      const route = r.route(start, 0, end, 1);
      expect(route).not.toBeNull();
      return (route as NonNullable<typeof route>).tollCost;
    }

    // 0.012 degrees of latitude is about 1.33 km, so the two booths sit ~670 m apart: ONE plaza.
    const onePlaza = crossing(0.012, true);
    expect(onePlaza).toBeGreaterThanOrEqual(YAMUNA.feeRupees);
    expect(onePlaza).toBeLessThan(2 * YAMUNA.feeRupees);

    // CONTROL 1, so this cannot pass by charging nothing or by never seeing a booth: the SAME
    // geometry without booth tags charges only the per-km rate, far below a single fee. It is also
    // not FREE, because an unbilled run on a toll road is the error that steers drivers onto it.
    const noBooth = crossing(0.012, false);
    expect(noBooth).toBeGreaterThan(0);
    expect(noBooth).toBeLessThan(YAMUNA.feeRupees);

    // CONTROL 2, so the collapse cannot pass by merging everything: booths ~7.8 km apart are two
    // separate plazas and must bill twice. Without this, a rule that always returned a single fee
    // would satisfy the assertion above and be wrong on every real multi-plaza trip.
    const twoPlazas = crossing(0.14, true);
    expect(twoPlazas).toBeGreaterThanOrEqual(2 * YAMUNA.feeRupees);
  });

  it('shows a bare figure only where a primary source supports it', () => {
    // The display rule is enforcement, not a comment on a type: one function, both sides. A route
    // that touched no toll road shows nothing at all, whatever confidence it reports.
    expect(tollDisplayOf('verified', 0)).toBe('none');
    expect(tollDisplayOf('unpriced', 0)).toBe('none');
    expect(tollDisplayOf('verified', 1200)).toBe('exact');
    expect(tollDisplayOf('approximated', 1200)).toBe('estimated');
    expect(tollDisplayOf('unpriced', 1200)).toBe('estimated');
  });

  it('transcribed Table 5 correctly, checked by an identity rather than by re-reading it', () => {
    const n = EPE_PLAZAS.length;
    expect(EPE_TOLLABLE_KM.length).toBe(n);
    expect(EPE_CARRIAGEWAY_KM.length).toBe(n);
    for (let i = 0; i < n; i++) {
      expect(EPE_TOLLABLE_KM[i]?.[i]).toBe(0);
      for (let j = 0; j < n; j++) {
        expect(EPE_TOLLABLE_KM[i]?.[j]).toBe(EPE_TOLLABLE_KM[j]?.[i]);
        expect(EPE_CARRIAGEWAY_KM[i]?.[j]).toBe(EPE_CARRIAGEWAY_KM[j]?.[i]);
        // Table 5 adds the equivalent length of structures over 60 m, so it can only ever exceed
        // Table 2. A cell below it would be a transposed digit.
        expect(EPE_TOLLABLE_KM[i]?.[j] ?? 0).toBeGreaterThanOrEqual(EPE_CARRIAGEWAY_KM[i]?.[j] ?? 0);
      }
    }
    // THE IDENTITY THAT CATCHES A MISTYPED DIGIT. Structures sit on fixed spans of road, so the ten
    // adjacent-plaza allowances must sum to the end-to-end allowance. Those are 21 separately
    // transcribed cells across two tables, and a single wrong digit in any of them breaks this.
    let adjacent = 0;
    for (let i = 0; i + 1 < n; i++) {
      adjacent += (EPE_TOLLABLE_KM[i]?.[i + 1] ?? 0) - (EPE_CARRIAGEWAY_KM[i]?.[i + 1] ?? 0);
    }
    const endToEnd = (EPE_TOLLABLE_KM[0]?.[n - 1] ?? 0) - (EPE_CARRIAGEWAY_KM[0]?.[n - 1] ?? 0);
    expect(adjacent).toBeCloseTo(endToEnd, 2);

    // Chainages are ascending, which is what makes "spans a..b entered at a and left at b+1" true.
    for (let i = 0; i + 1 < n; i++) {
      expect(EPE_PLAZAS[i + 1]?.chainageKm ?? 0).toBeGreaterThan(EPE_PLAZAS[i]?.chainageKm ?? 0);
    }
  });

  it('never leaves a tolled road silently free, and never tolls a tagging error', () => {
    // Every entry must charge something by one mechanism or the other. An entry with no fee and no
    // rate would be a toll road the router treats as free, which is the one error that actively
    // steers drivers onto it.
    for (const t of TOLL_ROADS) {
      const charges = t.mechanism === 'gate-hybrid' ? t.feeRupees > 0 && t.ratePerKm > 0 : t.ratePerKm > 0;
      expect(charges).toBe(true);
      // And the SEARCH must feel it too. A road priced only at billing time steers nothing, so a
      // zero search rate would leave the router indifferent to a toll it later charges for.
      expect(t.searchRatePerKm).toBeGreaterThan(0);
    }
    // And the three ways excluded as tagging errors are excluded by ID, not by class, so a future
    // extract that renames one of them does not silently re-toll a residential street.
    expect(TOLL_TAGGING_ERRORS.length).toBe(3);
    expect(new Set(TOLL_TAGGING_ERRORS).size).toBe(3);
  });

  it('states an exchange rate inside the driver-plausible band of 1 minute per 2 to 3 km', () => {
    // The band is the claim; the midpoint is just where it landed. Both ends must agree, or the
    // constant is a fit dressed as a preference.
    const kmPerMinute = 60 / OBJECTIVE.secondsPerKm;
    expect(kmPerMinute).toBeGreaterThanOrEqual(2);
    expect(kmPerMinute).toBeLessThanOrEqual(3);
  });
});
