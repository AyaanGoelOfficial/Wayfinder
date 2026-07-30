/**
 * Graph construction and the car profile, on toy graphs.
 *
 * Toy graphs are the right instrument here for the same reason the engine uses them: every
 * property that matters (a vertex appears only at an endpoint or intersection, a one-way is
 * one edge, `oneway=-1` reverses, a stranded component is pruned) is checkable on four nodes,
 * and a failure names the exact rule rather than pointing at a million-vertex graph.
 *
 * These are the four traps the spec calls for: the one-way trap, the turn restriction, the
 * divided road, and the disconnected pair.
 */
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../packages/pipeline/graph/build.ts';
import { buildTurnTable } from '../../packages/pipeline/graph/restrictions.ts';
import {
  accessOf,
  classifyWay,
  directionOf,
  parseMaxspeed,
} from '../../packages/pipeline/graph/profile.ts';
import { IdMap } from '../../packages/pipeline/clip/idset.ts';
import type { Clipped, ClipStats, ClippedRelation, ClippedWay } from '../../packages/pipeline/clip/clip.ts';

const SCALE = 1e7;

interface ToyNode {
  readonly id: number;
  readonly lat: number;
  readonly lon: number;
}
interface ToyWay {
  readonly id: number;
  readonly refs: readonly number[];
  readonly tags: Record<string, string>;
}

const EMPTY_STATS: ClipStats = {
  perFile: [],
  nodesInAreaSummed: 0,
  nodesInAreaUnion: 0,
  seamOverlapNodes: 0,
  duplicates: { nodes: 0, ways: 0, relations: 0 },
  sampleDuplicateWayIds: [],
  sampleDuplicateNodeIds: [],
  keptNodes: 0,
  keptWays: 0,
  keptWaysWithHighway: 0,
  keptRelations: 0,
  keptRestrictions: 0,
  relationsOutsideArea: 0,
  nestedRelationMembers: 0,
  extraNodesForCompleteWays: 0,
  pass1Seconds: 0,
  pass2Seconds: 0,
  writeSeconds: 0,
  peakRssBytes: 0,
  cacheBytes: 0,
};

function toy(nodes: readonly ToyNode[], ways: readonly ToyWay[], relations: readonly ClippedRelation[] = []): Clipped {
  const nodeIndex = new IdMap(Math.max(1024, nodes.length));
  const nodeIds = new Float64Array(nodes.length);
  const nodeLat = new Int32Array(nodes.length);
  const nodeLon = new Int32Array(nodes.length);
  nodes.forEach((nd, i) => {
    nodeIndex.set(nd.id, i);
    nodeIds[i] = nd.id;
    nodeLat[i] = Math.round(nd.lat * SCALE);
    nodeLon[i] = Math.round(nd.lon * SCALE);
  });
  const built: ClippedWay[] = ways.map((w) => ({
    id: w.id,
    refs: w.refs,
    tags: new Map(Object.entries(w.tags)),
  }));
  return {
    nodeIds,
    nodeLat,
    nodeLon,
    nodeTags: new Map(),
    ways: built,
    relations,
    stats: EMPTY_STATS,
    nodeIndex,
  };
}

/** A north-south line of nodes, roughly 111 m apart per 0.001 degree of latitude. */
function line(startId: number, count: number, lon = 77.5, lat0 = 28.5): ToyNode[] {
  return Array.from({ length: count }, (_, i) => ({ id: startId + i, lat: lat0 + i * 0.001, lon }));
}

describe('profile: maxspeed parsing', () => {
  it('reads the forms that actually occur', () => {
    expect(parseMaxspeed('60')).toBe(60);
    expect(parseMaxspeed('60 km/h')).toBe(60);
    expect(parseMaxspeed('80kmh')).toBe(80);
    expect(parseMaxspeed('30 mph')).toBeCloseTo(48.28, 1);
  });

  it('returns undefined for values it cannot resolve, so the class default is used', () => {
    // Guessing a number here would put a fabricated measurement into every ETA on that road.
    for (const v of [undefined, '', 'none', 'signals', 'walk', 'IN:urban', 'fast', '0', '500']) {
      expect(parseMaxspeed(v)).toBeUndefined();
    }
  });
});

