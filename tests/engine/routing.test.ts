/**
 * Dijkstra and turn-restriction enforcement, on toy graphs.
 *
 * EVERY RESTRICTION TEST CARRIES A POSITIVE CONTROL: the same graph is routed with the
 * restriction absent and with it present, and the two answers must DIFFER. Asserting only that
 * the restricted route avoids the banned turn is worthless on its own, because a router that
 * never found that turn in the first place passes it. The control proves the short illegal path
 * exists and that the restriction is what removed it.
 */
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../packages/pipeline/graph/build.ts';
import { buildTurnTable } from '../../packages/pipeline/graph/restrictions.ts';
import { Router } from '../../packages/engine/dijkstra.ts';
import { IdMap } from '../../packages/pipeline/clip/idset.ts';
import type { Clipped, ClipStats, ClippedRelation, ClippedWay } from '../../packages/pipeline/clip/clip.ts';

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

function toy(nodes: readonly N[], ways: readonly W[], relations: readonly ClippedRelation[] = []): Clipped {
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
  return { nodeIds, nodeLat, nodeLon, nodeTags: new Map(), ways: built, relations, stats: EMPTY_STATS, nodeIndex };
}

function build(nodes: readonly N[], ways: readonly W[], relations: readonly ClippedRelation[] = []) {
  const clipped = toy(nodes, ways, relations);
  const graph = buildGraph(clipped);
  const vertexOfNodeId = new Map<number, number>();
  for (let v = 0; v < graph.vertexNodeId.length; v++) vertexOfNodeId.set(graph.vertexNodeId[v] as number, v);
  const turns = buildTurnTable(graph, relations, vertexOfNodeId, clipped);
  return { clipped, graph, turns, router: new Router(graph, turns), vertexOfNodeId };
}

/** The first directed edge of `wayId` that runs from `fromNode` to `toNode`. */
function edgeOf(graph: ReturnType<typeof buildGraph>, vertexOfNodeId: Map<number, number>, wayId: number, fromNode: number, toNode: number): number {
  const a = vertexOfNodeId.get(fromNode);
  const b = vertexOfNodeId.get(toNode);
  for (let e = 0; e < graph.edgeWayId.length; e++) {
    if ((graph.edgeWayId[e] as number) !== wayId) continue;
    if ((graph.edgeFrom[e] as number) === a && (graph.edgeTo[e] as number) === b) return e;
  }
  throw new Error(`no edge of way ${wayId} from node ${fromNode} to ${toNode}`);
}

// ---------------------------------------------------------------------------
// A divided carriageway with a median connector, which is the exact shape OSM
// models a U-turn ban on. Northbound A, southbound B, connector C across the
// median, plus links D and E at each end so the loop is strongly connected.
// ---------------------------------------------------------------------------
const DIVIDED_NODES: N[] = [
  { id: 1, lat: 28.500, lon: 77.5000 },
  { id: 2, lat: 28.505, lon: 77.5000 },
  { id: 3, lat: 28.510, lon: 77.5000 },
  { id: 11, lat: 28.510, lon: 77.5005 },
  { id: 12, lat: 28.505, lon: 77.5005 },
  { id: 13, lat: 28.500, lon: 77.5005 },
];
const DIVIDED_WAYS: W[] = [
  { id: 100, refs: [1, 2, 3], tags: { highway: 'primary', oneway: 'yes' } },   // northbound
  { id: 200, refs: [11, 12, 13], tags: { highway: 'primary', oneway: 'yes' } }, // southbound
  { id: 300, refs: [2, 12], tags: { highway: 'primary' } },                     // median connector
  { id: 400, refs: [3, 11], tags: { highway: 'primary' } },                     // far-end link
  { id: 500, refs: [13, 1], tags: { highway: 'primary' } },                     // near-end link
];

function uTurnViaWay(kind = 'no_u_turn'): ClippedRelation {
  return {
    id: 9001,
    members: [
      { type: 'way', ref: 100, role: 'from' },
      { type: 'way', ref: 300, role: 'via' },
      { type: 'way', ref: 200, role: 'to' },
    ],
    tags: new Map([['type', 'restriction'], ['restriction', kind]]),
  };
}

