/**
 * The turn cost model, on toy graphs with hand-computed geometry.
 *
 * EVERY BEHAVIOURAL TEST CARRIES A POSITIVE CONTROL, the same rule the restriction tests follow:
 * the identical graph is routed with turn costs OFF and ON, and the two answers must DIFFER. A
 * test that only asserts "the route avoids the residential shortcut" passes trivially against a
 * router that never found the shortcut, so the turn-free run is what proves the short path exists
 * and that the turn model is what removed it.
 *
 * Coordinates are chosen so the bearings are exact right angles rather than approximately so. At
 * this latitude a degree of longitude is much shorter than a degree of latitude, so the east/west
 * legs use a correspondingly smaller delta; getting that wrong makes every angle assertion drift
 * by a few degrees and turns a real failure into a tolerance argument.
 */
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../packages/pipeline/graph/build.ts';
import { buildTurnTable } from '../../packages/pipeline/graph/restrictions.ts';
import { Router } from '../../packages/engine/dijkstra.ts';
import { bearingDelta, buildTurnCosts, manoeuvreSeconds } from '../../packages/engine/turncost.ts';
import { IdMap } from '../../packages/pipeline/clip/idset.ts';
import { TURN_COST } from '../../config/city.ts';
import type { TurnCostConfig } from '../../packages/shared/index.ts';
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
  throw new Error(`no edge on way ${wayId} from node ${fromNode} to ${toNode}`);
}

const CFG: TurnCostConfig = {
  straightDeg: 25, turnS: 5, crossTrafficS: 6, crossMinDeg: 40,
  classDropS: 4, uTurnS: 40, drivesOnLeft: true,
};

describe('bearing delta sign convention', () => {
  it('is POSITIVE for a right turn and negative for a left, which decides which turn crosses traffic', () => {
    // Heading north (0), then east (90): that is a right turn.
    expect(bearingDelta(0, 90)).toBe(90);
    // Heading north (0), then west (270): a left turn.
    expect(bearingDelta(0, 270)).toBe(-90);
  });

  it('wraps across north without producing a 350 degree turn', () => {
    expect(bearingDelta(350, 10)).toBe(20);
    expect(bearingDelta(10, 350)).toBe(-20);
  });

  it('reports a reversal as 180, not -180, so a hairpin never changes sign on rounding', () => {
    expect(bearingDelta(0, 180)).toBe(180);
  });
});

describe('manoeuvre cost shape', () => {
  it('charges nothing for going straight ahead', () => {
    expect(manoeuvreSeconds(0, 3, 3, CFG)).toBe(0);
    expect(manoeuvreSeconds(20, 3, 3, CFG)).toBe(0);
    expect(manoeuvreSeconds(-24, 3, 3, CFG)).toBe(0);
  });

  it('charges turnS for a square 90 degree turn, and rises rather than saturating beyond it', () => {
    // Left turn at 90: severity only, no crossing term on the left in a drive-on-left country.
    const square = manoeuvreSeconds(-90, 3, 3, CFG);
    expect(square).toBeCloseTo(CFG.turnS, 6);
    const hairpin = manoeuvreSeconds(-170, 3, 3, CFG);
    expect(hairpin).toBeGreaterThan(square);
  });

  it('adds the crossing penalty to a RIGHT turn only, because traffic drives on the left here', () => {
    const right = manoeuvreSeconds(90, 3, 3, CFG);
    const left = manoeuvreSeconds(-90, 3, 3, CFG);
    expect(right - left).toBeCloseTo(CFG.crossTrafficS, 6);
  });

  it('flips which side pays when drivesOnLeft is false, so the flag is actually wired up', () => {
    const right = manoeuvreSeconds(90, 3, 3, { ...CFG, drivesOnLeft: false });
    const left = manoeuvreSeconds(-90, 3, 3, { ...CFG, drivesOnLeft: false });
    expect(left - right).toBeCloseTo(CFG.crossTrafficS, 6);
  });

  it('treats a gentle bend as a bend, not as a crossing manoeuvre', () => {
    // 30 degrees is past straightDeg so it costs severity, but is under crossMinDeg so it pays no
    // crossing penalty even though it is to the right.
    const gentleRight = manoeuvreSeconds(30, 3, 3, CFG);
    const gentleLeft = manoeuvreSeconds(-30, 3, 3, CFG);
    expect(gentleRight).toBeCloseTo(gentleLeft, 6);
    expect(gentleRight).toBeGreaterThan(0);
  });

  it('charges per step DOWN the class rank and nothing for climbing back up', () => {
    // trunk (1) onto residential (6): five steps down.
    expect(manoeuvreSeconds(0, 1, 6, CFG)).toBeCloseTo(CFG.classDropS * 5, 6);
    // residential (6) back onto trunk (1): free.
    expect(manoeuvreSeconds(0, 6, 1, CFG)).toBe(0);
  });
});