describe('profile: access', () => {
  it('reads the most specific key first', () => {
    expect(accessOf(new Map([['access', 'private'], ['motorcar', 'yes']]))).toBe('allowed');
    expect(accessOf(new Map([['access', 'yes'], ['motor_vehicle', 'no']]))).toBe('denied');
  });

  it('separates private from denied, which the gated-campus fixture depends on', () => {
    // GBU: a destination inside the campus must snap to a LEGAL edge at the gate, and the route
    // must neither fail nor silently drive through. That needs "private", not "absent".
    expect(accessOf(new Map([['access', 'private']]))).toBe('private');
    expect(accessOf(new Map([['access', 'no']]))).toBe('denied');
    expect(accessOf(new Map())).toBe('allowed');
  });
});

describe('profile: direction', () => {
  it('handles oneway=-1, which silently reverses a road when missed', () => {
    const d = directionOf(new Map([['oneway', '-1']]), 'primary');
    expect(d.forward).toBe(false);
    expect(d.backward).toBe(true);
  });

  it('implies oneway on roundabouts, motorway and motorway_link', () => {
    expect(directionOf(new Map([['junction', 'roundabout']]), 'primary').backward).toBe(false);
    expect(directionOf(new Map(), 'motorway').backward).toBe(false);
    expect(directionOf(new Map(), 'motorway_link').backward).toBe(false);
    expect(directionOf(new Map(), 'primary').backward).toBe(true);
  });

  it('lets an explicit oneway=no override every implication', () => {
    const d = directionOf(new Map([['junction', 'roundabout'], ['oneway', 'no']]), 'motorway');
    expect(d.forward).toBe(true);
    expect(d.backward).toBe(true);
  });
});

describe('profile: drivability', () => {
  it('excludes unknown highway values rather than admitting them', () => {
    // New OSM values appear over time; a permissive default puts a car on whatever is invented.
    expect(classifyWay(new Map([['highway', 'hyperloop']])).drivable).toBe(false);
    expect(classifyWay(new Map([['highway', 'footway']])).drivable).toBe(false);
    expect(classifyWay(new Map([['highway', 'track']])).drivable).toBe(false);
    expect(classifyWay(new Map([['highway', 'residential']])).drivable).toBe(true);
  });

  it('keeps a private way drivable but flagged', () => {
    const c = classifyWay(new Map([['highway', 'service'], ['access', 'private']]));
    expect(c.drivable).toBe(true);
    expect(c.access).toBe('private');
  });
});

