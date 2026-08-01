/**
 * The on-disk routing artifact: layout, version, and the shapes both sides agree on.
 *
 * WHY THIS EXISTS. The server used to build the graph at boot by importing `pipeline/`, which
 * `packages/server/CLAUDE.md` forbids and which cost 3.8 s of rebuild on every start. The fix is
 * a real artifact: `build-city` writes it, the server memory-loads it, and the boundary holds.
 *
 * WHY THE FORMAT LIVES IN `shared/`. The writer is in `pipeline/` and the parser is in `engine/`,
 * and per the capability matrix neither may import the other. Both may import `shared/`, so the
 * layout is stated once, here, and the two implementations are held to it by this file rather
 * than by comments agreeing with each other.
 *
 * LAYOUT. Little-endian throughout. Sections are ordered by alignment, widest first, so every
 * typed array can be created as a ZERO-COPY subarray view over the loaded buffer rather than
 * copied out of it. That is the whole point of memory-loading a 40 MB artifact.
 *
 *   header      MAGIC, version, six u32 counts, two u32 JSON byte lengths
 *   statsJson   graph stats and restriction stats, UTF-8
 *   turnsJson   the banned pair and banned sequence tables, UTF-8. Tiny: tens of entries.
 *   pad         to an 8-byte boundary
 *   f64 block   vertexLat, vertexLon, vertexNodeId, edgeLengthM, edgeWayId
 *   i32 block   csrOffset, csrEdge, edgeFrom, edgeTo, edgeShape, shapeOffset, shapeLat, shapeLon
 *   u8  block   edgeSpeedKmh, edgeReversed, edgePrivate, edgeRestricted, edgeClassRank
 *
 * VERSIONING. Any change to the section list, the order, or an element type is a version bump.
 * The loader refuses a mismatch and names the command that rebuilds it, because a silently
 * misread binary artifact produces a graph that is wrong rather than a graph that fails.
 */

/** Spells "WGN1" so a truncated or wrong file is rejected on the first four bytes. */
export const GRAPH_MAGIC = 0x5747_4e31;

/**
 * Bump on ANY layout change. See the versioning note above.
 *
 * v2 added `edgeClassRank` to the u8 block, for the turn cost model. It is stored rather than
 * derived because the engine has no way tags: the alternative was inferring road class from
 * `edgeSpeedKmh`, which a single `maxspeed` tag makes wrong (a residential street posted at 60
 * would outrank a tertiary road).
 */
export const GRAPH_FORMAT_VERSION = 2;

/** Byte length of the fixed header: magic, version, 6 counts, 2 JSON lengths, all u32. */
export const GRAPH_HEADER_BYTES = 4 * 10;

/** Per-edge u8 arrays, in write order. The count is what sizes the u8 block. */
export const U8_SECTIONS_PER_EDGE = 5;

export interface GraphFileCounts {
  readonly vertexCount: number;
  readonly edgeCount: number;
  /** `shapeOffset` has `shapeCount + 1` entries. */
  readonly shapeCount: number;
  readonly shapePointCount: number;
}

/** One banned ordered triple across a via way, keyed elsewhere by its middle edge. */
export interface SerializedSequence {
  readonly fromEdge: number;
  readonly toEdge: number;
}

/**
 * The turn tables in a JSON-friendly shape.
 *
 * Maps and Sets do not survive `JSON.stringify`, and silently become `{}`, which would produce an
 * artifact whose restrictions all vanish while every count still looked right. Arrays of pairs
 * are used instead so the failure mode cannot occur.
 */
export interface SerializedTurns {
  /** `[viaEdge, [toEdge, ...]]`, for via-node restrictions. */
  readonly banned: readonly (readonly [number, readonly number[]])[];
  /** `[viaEdge, [{fromEdge, toEdge}, ...]]`, for via-way restrictions. */
  readonly sequences: readonly (readonly [number, readonly SerializedSequence[]])[];
}

/** Round `n` up to the next multiple of `align`. */
export function alignUp(n: number, align: number): number {
  const r = n % align;
  return r === 0 ? n : n + (align - r);
}
