/**
 * Turn-by-turn instructions, on toy graphs where the right answer is known by construction.
 *
 * EVERY TEST HERE EXISTS BECAUSE THE REAL ROUTES EXPOSED A DEFECT FIRST. The generator was written,
 * run against `jewar to gaur-city` and `alpha-1 to surajpur`, and each thing it got wrong is pinned
 * below on a graph small enough that the correct output is not a matter of opinion. A suite written
 * before that pass would have asserted the shape of the output rather than its content.
 *
 * SUPPRESSION IS THE HARD PART, NOT DETECTION. A vertex exists wherever two ways meet, so a route
 * through a crossroads produces an edge change with no manoeuvre in it. Most of these tests assert
 * that NOTHING is emitted, which is the assertion that keeps a 30 km route readable.
 */
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../packages/pipeline/graph/build.ts';
import { buildInstructions } from '../../packages/engine/instructions.ts';
import { IdMap } from '../../packages/pipeline/clip/idset.ts';
import type { Clipped, ClipStats, ClippedWay } from '../../packages/pipeline/clip/clip.ts';
import type { Instruction, LngLat, ManeuverType } from '../../packages/shared/index.ts';

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
  return { graph, vertexOfNodeId };
}

/**
 * The directed edge from one node to another, whichever way carries it.
 *
 * Deliberately not "the edge on way W": a route is a sequence of directed edges and the way is an
 * implementation detail of how they were built, so addressing edges by their endpoints keeps these
 * tests describing routes rather than describing the builder.
 */
function edgeBetween(
  graph: ReturnType<typeof buildGraph>,
  vertexOfNodeId: Map<number, number>,
  fromNode: number,
  toNode: number,
): number {
  const a = vertexOfNodeId.get(fromNode);
  const b = vertexOfNodeId.get(toNode);
  if (a === undefined || b === undefined) throw new Error(`node ${fromNode} or ${toNode} is not a vertex`);
  for (let e = 0; e < graph.edgeFrom.length; e++) {
    if (graph.edgeFrom[e] === a && graph.edgeTo[e] === b) return e;
  }
  throw new Error(`no edge from node ${fromNode} to node ${toNode}`);
}