describe('graph: vertices exist only at endpoints and intersections', () => {
  it('makes a plain 5-node way exactly 2 vertices with 5 shape points', () => {
    const g = buildGraph(toy(line(1, 5), [{ id: 100, refs: [1, 2, 3, 4, 5], tags: { highway: 'residential' } }]));
    // Charter item 1 is structural: the three interior nodes are shape, not topology.
    expect(g.stats.verticesBeforeScc).toBe(2);
    expect(g.stats.edgesBeforeScc).toBe(2); // bidirectional
    expect(g.stats.shapePoints).toBe(5);
    expect(g.vertexLat.length).toBe(2);
  });

  it('promotes a shared interior node to a vertex', () => {
    const nodes = [...line(1, 5), { id: 10, lat: 28.502, lon: 77.51 }];
    const g = buildGraph(
      toy(nodes, [
        { id: 100, refs: [1, 2, 3, 4, 5], tags: { highway: 'residential' } },
        { id: 101, refs: [3, 10], tags: { highway: 'residential' } },
      ]),
    );
    // Node 3 is now an intersection, so the first way splits into two segments.
    expect(g.stats.verticesBeforeScc).toBe(4); // 1, 3, 5, 10
    expect(g.stats.edgesBeforeScc).toBe(6); // 3 segments, both directions
  });

  it('gives a one-way exactly one directed edge, and strands it if it is a lone stub', () => {
    const g = buildGraph(
      toy(line(1, 3), [{ id: 100, refs: [1, 2, 3], tags: { highway: 'primary', oneway: 'yes' } }]),
    );
    expect(g.stats.edgesBeforeScc).toBe(1);
    // And then SCC removes it. That is CORRECT, not a bug: a one-way with no return path is
    // not strongly connected, so neither end can be both entered and left. Keeping it would let
    // the router strand a driver on a road with no way out.
    expect(g.stats.verticesAfterScc).toBe(1);
    expect(g.stats.edgesAfterScc).toBe(0);
  });

  it('directs a triangle of one-ways so that it stays strongly connected', () => {
    // 1 -> 2 -> 3 -> 1. Every leg one-way, and the cycle is the only thing keeping the graph
    // connected, so a single mis-directed edge collapses the SCC. That makes SCC survival
    // itself the assertion about direction.
    const g = buildGraph(
      toy([...line(1, 3)], [
        { id: 100, refs: [1, 2], tags: { highway: 'primary', oneway: 'yes' } },
        { id: 101, refs: [2, 3], tags: { highway: 'primary', oneway: 'yes' } },
        { id: 102, refs: [3, 1], tags: { highway: 'primary', oneway: 'yes' } },
      ]),
    );
    expect(g.stats.verticesAfterScc).toBe(3);
    expect(g.stats.edgesAfterScc).toBe(3);
    expect(g.stats.largestSccShare).toBe(1);
  });

  it('reverses the edge for oneway=-1', () => {
    // Same triangle, but the closing leg is tagged with reversed node order: refs [1, 3] with
    // oneway=-1 means 3 -> 1. Read as forward it would be 1 -> 3, vertex 3 would have no exit,
    // and the SCC would fragment. So this asserts the exact bug that silently reverses a road.
    const g = buildGraph(
      toy([...line(1, 3)], [
        { id: 100, refs: [1, 2], tags: { highway: 'primary', oneway: 'yes' } },
        { id: 101, refs: [2, 3], tags: { highway: 'primary', oneway: 'yes' } },
        { id: 102, refs: [1, 3], tags: { highway: 'primary', oneway: '-1' } },
      ]),
    );
    expect(g.stats.verticesAfterScc).toBe(3);
    expect(g.stats.edgesAfterScc).toBe(3);

    const vertexOfNode = new Map<number, number>();
    for (let v = 0; v < g.vertexNodeId.length; v++) vertexOfNode.set(g.vertexNodeId[v] as number, v);
    let found = false;
    for (let e = 0; e < g.edgeWayId.length; e++) {
      if ((g.edgeWayId[e] as number) !== 102) continue;
      found = true;
      expect(g.edgeFrom[e]).toBe(vertexOfNode.get(3));
      expect(g.edgeTo[e]).toBe(vertexOfNode.get(1));
      expect(g.edgeReversed[e]).toBe(1);
    }
    expect(found).toBe(true);
  });

  it('measures edge length along the shape, not endpoint to endpoint', () => {
    // An L-shaped way. Straight-line distance between the ends is shorter than the road, and
    // using it would make every ETA optimistic on every bend.
    const nodes = [
      { id: 1, lat: 28.5, lon: 77.5 },
      { id: 2, lat: 28.51, lon: 77.5 },
      { id: 3, lat: 28.51, lon: 77.51 },
    ];
    const g = buildGraph(toy(nodes, [{ id: 100, refs: [1, 2, 3], tags: { highway: 'residential' } }]));
    const len = g.edgeLengthM[0] as number;
    expect(len).toBeGreaterThan(2000); // ~1.11 km + ~0.98 km
    expect(len).toBeLessThan(2200);
  });
});

