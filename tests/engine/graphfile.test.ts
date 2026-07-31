/**
 * The routing artifact survives a write/read round trip, byte for byte.
 *
 * This is the seam where a wrong answer is SILENT: a misread binary produces a graph that is
 * populated and plausible rather than one that throws, so the router would return confident
 * nonsense. Every array is compared element by element, and the turn tables are compared as
 * content rather than as counts, because Maps and Sets do not survive JSON and would arrive empty
 * while every count still looked right.
 */
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../packages/pipeline/graph/build.ts';
import { buildTurnTable } from '../../packages/pipeline/graph/restrictions.ts';
import { serializeGraphArtifact } from '../../packages/pipeline/graph/serialize.ts';
import { parseGraphArtifact } from '../../packages/engine/graphfile.ts';
import { Router } from '../../packages/engine/dijkstra.ts';
import { GRAPH_FORMAT_VERSION } from '../../packages/shared/graphfile.ts';
import { IdMap } from '../../packages/pipeline/clip/idset.ts';
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

function toy(nodes: readonly N[], ways: readonly W[]): Clipped {
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
  return { nodeIds, nodeLat, nodeLon, nodeTags: new Map(), ways: built, relations: [], stats: EMPTY_STATS, nodeIndex };
}

// A junction with a curved arm, so shape points, CSR fan-out and both edge directions are all
// exercised rather than a single straight segment that would hide an offset error.
const NODES: N[] = [
  { id: 1, lat: 28.5000, lon: 77.5000 },
  { id: 2, lat: 28.5010, lon: 77.5005 },
  { id: 3, lat: 28.5014, lon: 77.5012 },
  { id: 4, lat: 28.5020, lon: 77.5020 },
  { id: 5, lat: 28.5030, lon: 77.5010 },
  { id: 6, lat: 28.5030, lon: 77.5030 },
];
const WAYS: W[] = [
  { id: 100, refs: [1, 2, 3, 4], tags: { highway: 'secondary' } },
  { id: 200, refs: [4, 5], tags: { highway: 'residential' } },
  { id: 300, refs: [4, 6], tags: { highway: 'residential', oneway: 'yes' } },
  { id: 400, refs: [5, 6], tags: { highway: 'residential' } },
  { id: 500, refs: [6, 1], tags: { highway: 'residential' } },
];

function built() {
  const clipped = toy(NODES, WAYS);
  const graph = buildGraph(clipped);
  const vertexOfNodeId = new Map<number, number>();
  for (let v = 0; v < graph.vertexNodeId.length; v++) vertexOfNodeId.set(graph.vertexNodeId[v] as number, v);
  const turns = buildTurnTable(graph, [], vertexOfNodeId, clipped);
  return { graph, turns };
}