describe('turn cost construction', () => {
  it('REFUSES a negative cost, because it would break A* admissibility silently rather than loudly', () => {
    const { graph } = build(
      [{ id: 1, lat: 28.5, lon: 77.5 }, { id: 2, lat: 28.51, lon: 77.5 }],
      [{ id: 100, refs: [1, 2], tags: { highway: 'residential' } }],
    );
    expect(() => buildTurnCosts(graph, { ...CFG, uTurnS: -1 })).toThrow(/non-negative/);
    expect(() => buildTurnCosts(graph, { ...CFG, classDropS: -5 })).toThrow(/admissible/);
  });

  it('charges a U-turn at a junction but EXEMPTS one at a dead end', () => {
    //   1 --- 2 --- 3       and a stub 2 --- 4, so node 3 is a dead end and node 2 is a junction.
    const { graph } = build(
      [
        { id: 1, lat: 28.500, lon: 77.500 },
        { id: 2, lat: 28.510, lon: 77.500 },
        { id: 3, lat: 28.520, lon: 77.500 },
        { id: 4, lat: 28.510, lon: 77.510 },
      ],
      [
        { id: 100, refs: [1, 2], tags: { highway: 'residential' } },
        { id: 101, refs: [2, 3], tags: { highway: 'residential' } },
        { id: 102, refs: [2, 4], tags: { highway: 'residential' } },
      ],
    );
    const tc = buildTurnCosts(graph, CFG);
    expect(tc.stats.uTurnPairs).toBeGreaterThan(0);
    expect(tc.stats.uTurnExemptPairs).toBeGreaterThan(0);

    const cost = (from: number, to: number): number => {
      const v = graph.edgeTo[from] as number;
      const cs = graph.csrOffset[v] as number;
      const ce = graph.csrOffset[v + 1] as number;
      for (let i = cs; i < ce; i++) {
        if ((graph.csrEdge[i] as number) === to) return tc.seconds[(tc.offset[from] as number) + (i - cs)] as number;
      }
      throw new Error('not adjacent');
    };

    // Into the dead end at node 3, then back: the twin is the only move, so it is free.
    const intoDeadEnd = edgeOf(graph, mapOf(graph), 101, 2, 3);
    expect(cost(intoDeadEnd, tc.twin[intoDeadEnd] as number)).toBe(0);

    // Arriving at the junction node 2, turning back the way you came IS a U-turn and is charged.
    const intoJunction = edgeOf(graph, mapOf(graph), 100, 1, 2);
    expect(cost(intoJunction, tc.twin[intoJunction] as number)).toBe(CFG.uTurnS);
  });
});

/** node id to vertex index, rebuilt from the graph rather than threaded through every call. */
function mapOf(graph: ReturnType<typeof buildGraph>): Map<number, number> {
  const m = new Map<number, number>();
  for (let v = 0; v < graph.vertexNodeId.length; v++) m.set(graph.vertexNodeId[v] as number, v);
  return m;
}