describe('dijkstra: basic correctness', () => {
  it('finds the shortest path and returns geometry along the road', () => {
    const { graph, router, vertexOfNodeId } = build(DIVIDED_NODES, DIVIDED_WAYS);
    const start = edgeOf(graph, vertexOfNodeId, 100, 1, 2);
    const end = edgeOf(graph, vertexOfNodeId, 100, 2, 3);
    const r = router.route(start, 0, end, 1);
    expect(r).not.toBeNull();
    expect(r?.edges[0]).toBe(start);
    expect(r?.edges[r.edges.length - 1]).toBe(end);
    // Charter item 1: the line is the road's own shape points, so a 3-node way yields 3 points.
    expect((r?.geometry.length ?? 0)).toBeGreaterThanOrEqual(3);
    expect(r?.metres).toBeGreaterThan(1000);
  });

  it('is deterministic: the same query twice gives the identical path', () => {
    const { graph, router, vertexOfNodeId } = build(DIVIDED_NODES, DIVIDED_WAYS);
    const start = edgeOf(graph, vertexOfNodeId, 100, 1, 2);
    const end = edgeOf(graph, vertexOfNodeId, 200, 12, 13);
    const a = router.route(start, 0, end, 1);
    const b = router.route(start, 0, end, 1);
    expect(a?.edges).toEqual(b?.edges);
    expect(a?.seconds).toBe(b?.seconds);
  });

  it('trims geometry to the snapped fractions rather than the junctions', () => {
    const { graph, router, vertexOfNodeId } = build(DIVIDED_NODES, DIVIDED_WAYS);
    const e = edgeOf(graph, vertexOfNodeId, 100, 1, 2);
    const full = router.route(e, 0, e, 1);
    const half = router.route(e, 0.25, e, 0.75);
    expect(full).not.toBeNull();
    expect(half).not.toBeNull();
    // Half the edge must be about half the length, and must NOT start at the junction.
    expect((half?.metres ?? 0)).toBeLessThan((full?.metres ?? 0) * 0.6);
    expect(half?.geometry[0]?.[1]).toBeGreaterThan(full?.geometry[0]?.[1] as number);
  });
});

describe('dijkstra: via-way U-turn restriction', () => {
  it('POSITIVE CONTROL: without the restriction, the short path uses the median connector', () => {
    const { graph, router, vertexOfNodeId } = build(DIVIDED_NODES, DIVIDED_WAYS);
    const start = edgeOf(graph, vertexOfNodeId, 100, 1, 2);
    const end = edgeOf(graph, vertexOfNodeId, 200, 12, 13);
    const r = router.route(start, 0, end, 1);
    expect(r).not.toBeNull();
    const ways = (r?.edges ?? []).map((e) => graph.edgeWayId[e]);
    // This is the illegal U-turn the restriction exists to forbid. It must be the natural
    // shortest path, or the restricted test below proves nothing.
    expect(ways).toContain(300);
    expect(r?.restrictionsApplied).toBe(0);
  });

  it('with the restriction, the U-turn is gone AND a route is still found', () => {
    const rel = uTurnViaWay();
    const { graph, turns, router, vertexOfNodeId } = build(DIVIDED_NODES, DIVIDED_WAYS, [rel]);
    expect(turns.stats.enforcedBySequence).toBe(1);
    expect(turns.stats.notHonoured).toBe(0);

    const start = edgeOf(graph, vertexOfNodeId, 100, 1, 2);
    const end = edgeOf(graph, vertexOfNodeId, 200, 12, 13);
    const r = router.route(start, 0, end, 1);

    // Blocked into failure would be just as wrong as permitting the turn: the destination is
    // legally reachable the long way round, so a null here is a bug, not enforcement.
    expect(r).not.toBeNull();
    const ways = (r?.edges ?? []).map((e) => graph.edgeWayId[e]);
    const viaIdx = ways.indexOf(300);
    if (viaIdx > 0) {
      // Using the connector at all is fine; using it in the banned (from 100, to 200) sequence
      // is not. Assert the exact triple is absent rather than banning the connector outright.
      expect(ways[viaIdx - 1] === 100 && ways[viaIdx + 1] === 200).toBe(false);
    }
    expect(r?.restrictionsApplied ?? 0).toBeGreaterThan(0);
  });

  it('the legal detour is longer than the banned shortcut, proving cost was not ignored', () => {
    const free = build(DIVIDED_NODES, DIVIDED_WAYS);
    const held = build(DIVIDED_NODES, DIVIDED_WAYS, [uTurnViaWay()]);
    const s1 = edgeOf(free.graph, free.vertexOfNodeId, 100, 1, 2);
    const e1 = edgeOf(free.graph, free.vertexOfNodeId, 200, 12, 13);
    const s2 = edgeOf(held.graph, held.vertexOfNodeId, 100, 1, 2);
    const e2 = edgeOf(held.graph, held.vertexOfNodeId, 200, 12, 13);
    const a = free.router.route(s1, 0, e1, 1);
    const b = held.router.route(s2, 0, e2, 1);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b?.seconds ?? 0).toBeGreaterThan(a?.seconds ?? 0);
  });

  it('does not ban the connector in the opposite direction', () => {
    // The via way is bidirectional, so it has two directed edges. Only the one carrying the
    // banned manoeuvre may be restricted; banning both would forbid a legal crossing.
    const { turns } = build(DIVIDED_NODES, DIVIDED_WAYS, [uTurnViaWay()]);
    expect(turns.bannedSequences.size).toBe(1);
    expect(turns.stats.bannedSequenceTriples).toBe(1);
  });
});

