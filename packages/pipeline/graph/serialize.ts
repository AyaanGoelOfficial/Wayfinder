/**
 * Writes the routing artifact. The reader is `packages/engine/graphfile.ts`; the layout both obey
 * is `packages/shared/graphfile.ts`.
 *
 * Only the fields the SERVER needs are written. `drivableWayIds` and `vertexNodeIdsBeforeScc` are
 * build-time diagnostics for telling an undrivable restriction member apart from an SCC-dropped
 * one; they are large, they are meaningless after the build, and carrying them would grow the
 * artifact for nothing.
 */
import {
  GRAPH_FORMAT_VERSION,
  GRAPH_HEADER_BYTES,
  GRAPH_MAGIC,
  alignUp,
} from '../../shared/graphfile.ts';
import type { SerializedTurns } from '../../shared/graphfile.ts';
import type { Graph } from './build.ts';
import type { TurnTable } from './restrictions.ts';

export function serializeGraphArtifact(graph: Graph, turns: TurnTable): Uint8Array {
  const V = graph.vertexLat.length;
  const E = graph.edgeFrom.length;
  const S = graph.shapeOffset.length - 1;
  const P = graph.shapeLat.length;

  const turnsPayload: SerializedTurns = {
    banned: [...turns.banned].map(([via, tos]) => [via, [...tos]] as const),
    sequences: [...turns.bannedSequences].map(
      ([via, seqs]) => [via, seqs.map((s) => ({ fromEdge: s.fromEdge, toEdge: s.toEdge }))] as const,
    ),
  };

  const enc = new TextEncoder();
  const statsJson = enc.encode(JSON.stringify({ graph: graph.stats, restrictions: turns.stats }));
  const turnsJson = enc.encode(JSON.stringify(turnsPayload));

  const jsonEnd = GRAPH_HEADER_BYTES + statsJson.length + turnsJson.length;
  const f64Start = alignUp(jsonEnd, 8);
  const f64Count = V * 3 + E * 2;
  const i32Start = f64Start + f64Count * 8;
  const i32Count = V + 1 + E * 4 + (S + 1) + P * 2;
  const u8Start = i32Start + i32Count * 4;
  const total = u8Start + E * 4;

  const buf = new ArrayBuffer(total);
  const bytes = new Uint8Array(buf);
  const head = new DataView(buf);

  head.setUint32(0, GRAPH_MAGIC, true);
  head.setUint32(4, GRAPH_FORMAT_VERSION, true);
  head.setUint32(8, V, true);
  head.setUint32(12, E, true);
  head.setUint32(16, S, true);
  head.setUint32(20, P, true);
  head.setUint32(24, statsJson.length, true);
  head.setUint32(28, turnsJson.length, true);
  head.setUint32(32, 0, true);
  head.setUint32(36, 0, true);

  bytes.set(statsJson, GRAPH_HEADER_BYTES);
  bytes.set(turnsJson, GRAPH_HEADER_BYTES + statsJson.length);

  const f64 = new Float64Array(buf, f64Start, f64Count);
  let o = 0;
  const putF = (a: Float64Array): void => {
    f64.set(a, o);
    o += a.length;
  };
  putF(graph.vertexLat);
  putF(graph.vertexLon);
  putF(graph.vertexNodeId);
  putF(graph.edgeLengthM);
  putF(graph.edgeWayId);

  const i32 = new Int32Array(buf, i32Start, i32Count);
  let p = 0;
  const putI = (a: Int32Array): void => {
    i32.set(a, p);
    p += a.length;
  };
  putI(graph.csrOffset);
  putI(graph.csrEdge);
  putI(graph.edgeFrom);
  putI(graph.edgeTo);
  putI(graph.edgeShape);
  putI(graph.shapeOffset);
  putI(graph.shapeLat);
  putI(graph.shapeLon);

  const u8 = new Uint8Array(buf, u8Start, E * 4);
  u8.set(graph.edgeSpeedKmh, 0);
  u8.set(graph.edgeReversed, E);
  u8.set(graph.edgePrivate, E * 2);
  u8.set(turns.edgeRestricted, E * 3);

  return bytes;
}