describe('graph: SCC filtering', () => {
  it('drops the smaller half of a disconnected pair', () => {
    const g = buildGraph(
      toy([...line(1, 4), ...line(20, 2, 77.9)], [
        { id: 100, refs: [1, 2, 3, 4], tags: { highway: 'residential' } },
        { id: 101, refs: [20, 21], tags: { highway: 'residential' } },
      ]),
    );
    expect(g.stats.sccCount).toBe(2);
    expect(g.stats.verticesBeforeScc).toBe(4);
    // Both components are bidirectional, so each is one SCC. The larger survives.
    expect(g.stats.verticesAfterScc).toBe(2);
    expect(g.stats.largestSccShare).toBeCloseTo(0.5, 5);
  });

  it('prunes a one-way trap: a spur you can enter but never leave', () => {
    // 1-2-3 is a two-way road. 3->4 is one-way away from it, so 4 can be reached but never
    // left, which puts it in its own component. A router that kept it could strand a driver.
    const nodes = [...line(1, 3), { id: 4, lat: 28.503, lon: 77.5 }];
    const g = buildGraph(
      toy(nodes, [
        { id: 100, refs: [1, 2, 3], tags: { highway: 'residential' } },
        { id: 101, refs: [3, 4], tags: { highway: 'residential', oneway: 'yes' } },
      ]),
    );
    expect(g.stats.verticesBeforeScc).toBe(3); // 1, 3, 4
    expect(g.stats.verticesAfterScc).toBe(2); // 4 is stranded and removed
    for (let v = 0; v < g.vertexNodeId.length; v++) {
      expect(g.vertexNodeId[v]).not.toBe(4);
    }
  });

  it('keeps both carriageways of a divided road as separate one-ways', () => {
    // The divided-road case behind charter item 3: two parallel one-ways about 20 m apart,
    // joined at both ends. Everything stays in one SCC and no carriageway is merged away.
    const nodes = [
      { id: 1, lat: 28.5, lon: 77.5 },
      { id: 2, lat: 28.51, lon: 77.5 },
      { id: 3, lat: 28.51, lon: 77.5002 },
      { id: 4, lat: 28.5, lon: 77.5002 },
    ];
    const g = buildGraph(
      toy(nodes, [
        { id: 100, refs: [1, 2], tags: { highway: 'trunk', oneway: 'yes' } },
        { id: 101, refs: [3, 4], tags: { highway: 'trunk', oneway: 'yes' } },
        { id: 102, refs: [2, 3], tags: { highway: 'trunk' } },
        { id: 103, refs: [4, 1], tags: { highway: 'trunk' } },
      ]),
    );
    expect(g.stats.verticesAfterScc).toBe(4);
    expect(g.stats.largestSccShare).toBe(1);
    // Two distinct one-way carriageways survive as separate edges, not one averaged centreline.
    const oneWayEdges = [...g.edgeWayId].filter((id) => id === 100 || id === 101);
    expect(oneWayEdges.length).toBe(2);
  });
});

