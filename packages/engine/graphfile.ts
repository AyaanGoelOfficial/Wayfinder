/**
 * Reads the routing artifact. Pure: bytes in, typed arrays out, no filesystem.
 *
 * `packages/engine/CLAUDE.md` says this package does no IO, and that still holds. The CALLER
 * reads the file; this turns the bytes into a graph. That split is what lets the whole loader be
 * tested from a `Uint8Array` with no filesystem at all.
 *
 * ZERO COPY. Every array is a subarray VIEW over the caller's buffer, which is why the writer
 * orders sections widest-alignment-first. Nothing here allocates a second copy of a 40 MB graph.
 * The buffer must therefore outlive the returned object, which it does: the server holds it for
 * the process lifetime.
 */
import {
  GRAPH_FORMAT_VERSION,
  GRAPH_HEADER_BYTES,
  GRAPH_MAGIC,
  U8_SECTIONS_PER_EDGE,
  alignUp,
} from '../shared/graphfile.ts';
import type { SerializedTurns } from '../shared/graphfile.ts';
import type { RoutableGraph, Restrictions } from './dijkstra.ts';

/** Everything the server needs from the artifact. */
export interface LoadedArtifact {
  /** Satisfies `RoutableGraph`, and additionally what `SnapIndex` reads. */
  readonly graph: RoutableGraph & {
    readonly vertexLon: Float64Array;
    readonly vertexNodeId: Float64Array;
    readonly edgePrivate: Uint8Array;
    readonly edgeClassRank: Uint8Array;
    readonly edgeToll: Uint8Array;
  };
  readonly restrictions: Restrictions & {
    readonly banned: ReadonlyMap<number, ReadonlySet<number>>;
    readonly bannedSequences: ReadonlyMap<number, readonly { fromEdge: number; toEdge: number }[]>;
  };
  /** The build-time stat blocks, carried through so the server can log what it loaded. */
  readonly stats: { readonly graph: Record<string, unknown>; readonly restrictions: Record<string, unknown> };
}

export function parseGraphArtifact(bytes: Uint8Array): LoadedArtifact {
  if (bytes.byteLength < GRAPH_HEADER_BYTES) {
    throw new Error('routing artifact is truncated: shorter than its own header.');
  }
  const head = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = head.getUint32(0, true);
  if (magic !== GRAPH_MAGIC) {
    throw new Error('that file is not a routing artifact (bad magic). Run `npm run build-city`.');
  }
  const version = head.getUint32(4, true);
  if (version !== GRAPH_FORMAT_VERSION) {
    // Named loudly rather than tolerated: a misread binary yields a graph that is WRONG, not one
    // that fails, and a wrong graph routes confidently into the Indian Ocean.
    throw new Error(
      `routing artifact is format v${version}, this build wants v${GRAPH_FORMAT_VERSION}. ` +
        'Run `npm run build-city` to rebuild it.',
    );
  }

  const V = head.getUint32(8, true);
  const E = head.getUint32(12, true);
  const S = head.getUint32(16, true);
  const P = head.getUint32(20, true);
  const statsLen = head.getUint32(24, true);
  const turnsLen = head.getUint32(28, true);

  const dec = new TextDecoder('utf-8');
  const base = bytes.byteOffset;
  const statsAt = GRAPH_HEADER_BYTES;
  const turnsAt = statsAt + statsLen;
  const stats = JSON.parse(dec.decode(bytes.subarray(statsAt, turnsAt))) as LoadedArtifact['stats'];
  const turns = JSON.parse(dec.decode(bytes.subarray(turnsAt, turnsAt + turnsLen))) as SerializedTurns;

  const f64Start = base + alignUp(GRAPH_HEADER_BYTES + statsLen + turnsLen, 8);
  const f64Count = V * 3 + E * 2;
  const i32Start = f64Start + f64Count * 8;
  const i32Count = V + 1 + E * 4 + (S + 1) + P * 2;
  const u8Start = i32Start + i32Count * 4;
  const expected = u8Start - base + E * U8_SECTIONS_PER_EDGE;
  if (bytes.byteLength < expected) {
    throw new Error(
      `routing artifact is truncated: header declares ${expected.toLocaleString('en-US')} bytes, ` +
        `file has ${bytes.byteLength.toLocaleString('en-US')}. Run \`npm run build-city\`.`,
    );
  }

  let o = f64Start;
  const takeF = (n: number): Float64Array => {
    const a = new Float64Array(bytes.buffer, o, n);
    o += n * 8;
    return a;
  };
  const vertexLat = takeF(V);
  const vertexLon = takeF(V);
  const vertexNodeId = takeF(V);
  const edgeLengthM = takeF(E);
  const edgeWayId = takeF(E);

  let p = i32Start;
  const takeI = (n: number): Int32Array => {
    const a = new Int32Array(bytes.buffer, p, n);
    p += n * 4;
    return a;
  };
  const csrOffset = takeI(V + 1);
  const csrEdge = takeI(E);
  const edgeFrom = takeI(E);
  const edgeTo = takeI(E);
  const edgeShape = takeI(E);
  const shapeOffset = takeI(S + 1);
  const shapeLat = takeI(P);
  const shapeLon = takeI(P);

  const edgeSpeedKmh = new Uint8Array(bytes.buffer, u8Start, E);
  const edgeReversed = new Uint8Array(bytes.buffer, u8Start + E, E);
  const edgePrivate = new Uint8Array(bytes.buffer, u8Start + E * 2, E);
  const edgeRestricted = new Uint8Array(bytes.buffer, u8Start + E * 3, E);
  const edgeClassRank = new Uint8Array(bytes.buffer, u8Start + E * 4, E);
  const edgeToll = new Uint8Array(bytes.buffer, u8Start + E * 5, E);

  const banned = new Map<number, ReadonlySet<number>>();
  for (const [via, tos] of turns.banned) banned.set(via, new Set(tos));
  const bannedSequences = new Map<number, readonly { fromEdge: number; toEdge: number }[]>();
  for (const [via, seqs] of turns.sequences) bannedSequences.set(via, seqs);

  return {
    graph: {
      vertexLat, vertexLon, vertexNodeId,
      csrOffset, csrEdge,
      edgeFrom, edgeTo, edgeLengthM, edgeSpeedKmh, edgeWayId, edgeShape, edgeReversed, edgePrivate,
      edgeClassRank, edgeToll,
      shapeOffset, shapeLat, shapeLon,
    },
    restrictions: { banned, bannedSequences, edgeRestricted },
    stats,
  };
}