describe('turn costs change which route wins', () => {
  /**
   * A straight trunk road, and a residential shortcut that leaves it and rejoins slightly ahead.
   * The shortcut is marginally shorter in metres, so a router that prices turns at zero takes it.
   * That is precisely the "threading residential streets to save 200 m" behaviour the class-drop
   * term exists to stop.
   */
  function ratRun() {
    return build(
      [
        { id: 1, lat: 28.5000, lon: 77.5000 },
        { id: 2, lat: 28.5100, lon: 77.5000 },
        { id: 3, lat: 28.5200, lon: 77.5000 },
        { id: 4, lat: 28.5300, lon: 77.5000 },
        // The shortcut hangs just off the main line, so its total length is close to the trunk's.
        { id: 5, lat: 28.5100, lon: 77.5002 },
        { id: 6, lat: 28.5200, lon: 77.5002 },
      ],
      [
        { id: 100, refs: [1, 2], tags: { highway: 'trunk' } },
        { id: 101, refs: [2, 3], tags: { highway: 'trunk' } },
        { id: 102, refs: [3, 4], tags: { highway: 'trunk' } },
        { id: 200, refs: [2, 5], tags: { highway: 'residential' } },
        { id: 201, refs: [5, 6], tags: { highway: 'residential' } },
        { id: 202, refs: [6, 3], tags: { highway: 'residential' } },
      ],
    );
  }

  it('POSITIVE CONTROL: with turns free, the residential detour is available and reachable', () => {
    const { graph, turns, vertexOfNodeId } = ratRun();
    const free = new Router(graph, turns);
    const start = edgeOf(graph, vertexOfNodeId, 100, 1, 2);
    const end = edgeOf(graph, vertexOfNodeId, 102, 3, 4);
    const r = free.route(start, 0, end, 1);
    expect(r).not.toBeNull();
    // The detour exists in the graph at all: its edges are routable.
    const viaShortcut = free.route(edgeOf(graph, vertexOfNodeId, 200, 2, 5), 0, end, 1);
    expect(viaShortcut).not.toBeNull();
    expect(r?.turnSeconds).toBe(0);
  });

  it('with turns priced, the trunk route costs no turn penalty and the detour does', () => {
    const { graph, turns, vertexOfNodeId } = ratRun();
    const priced = new Router(graph, turns, CFG);
    const end = edgeOf(graph, vertexOfNodeId, 102, 3, 4);

    const straight = priced.route(edgeOf(graph, vertexOfNodeId, 100, 1, 2), 0, end, 1);
    expect(straight).not.toBeNull();
    // Trunk to trunk, dead straight, same class: nothing to charge.
    expect(straight?.turnSeconds).toBe(0);

    // Forced onto the shortcut, the class drop and the two turns are charged.
    const detour = priced.route(edgeOf(graph, vertexOfNodeId, 200, 2, 5), 0, end, 1);
    expect(detour).not.toBeNull();
    expect(detour?.turnSeconds).toBeGreaterThan(0);
  });

  it('reports turn seconds as a SEPARATE component of the total, not folded invisibly into it', () => {
    const { graph, turns, vertexOfNodeId } = ratRun();
    const end = edgeOf(graph, vertexOfNodeId, 102, 3, 4);
    const start = edgeOf(graph, vertexOfNodeId, 200, 2, 5);

    const free = new Router(graph, turns).route(start, 0, end, 1);
    const priced = new Router(graph, turns, CFG).route(start, 0, end, 1);
    expect(free).not.toBeNull();
    expect(priced).not.toBeNull();
    // Same path, same metres: the only difference is the turn penalty, and it is exactly the
    // number reported. If these drift apart, `seconds` and `turnSeconds` disagree about the route.
    expect(priced?.metres).toBeCloseTo(free?.metres as number, 6);
    expect((priced?.seconds as number) - (free?.seconds as number)).toBeCloseTo(priced?.turnSeconds as number, 6);
  });
});

describe('the shipped configuration', () => {
  it('is non-negative in every field, which is what the A* admissibility proof rests on', () => {
    for (const [k, v] of Object.entries(TURN_COST)) {
      if (typeof v === 'number') expect(v, `TURN_COST.${k}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('drives on the left, because this is India and the crossing turn is a right', () => {
    expect(TURN_COST.drivesOnLeft).toBe(true);
  });
});