/** The route line for an edge sequence, from the packed shapes, in the order they are driven. */
function geometryOf(graph: ReturnType<typeof buildGraph>, edges: readonly number[]): LngLat[] {
  const out: LngLat[] = [];
  for (const e of edges) {
    const s = graph.edgeShape[e] as number;
    const from = graph.shapeOffset[s] as number;
    const to = graph.shapeOffset[s + 1] as number;
    const pts: LngLat[] = [];
    for (let i = from; i < to; i++) {
      pts.push([(graph.shapeLon[i] as number) / SCALE, (graph.shapeLat[i] as number) / SCALE]);
    }
    if (graph.edgeReversed[e] === 1) pts.reverse();
    for (const p of pts) {
      const last = out[out.length - 1];
      if (last === undefined || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
  }
  return out;
}

function run(nodes: readonly N[], ways: readonly W[], path: readonly number[]): Instruction[] {
  const { graph, vertexOfNodeId } = build(nodes, ways);
  const edges: number[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    edges.push(edgeBetween(graph, vertexOfNodeId, path[i] as number, path[i + 1] as number));
  }
  return buildInstructions({
    graph,
    roadNames: graph.roadNames,
    edges,
    geometry: geometryOf(graph, edges),
  });
}

const types = (ins: readonly Instruction[]): ManeuverType[] => ins.map((i) => i.type);

/** A stub road, tagged so it survives the car profile and is bidirectional. */
const road = (id: number, refs: number[], tags: Record<string, string>): W => ({
  id,
  refs,
  tags: { highway: 'tertiary', ...tags },
});

describe('instructions: the frame every route has', () => {
  it('opens with depart and closes with arrive, and says nothing else on one straight road', () => {
    const ins = run(
      [
        { id: 1, lat: 28.50, lon: 77.50 },
        { id: 2, lat: 28.51, lon: 77.50 },
        { id: 3, lat: 28.52, lon: 77.50 },
      ],
      [road(100, [1, 2, 3], { name: 'Straight Road' })],
      [1, 3],
    );
    expect(types(ins)).toEqual(['depart', 'arrive']);
    expect(ins[0]?.roadName).toBe('Straight Road');
  });

  it('places every manoeuvre at a real index into the geometry it was given', () => {
    const { graph, vertexOfNodeId } = build(
      [
        { id: 1, lat: 28.50, lon: 77.50 },
        { id: 2, lat: 28.51, lon: 77.50 },
        { id: 3, lat: 28.51, lon: 77.52 },
      ],
      [road(100, [1, 2], { name: 'First Road' }), road(200, [2, 3], { name: 'Second Road' })],
    );
    const edges = [edgeBetween(graph, vertexOfNodeId, 1, 2), edgeBetween(graph, vertexOfNodeId, 2, 3)];
    const geometry = geometryOf(graph, edges);
    const ins = buildInstructions({ graph, roadNames: graph.roadNames, edges, geometry });
    for (const step of ins) {
      expect(step.geometryIndex).toBeGreaterThanOrEqual(0);
      expect(step.geometryIndex).toBeLessThan(geometry.length);
      expect(step.distanceM).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(step.durationS)).toBe(true);
    }
    expect(ins[ins.length - 1]?.geometryIndex).toBe(geometry.length - 1);
  });
});

describe('instructions: a bend is not a manoeuvre', () => {
  /**
   * The defect this pins: `turn slight left onto Noida-Greater Noida Expressway` while already on
   * it, 20 km into a 73 km route. A vertex exists at every junction, so a road that curves through
   * one gets an edge change with a real angle in it, and announcing that is what makes a driver
   * stop reading the list.
   */
  it('says nothing when one continuously named road bends through a junction', () => {
    const ins = run(
      [
        { id: 1, lat: 28.500, lon: 77.500 },
        { id: 2, lat: 28.505, lon: 77.500 },
        { id: 3, lat: 28.509, lon: 77.503 },
        { id: 4, lat: 28.512, lon: 77.506 },
        { id: 9, lat: 28.505, lon: 77.495 },
      ],
      [
        road(100, [1, 2, 3, 4], { name: 'Bendy Road' }),
        road(900, [2, 9], { name: 'Side Lane' }),
      ],
      [1, 2, 4],
    );
    expect(types(ins)).toEqual(['depart', 'arrive']);
  });

  it('still announces a square corner on the same road, because that is a real corner', () => {
    const ins = run(
      [
        { id: 1, lat: 28.500, lon: 77.500 },
        { id: 2, lat: 28.505, lon: 77.500 },
        { id: 3, lat: 28.505, lon: 77.494 },
        { id: 4, lat: 28.505, lon: 77.488 },
        { id: 9, lat: 28.505, lon: 77.506 },
      ],
      [
        road(100, [1, 2, 3, 4], { name: 'Corner Road' }),
        road(900, [2, 9], { name: 'Side Lane' }),
      ],
      [1, 2, 4],
    );
    expect(types(ins)).toContain('turn-left');
  });
});

describe('instructions: joining and leaving a big road', () => {
  /**
   * The defect this pins: the single most important instruction on a 73 km route was missing.
   * `merge` originally required a name change, and the slip road onto the Yamuna Expressway is
   * unnamed, as is the road it leaves, so nothing fired at all.
   */
  it('merges onto a motorway from an unnamed slip road, and names the motorway not the ramp', () => {
    const ins = run(
      [
        { id: 1, lat: 28.500, lon: 77.500 },
        { id: 2, lat: 28.504, lon: 77.500 },
        { id: 3, lat: 28.508, lon: 77.500 },
        { id: 4, lat: 28.516, lon: 77.500 },
      ],
      [
        road(100, [1, 2], {}),
        // `oneway=no` on both, explicitly. A motorway and a motorway_link are IMPLIED one-way, so
        // without this the toy chain is not strongly connected and SCC filtering discards the whole
        // thing, which surfaces as "node 2 is not a vertex" rather than as anything about merging.
        { id: 200, refs: [2, 3], tags: { highway: 'motorway_link', oneway: 'no' } },
        { id: 300, refs: [3, 4], tags: { highway: 'motorway', name: 'Test Expressway', oneway: 'no' } },
      ],
      [1, 2, 3, 4],
    );
    expect(types(ins)).toContain('merge');
    // Named from AHEAD of the junction. The ramp itself is unnamed, and "merge onto (unnamed)" is
    // the failure this assertion exists to prevent.
    expect(ins.find((i) => i.type === 'merge')?.roadName).toBe('Test Expressway');
  });

  /**
   * The defect this pins: a bare class test fired five times in 2.5 km on the Faridabad approach,
   * because rural trunk roads here flip between trunk and unclassified along one carriageway.
   */
  it('does not announce an exit when the class flips but the road name does not', () => {
    const ins = run(
      [
        { id: 1, lat: 28.500, lon: 77.500 },
        { id: 2, lat: 28.506, lon: 77.500 },
        { id: 3, lat: 28.512, lon: 77.500 },
        { id: 9, lat: 28.506, lon: 77.495 },
      ],
      [
        { id: 100, refs: [1, 2], tags: { highway: 'trunk', name: 'Flipping Road' } },
        { id: 200, refs: [2, 3], tags: { highway: 'unclassified', name: 'Flipping Road' } },
        road(900, [2, 9], { name: 'Side Lane' }),
      ],
      [1, 2, 3],
    );
    expect(types(ins)).toEqual(['depart', 'arrive']);
  });
});

describe('instructions: OSM names structures separately, drivers do not', () => {
  /**
   * The defect this pins: "continue onto Vikas Marg" three times in 7 km. OSM names the underpass
   * and the flyover as separate ways along one continuous road, so the raw names really do change
   * at each and a naive name-change rule announces all of them.
   */
  it('does not announce a structural variant of the road already being driven', () => {
    const ins = run(
      [
        { id: 1, lat: 28.500, lon: 77.500 },
        { id: 2, lat: 28.508, lon: 77.500 },
        { id: 3, lat: 28.514, lon: 77.500 },
        { id: 4, lat: 28.522, lon: 77.500 },
        { id: 8, lat: 28.508, lon: 77.495 },
        { id: 9, lat: 28.514, lon: 77.495 },
      ],
      [
        road(100, [1, 2], { name: 'Vikas Marg' }),
        road(200, [2, 3], { name: 'Vikas Marg Underpass' }),
        road(300, [3, 4], { name: 'Vikas Marg' }),
        road(800, [2, 8], { name: 'Side One' }),
        road(900, [3, 9], { name: 'Side Two' }),
      ],
      [1, 2, 3, 4],
    );
    expect(types(ins)).toEqual(['depart', 'arrive']);
  });

  it('does announce a genuinely different road reached straight on', () => {
    const ins = run(
      [
        { id: 1, lat: 28.500, lon: 77.500 },
        { id: 2, lat: 28.508, lon: 77.500 },
        { id: 3, lat: 28.518, lon: 77.500 },
        { id: 9, lat: 28.508, lon: 77.495 },
      ],
      [
        road(100, [1, 2], { name: 'First Marg' }),
        road(200, [2, 3], { name: 'Second Marg' }),
        road(900, [2, 9], { name: 'Side Lane' }),
      ],
      [1, 2, 3],
    );
    expect(types(ins)).toContain('straight');
    expect(ins.find((i) => i.type === 'straight')?.roadName).toBe('Second Marg');
  });
});

describe('instructions: roundabouts are counted, not narrated', () => {
  /**
   * A roundabout is two instructions and an exit number, never one instruction per circle segment.
   * The exit taken is counted while traversing, which is the only reason `edgeRoundabout` is in the
   * artifact at all.
   */
  it('emits exactly ONE instruction per circle, at the entry, carrying a 1-based exit number', () => {
    const ins = run(
      [
        { id: 1, lat: 28.4980, lon: 77.5000 },
        { id: 10, lat: 28.5000, lon: 77.5000 },
        { id: 11, lat: 28.5000, lon: 77.5020 },
        { id: 12, lat: 28.5020, lon: 77.5020 },
        { id: 13, lat: 28.5020, lon: 77.5000 },
        { id: 21, lat: 28.5000, lon: 77.5040 },
        { id: 22, lat: 28.5040, lon: 77.5020 },
        { id: 23, lat: 28.5040, lon: 77.5000 },
      ],
      [
        road(100, [1, 10], { name: 'Approach Road' }),
        { id: 200, refs: [10, 11, 12, 13, 10], tags: { highway: 'tertiary', junction: 'roundabout' } },
        road(301, [11, 21], { name: 'First Exit Road' }),
        road(302, [12, 22], { name: 'Second Exit Road' }),
        road(303, [13, 23], { name: 'Third Exit Road' }),
      ],
      [1, 10, 11, 12, 13, 23],
    );
    // ONE instruction, not a pair. A separate enter and exit read "0 m" on every small circle,
    // because on a short traversal the entry and the exit are the same place, and a number that
    // has to be explained is a number that is wrong on screen.
    expect(ins.filter((i) => i.type === 'roundabout-exit')).toHaveLength(1);
    expect(ins.filter((i) => i.type === 'roundabout-enter')).toHaveLength(0);
    const exit = ins.find((i) => i.type === 'roundabout-exit');
    expect(exit?.roundaboutExit).toBeGreaterThanOrEqual(1);
    expect(exit?.roadName).toBe('Third Exit Road');
    // The circle itself is never narrated segment by segment.
    expect(ins.filter((i) => i.type.startsWith('turn'))).toHaveLength(0);
  });

  /**
   * The defect this pins: a divided exit meets the circle twice, once per carriageway, and counting
   * both inflates that exit number and every later one. Measured on `alpha-1 to surajpur` as two
   * exit nodes 8.4 m apart on a 218 m circumference, which is 14 degrees of arc.
   */
  it('counts a divided exit once, not twice', () => {
    // Two exit roads leaving within a few metres of each other are one physical exit.
    const ins = run(
      [
        { id: 1, lat: 28.4980, lon: 77.5000 },
        { id: 10, lat: 28.5000, lon: 77.5000 },
        { id: 11, lat: 28.5000, lon: 77.5020 },
        { id: 12, lat: 28.50003, lon: 77.50208 }, // 9 m further round: the second carriageway
        { id: 13, lat: 28.5020, lon: 77.5020 },
        { id: 14, lat: 28.5020, lon: 77.5000 },
        { id: 21, lat: 28.5000, lon: 77.5040 },
        { id: 22, lat: 28.50003, lon: 77.50408 },
        { id: 23, lat: 28.5040, lon: 77.5020 },
        { id: 24, lat: 28.5040, lon: 77.5000 },
      ],
      [
        road(100, [1, 10], { name: 'Approach Road' }),
        { id: 200, refs: [10, 11, 12, 13, 14, 10], tags: { highway: 'tertiary', junction: 'roundabout' } },
        road(301, [11, 21], { name: 'Divided Exit A' }),
        road(302, [12, 22], { name: 'Divided Exit B' }),
        road(303, [13, 23], { name: 'Second Exit Road' }),
        road(304, [14, 24], { name: 'Third Exit Road' }),
      ],
      [1, 10, 11, 12, 13, 23],
    );
    const exit = ins.find((i) => i.type === 'roundabout-exit');
    // Without the merge the two carriageways of the first exit count separately and this reads 3.
    expect(exit?.roundaboutExit).toBe(2);
  });
});

describe('instructions: a divided arm is one exit, however far apart it meets the circle', () => {
  /**
   * The defect this pins: circle 3 of `alpha-1 to surajpur` reported exit 3 where a driver counts
   * exit 2. Two carriageways of one road meet that roundabout 28.7 m apart, which is WIDER than
   * gaps between genuine exits elsewhere on the same route, so no distance rule can separate them.
   * Their arms run 657 m and 659 m and rejoin at a shared node, and their bearings differ by 3.8
   * degrees. Direction is the discriminator; distance is not.
   */
  it('counts two exits heading the same way as one, at a spacing distance cannot reject', () => {
    const ins = run(
      [
        { id: 1, lat: 28.4980, lon: 77.5000 },
        { id: 10, lat: 28.5000, lon: 77.5000 },
        { id: 11, lat: 28.5000, lon: 77.5020 },
        { id: 12, lat: 28.5003, lon: 77.5023 }, // ~40 m further round: too far for the proximity rule
        { id: 13, lat: 28.5020, lon: 77.5020 },
        { id: 14, lat: 28.5020, lon: 77.5000 },
        // Both carriageways of one arm, running east, well separated where they meet the circle.
        { id: 21, lat: 28.5000, lon: 77.5060 },
        { id: 22, lat: 28.5003, lon: 77.5063 },
        { id: 23, lat: 28.5060, lon: 77.5020 },
        { id: 24, lat: 28.5060, lon: 77.5000 },
      ],
      [
        road(100, [1, 10], { name: 'Approach Road' }),
        { id: 200, refs: [10, 11, 12, 13, 14, 10], tags: { highway: 'tertiary', junction: 'roundabout' } },
        road(301, [11, 21], { name: 'Divided Arm North' }),
        road(302, [12, 22], { name: 'Divided Arm South' }),
        road(303, [13, 23], { name: 'Second Exit Road' }),
        road(304, [14, 24], { name: 'Third Exit Road' }),
      ],
      [1, 10, 11, 12, 13, 23],
    );
    const exit = ins.find((i) => i.type === 'roundabout-exit');
    // Counting both halves of the eastern arm would read 3.
    expect(exit?.roundaboutExit).toBe(2);
  });

  it('still counts two exits heading different ways separately at the same spacing', () => {
    // CONTROL. Same geometry, but the second road heads north instead of east. Without this the
    // test above would pass against a rule that merges any two exits 40 m apart.
    const ins = run(
      [
        { id: 1, lat: 28.4980, lon: 77.5000 },
        { id: 10, lat: 28.5000, lon: 77.5000 },
        { id: 11, lat: 28.5000, lon: 77.5020 },
        { id: 12, lat: 28.5003, lon: 77.5023 },
        { id: 13, lat: 28.5020, lon: 77.5020 },
        { id: 14, lat: 28.5020, lon: 77.5000 },
        { id: 21, lat: 28.5000, lon: 77.5060 },
        { id: 22, lat: 28.5033, lon: 77.5053 }, // north east: 49 deg off the east arm, 41 off the north one
        { id: 23, lat: 28.5060, lon: 77.5020 },
        { id: 24, lat: 28.5060, lon: 77.5000 },
      ],
      [
        road(100, [1, 10], { name: 'Approach Road' }),
        { id: 200, refs: [10, 11, 12, 13, 14, 10], tags: { highway: 'tertiary', junction: 'roundabout' } },
        road(301, [11, 21], { name: 'East Road' }),
        road(302, [12, 22], { name: 'North East Road' }),
        road(303, [13, 23], { name: 'Second Exit Road' }),
        road(304, [14, 24], { name: 'Third Exit Road' }),
      ],
      [1, 10, 11, 12, 13, 23],
    );
    expect(ins.find((i) => i.type === 'roundabout-exit')?.roundaboutExit).toBe(3);
  });
});

describe('instructions: an unnamed road is the common case here, not an error', () => {
  it('carries no roadName rather than an empty string when the way has no name', () => {
    const ins = run(
      [
        { id: 1, lat: 28.500, lon: 77.500 },
        { id: 2, lat: 28.505, lon: 77.500 },
        { id: 3, lat: 28.505, lon: 77.494 },
        { id: 9, lat: 28.505, lon: 77.506 },
      ],
      [
        road(100, [1, 2, 3], {}),
        road(900, [2, 9], { name: 'Side Lane' }),
      ],
      [1, 2, 3],
    );
    for (const step of ins) {
      // Absent, never present-and-empty. An empty string renders as "Turn left onto " with a
      // dangling preposition, which is worse than saying "Turn left".
      expect(step.roadName === undefined || step.roadName.length > 0).toBe(true);
    }
  });
});
