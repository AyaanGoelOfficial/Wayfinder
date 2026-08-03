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
import { OBJECTIVE } from '../../config/city.ts';
import type { ObjectiveConfig } from '../../packages/shared/index.ts';
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

interface N { id: number; lat: number; lon: number }
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
  const clipped: Clipped = {
    nodeIds, nodeLat, nodeLon, nodeTags: new Map(), ways: built, relations: [], stats: EMPTY_STATS, nodeIndex,
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

const NO_PREF: ObjectiveConfig = { secondsPerKm: 0, tollReluctanceSecondsPerKm: 0, avoidTollsByDefault: false };

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
    expect(x.distanceSeconds).toBeCloseTo((x.metres / 1000) * OBJECTIVE.secondsPerKm, 6);
  });
});

describe('tolls', () => {
  it('prices a tolled road by default rather than banning it', () => {
    const { graph, turns, vertexOfNodeId } = nearTie(true);
    const start = edgeOf(graph, vertexOfNodeId, DETOUR, 1, 2);
    const r = new Router(graph, turns, undefined, { ...NO_PREF, tollReluctanceSecondsPerKm: 12 });
    const res = r.route(start, 0, start, 1);
    expect(res).not.toBeNull();
    const x = res as NonNullable<typeof res>;
    // The tolled road is still usable, and the reluctance is charged and reported.
    expect(x.tollMetres).toBeGreaterThan(0);
    expect(x.tollSeconds).toBeCloseTo((x.tollMetres / 1000) * 12, 6);
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
    expect(OBJECTIVE.tollReluctanceSecondsPerKm).toBeGreaterThanOrEqual(0);
  });

  it('REFUSES a negative preference rather than silently returning wrong routes', () => {
    const { graph, turns } = nearTie(false);
    expect(() => new Router(graph, turns, undefined, { ...NO_PREF, secondsPerKm: -1 })).toThrow(/admissible/);
    expect(() => new Router(graph, turns, undefined, { ...NO_PREF, tollReluctanceSecondsPerKm: -1 })).toThrow(/admissible/);
  });

  it('allows tolls by default, since the fastest road in this city is tolled', () => {
    expect(OBJECTIVE.avoidTollsByDefault).toBe(false);
  });

  it('states an exchange rate inside the driver-plausible band of 1 minute per 2 to 3 km', () => {
    // The band is the claim; the midpoint is just where it landed. Both ends must agree, or the
    // constant is a fit dressed as a preference.
    const kmPerMinute = 60 / OBJECTIVE.secondsPerKm;
    expect(kmPerMinute).toBeGreaterThanOrEqual(2);
    expect(kmPerMinute).toBeLessThanOrEqual(3);
  });
});