describe('routing artifact round trip', () => {
  it('every array survives write then read, element for element', () => {
    const { graph, turns } = built();
    const loaded = parseGraphArtifact(serializeGraphArtifact(graph, turns));

    const same = (a: ArrayLike<number>, b: ArrayLike<number>, label: string): void => {
      expect(b.length, `${label} length`).toBe(a.length);
      for (let i = 0; i < a.length; i++) expect(b[i], `${label}[${i}]`).toBe(a[i]);
    };
    same(graph.vertexLat, loaded.graph.vertexLat, 'vertexLat');
    same(graph.vertexLon, loaded.graph.vertexLon, 'vertexLon');
    same(graph.vertexNodeId, loaded.graph.vertexNodeId, 'vertexNodeId');
    same(graph.csrOffset, loaded.graph.csrOffset, 'csrOffset');
    same(graph.csrEdge, loaded.graph.csrEdge, 'csrEdge');
    same(graph.edgeFrom, loaded.graph.edgeFrom, 'edgeFrom');
    same(graph.edgeTo, loaded.graph.edgeTo, 'edgeTo');
    same(graph.edgeLengthM, loaded.graph.edgeLengthM, 'edgeLengthM');
    same(graph.edgeSpeedKmh, loaded.graph.edgeSpeedKmh, 'edgeSpeedKmh');
    same(graph.edgeWayId, loaded.graph.edgeWayId, 'edgeWayId');
    same(graph.edgeShape, loaded.graph.edgeShape, 'edgeShape');
    same(graph.edgeReversed, loaded.graph.edgeReversed, 'edgeReversed');
    same(graph.edgePrivate, loaded.graph.edgePrivate, 'edgePrivate');
    same(graph.shapeOffset, loaded.graph.shapeOffset, 'shapeOffset');
    same(graph.shapeLat, loaded.graph.shapeLat, 'shapeLat');
    same(graph.shapeLon, loaded.graph.shapeLon, 'shapeLon');
    same(turns.edgeRestricted, loaded.restrictions.edgeRestricted, 'edgeRestricted');
  });

  it('routes identically before and after the round trip', () => {
    // The real assertion. Arrays matching is necessary but not sufficient: an off-by-one in a
    // section offset can leave every array the right length and the wrong contents shifted.
    const { graph, turns } = built();
    const loaded = parseGraphArtifact(serializeGraphArtifact(graph, turns));

    const direct = new Router(graph, turns);
    const viaFile = new Router(loaded.graph, loaded.restrictions);
    for (let e = 0; e < graph.edgeFrom.length; e++) {
      const a = direct.route(e, 0, (e + 3) % graph.edgeFrom.length, 1);
      const b = viaFile.route(e, 0, (e + 3) % graph.edgeFrom.length, 1);
      expect(b === null).toBe(a === null);
      if (a !== null && b !== null) {
        expect(b.edges).toEqual(a.edges);
        expect(b.seconds).toBeCloseTo(a.seconds, 9);
        expect(b.metres).toBeCloseTo(a.metres, 9);
        expect(b.geometry).toEqual(a.geometry);
      }
    }
  });

  it('carries the turn tables as CONTENT, not as empty maps that still count right', () => {
    // Maps and Sets stringify to `{}`. If that ever happens the artifact loads clean and every
    // restriction silently disappears, so this asserts the entries themselves.
    const { graph, turns } = built();
    const seq = new Map(turns.bannedSequences);
    // Plant a triple so the assertion has something to lose even on a graph with no OSM
    // restrictions. Without this the test would pass against a writer that drops sequences.
    seq.set(0, [{ fromEdge: 1, toEdge: 2 }]);
    const banned = new Map(turns.banned);
    banned.set(3, new Set([4, 5]));
    const loaded = parseGraphArtifact(
      serializeGraphArtifact(graph, { ...turns, banned, bannedSequences: seq }),
    );

    expect([...(loaded.restrictions.banned.get(3) ?? [])].sort()).toEqual([4, 5]);
    expect(loaded.restrictions.bannedSequences.get(0)).toEqual([{ fromEdge: 1, toEdge: 2 }]);
  });

  it('refuses a file with the wrong magic, and names the rebuild command', () => {
    const { graph, turns } = built();
    const corrupt = serializeGraphArtifact(graph, turns).slice();
    corrupt[0] = 0;
    expect(() => parseGraphArtifact(corrupt)).toThrow(/not a routing artifact/);
  });

  it('refuses a version it does not understand', () => {
    const { graph, turns } = built();
    const bytes = serializeGraphArtifact(graph, turns);
    const wrong = bytes.slice();
    new DataView(wrong.buffer, wrong.byteOffset).setUint32(4, GRAPH_FORMAT_VERSION + 1, true);
    expect(() => parseGraphArtifact(wrong)).toThrow(/build-city/);
  });

  it('refuses a truncated file rather than reading past the end', () => {
    const { graph, turns } = built();
    const bytes = serializeGraphArtifact(graph, turns);
    expect(() => parseGraphArtifact(bytes.slice(0, bytes.length - 8))).toThrow(/truncated/);
  });
});