describe('dijkstra: via-node restrictions', () => {
  // A T junction: way 100 arrives at node 2, ways 200 and 300 leave it.
  const NODES: N[] = [
    { id: 1, lat: 28.500, lon: 77.500 },
    { id: 2, lat: 28.505, lon: 77.500 },
    { id: 3, lat: 28.505, lon: 77.495 },
    { id: 4, lat: 28.505, lon: 77.505 },
    { id: 5, lat: 28.500, lon: 77.495 },
  ];
  const WAYS: W[] = [
    { id: 100, refs: [1, 2], tags: { highway: 'primary' } },
    { id: 200, refs: [2, 3], tags: { highway: 'primary' } },
    { id: 300, refs: [2, 4], tags: { highway: 'primary' } },
    { id: 400, refs: [3, 5], tags: { highway: 'primary' } },
    { id: 500, refs: [5, 1], tags: { highway: 'primary' } },
  ];
  const restriction = (kind: string, to: number): ClippedRelation => ({
    id: 9100,
    members: [
      { type: 'way', ref: 100, role: 'from' },
      { type: 'node', ref: 2, role: 'via' },
      { type: 'way', ref: to, role: 'to' },
    ],
    tags: new Map([['type', 'restriction'], ['restriction', kind]]),
  });

  it('POSITIVE CONTROL: unrestricted, the direct turn onto way 200 is taken', () => {
    const { graph, router, vertexOfNodeId } = build(NODES, WAYS);
    const start = edgeOf(graph, vertexOfNodeId, 100, 1, 2);
    const end = edgeOf(graph, vertexOfNodeId, 200, 2, 3);
    const r = router.route(start, 0, end, 1);
    expect(r?.edges.length).toBe(2);
    expect(r?.restrictionsApplied).toBe(0);
  });

  it('no_left_turn removes that turn and routes the long way instead', () => {
    const rel = restriction('no_left_turn', 200);
    const { graph, turns, router, vertexOfNodeId } = build(NODES, WAYS, [rel]);
    expect(turns.stats.enforcedByPair).toBe(1);
    const start = edgeOf(graph, vertexOfNodeId, 100, 1, 2);
    const end = edgeOf(graph, vertexOfNodeId, 200, 2, 3);
    const r = router.route(start, 0, end, 1);
    expect(r).not.toBeNull();
    // Two edges would mean the banned turn was taken. The legal path goes round via 500/400.
    expect(r?.edges.length).toBeGreaterThan(2);
    expect(r?.restrictionsApplied ?? 0).toBeGreaterThan(0);
  });

  it('only_straight_on bans the alternatives from that approach', () => {
    const rel = restriction('only_straight_on', 300);
    const { turns } = build(NODES, WAYS, [rel]);
    expect(turns.stats.enforcedByPair).toBe(1);
    expect(turns.stats.bannedTurnPairs).toBeGreaterThan(0);
    expect(turns.stats.notHonoured).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Charter item 1, asserted DIRECTLY on the geometry rather than inferred from a picture.
//
// The on-road browser check ("every route point lands on a rendered road") is an integration
// test: it can only fail once tiles, style and renderer all agree, and it proves fidelity
// indirectly. This proves it at the source. If simplification ever creeps into the wrong layer,
// or an edge is ever emitted as a straight chord between its endpoints, this fails immediately
// and names the way.
// ---------------------------------------------------------------------------
describe('charter item 1: route geometry reproduces the OSM shape exactly', () => {
  // One way, deliberately curved, with SEVEN intermediate shape points between its endpoints.
  // Intermediate points are not vertices, so they exist only in packed edge geometry, which is
  // precisely the thing that gets lost if anything simplifies.
  const CURVE_NODES: N[] = [
    { id: 1, lat: 28.5000, lon: 77.5000 },
    { id: 2, lat: 28.5004, lon: 77.5003 },
    { id: 3, lat: 28.5009, lon: 77.5004 },
    { id: 4, lat: 28.5013, lon: 77.5002 },
    { id: 5, lat: 28.5015, lon: 77.4998 },
    { id: 6, lat: 28.5014, lon: 77.4993 },
    { id: 7, lat: 28.5010, lon: 77.4990 },
    { id: 8, lat: 28.5005, lon: 77.4991 },
    { id: 9, lat: 28.5001, lon: 77.4995 },
  ];
  const CURVE_WAYS: W[] = [
    { id: 900, refs: [1, 2, 3, 4, 5, 6, 7, 8, 9], tags: { highway: 'residential' } },
  ];

  it('emits every intermediate shape point, in order, with none dropped', () => {
    const { graph, router, vertexOfNodeId } = build(CURVE_NODES, CURVE_WAYS);
    const e = edgeOf(graph, vertexOfNodeId, 900, 1, 9);
    // Fractions 0 and 1: the whole edge, so the geometry must be the whole way.
    const r = router.route(e, 0, e, 1);
    expect(r).not.toBeNull();

    const expected = CURVE_NODES.map((n) => [n.lon, n.lat]);
    const got = (r?.geometry ?? []).map((p) => [p[0], p[1]]);
    // Round-trip through the 1e7 scaled integer store costs at most half a unit in the last
    // place, so exactness is asserted at that resolution rather than on the raw float.
    expect(got.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(Math.round((got[i] as number[])[0]! * 1e7)).toBe(Math.round((expected[i] as number[])[0]! * 1e7));
      expect(Math.round((got[i] as number[])[1]! * 1e7)).toBe(Math.round((expected[i] as number[])[1]! * 1e7));
    }
  });

  it('NEGATIVE CONTROL: the straight chord between the endpoints is NOT what is returned', () => {
    // Without this control the assertion above would still pass on a 2-point chord if the
    // expected list were ever reduced to endpoints by an editing mistake. This pins the fact
    // that the way is genuinely curved, so a chord is a materially different answer.
    const { graph, router, vertexOfNodeId } = build(CURVE_NODES, CURVE_WAYS);
    const e = edgeOf(graph, vertexOfNodeId, 900, 1, 9);
    const r = router.route(e, 0, e, 1);
    expect(r?.geometry.length).toBeGreaterThan(2);

    // The polyline must be materially longer than the endpoint-to-endpoint chord. A chord would
    // make these equal; a simplified line would shrink the ratio toward 1.
    const geom = r?.geometry ?? [];
    const seg = (a: readonly number[], b: readonly number[]): number =>
      Math.hypot((b[0]! - a[0]!) * Math.cos((28.5 * Math.PI) / 180), b[1]! - a[1]!);
    let along = 0;
    for (let i = 0; i + 1 < geom.length; i++) along += seg(geom[i]!, geom[i + 1]!);
    const chord = seg(geom[0]!, geom[geom.length - 1]!);
    expect(along / chord).toBeGreaterThan(3);
  });

  it('a partial traversal keeps every interior shape point between the two cut ends', () => {
    // Clipping to a snapped start and end must trim only the ends. Dropping interior points
    // while trimming is the subtle version of the same defect and would not show up above.
    const { graph, router, vertexOfNodeId } = build(CURVE_NODES, CURVE_WAYS);
    const e = edgeOf(graph, vertexOfNodeId, 900, 1, 9);
    const r = router.route(e, 0.1, e, 0.9);
    const geom = r?.geometry ?? [];
    // Interior points are those strictly between the clipped ends. Nodes 2..8 span roughly the
    // middle of the way, so at least the central ones must survive a 10 percent trim.
    const interior = CURVE_NODES.slice(2, 7).map((n) => [
      Math.round(n.lon * 1e7),
      Math.round(n.lat * 1e7),
    ]);
    const present = new Set(geom.map((p) => `${Math.round(p[0] * 1e7)},${Math.round(p[1] * 1e7)}`));
    for (const [lon, lat] of interior) {
      expect(present.has(`${lon},${lat}`)).toBe(true);
    }
  });
});