describe('graph: turn restrictions', () => {
  function tJunction() {
    // Way 100 approaches junction node 2 from the south. Ways 101 (west) and 102 (east) leave.
    const nodes = [
      { id: 1, lat: 28.5, lon: 77.5 },
      { id: 2, lat: 28.51, lon: 77.5 },
      { id: 3, lat: 28.51, lon: 77.49 },
      { id: 4, lat: 28.51, lon: 77.51 },
    ];
    const ways: ToyWay[] = [
      { id: 100, refs: [1, 2], tags: { highway: 'primary' } },
      { id: 101, refs: [2, 3], tags: { highway: 'primary' } },
      { id: 102, refs: [2, 4], tags: { highway: 'primary' } },
    ];
    return { nodes, ways };
  }

  function restriction(kind: string, from: number, via: number, to: number): ClippedRelation {
    return {
      id: 900,
      members: [
        { type: 'way', ref: from, role: 'from' },
        { type: 'node', ref: via, role: 'via' },
        { type: 'way', ref: to, role: 'to' },
      ],
      tags: new Map([['type', 'restriction'], ['restriction', kind]]),
    };
  }

  it('bans exactly the prohibited turn, in the arriving direction only', () => {
    const { nodes, ways } = tJunction();
    const rel = restriction('no_left_turn', 100, 2, 101);
    const g = buildGraph(toy(nodes, ways, [rel]));
    const vertexOfNodeId = new Map<number, number>();
    for (let v = 0; v < g.vertexNodeId.length; v++) vertexOfNodeId.set(g.vertexNodeId[v] as number, v);
    const t = buildTurnTable(g, [rel], vertexOfNodeId, toy(nodes, ways, [rel]));

    expect(t.stats.relationsSeen).toBe(1);
    expect(t.stats.resolved).toBe(1);
    // Exactly one pair: the edge of way 100 that ARRIVES at node 2, paired with the edge of
    // way 101 that LEAVES it. The opposite directions of both ways are untouched, and banning
    // them would forbid legal turns.
    expect(t.stats.bannedTurnPairs).toBe(1);
    const [fromEdge, toSet] = [...t.banned][0] as [number, ReadonlySet<number>];
    const via = vertexOfNodeId.get(2);
    expect(g.edgeTo[fromEdge]).toBe(via);
    expect(g.edgeWayId[fromEdge]).toBe(100);
    const toEdge = [...toSet][0] as number;
    expect(g.edgeFrom[toEdge]).toBe(via);
    expect(g.edgeWayId[toEdge]).toBe(101);
  });

  it('only_straight_on bans the alternatives instead of the named turn', () => {
    const { nodes, ways } = tJunction();
    const rel = restriction('only_straight_on', 100, 2, 102);
    const g = buildGraph(toy(nodes, ways, [rel]));
    const vertexOfNodeId = new Map<number, number>();
    for (let v = 0; v < g.vertexNodeId.length; v++) vertexOfNodeId.set(g.vertexNodeId[v] as number, v);
    const t = buildTurnTable(g, [rel], vertexOfNodeId, toy(nodes, ways, [rel]));

    expect(t.stats.resolved).toBe(1);
    // Way 101 leaving the junction is the only alternative, so exactly one ban. The U-turn back
    // down way 100 is deliberately left alone: OSM models that with a separate no_u_turn.
    expect(t.stats.bannedTurnPairs).toBe(1);
    const banned = [...t.banned.values()][0] as ReadonlySet<number>;
    for (const e of banned) expect(g.edgeWayId[e]).toBe(101);
  });

  it('counts a via-way restriction as unsupported rather than dropping it silently', () => {
    const { nodes, ways } = tJunction();
    const rel: ClippedRelation = {
      id: 901,
      members: [
        { type: 'way', ref: 100, role: 'from' },
        { type: 'way', ref: 102, role: 'via' },
        { type: 'way', ref: 101, role: 'to' },
      ],
      tags: new Map([['type', 'restriction'], ['restriction', 'no_left_turn']]),
    };
    const g = buildGraph(toy(nodes, ways, [rel]));
    const vertexOfNodeId = new Map<number, number>();
    for (let v = 0; v < g.vertexNodeId.length; v++) vertexOfNodeId.set(g.vertexNodeId[v] as number, v);
    const t = buildTurnTable(g, [rel], vertexOfNodeId, toy(nodes, ways, [rel]));
    // A restriction silently discarded is an illegal turn the router takes happily.
    expect(t.stats.byReason['via-way-unsupported']).toBe(1);
    // A real prohibition on drivable roads that we cannot express is NOT benign.
    expect(t.stats.notHonoured).toBe(1);
    expect(t.stats.bannedTurnPairs).toBe(0);
  });

  it('counts a conditional restriction as not honoured', () => {
    const { nodes, ways } = tJunction();
    const rel: ClippedRelation = {
      id: 902,
      members: [
        { type: 'way', ref: 100, role: 'from' },
        { type: 'node', ref: 2, role: 'via' },
        { type: 'way', ref: 101, role: 'to' },
      ],
      tags: new Map([
        ['type', 'restriction'],
        ['restriction', 'no_left_turn @ (Mo-Fr 07:00-10:00)'],
      ]),
    };
    const g = buildGraph(toy(nodes, ways, [rel]));
    const vertexOfNodeId = new Map<number, number>();
    for (let v = 0; v < g.vertexNodeId.length; v++) vertexOfNodeId.set(g.vertexNodeId[v] as number, v);
    const t = buildTurnTable(g, [rel], vertexOfNodeId, toy(nodes, ways, [rel]));
    expect(t.stats.byReason['conditional']).toBe(1);
    // Deliberate non-application, so it cannot permit an illegal turn at all times.
    expect(t.stats.correctlyIgnored).toBe(1);
    expect(t.stats.bannedTurnPairs).toBe(0);
  });
});
