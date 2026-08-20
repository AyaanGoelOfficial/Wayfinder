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
 *   header      MAGIC, version, four u32 counts, three u32 JSON byte lengths
 *   statsJson   graph stats and restriction stats, UTF-8
 *   turnsJson   the banned pair and banned sequence tables, UTF-8. Tiny: tens of entries.
 *   namesJson   the road name table, a UTF-8 JSON array of strings, indexed by `edgeNameId`
 *   pad         to an 8-byte boundary
 *   f64 block   vertexLat, vertexLon, vertexNodeId, edgeLengthM, edgeWayId
 *   i32 block   csrOffset, csrEdge, edgeFrom, edgeTo, edgeShape, edgeNameId, shapeOffset,
 *               shapeLat, shapeLon
 *   u8  block   edgeSpeedKmh, edgeReversed, edgePrivate, edgeRestricted, edgeClassRank, edgeToll,
 *               edgeTollRoad, edgeTollGate, edgeTollSegment, edgeRoundabout
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
 *
 * v3 added `edgeToll`. Whether a road charges a toll is a FACT about the road and belongs in the
 * graph; what a toll is worth is a preference and lives in `config/city.ts`. Keeping the two apart
 * is what lets the same artifact serve both "tolls allowed but priced" and "avoid tolls entirely"
 * without a rebuild.
 *
 * v4 replaced the single toll FLAG with the two facts a priced model needs, and left the flag in
 * place because `avoidTolls` is a hard filter that only needs to know "any toll at all".
 * `edgeTollRoad` is the id of the entry in `TOLL_ROADS` that charges this edge, 0 for none, so the
 * artifact records WHICH road charges rather than assuming one rate for all of them.
 * `edgeTollGate` is 1 when the edge contains a mainline toll plaza node, which is what a
 * gate-charged road bills on. Neither carries an AMOUNT: prices, mechanisms and confidence live in
 * `config/city.ts`, so a tariff revision never requires a graph rebuild.
 *
 * v5 added `edgeTollSegment` and widened the meaning of `edgeTollGate` from a flag to a kind.
 * `edgeTollGate` is now 0 none, 1 mainline barrier, 2 ramp booth: marking only mainline barriers
 * left the router free to leave a gate-charged expressway and rejoin past the plaza for nothing,
 * which it did. `edgeTollSegment` is the inter-plaza span an edge lies in, 255 when not applicable,
 * and it is what lets a CLOSED entry-exit system be priced from its published fare matrix: a route
 * occupying spans a..b entered at plaza a and left at plaza b+1. Both are positions and kinds, not
 * amounts, so the rule that a tariff revision never rebuilds the graph still holds.
 *
 * v6 added `edgeNameId`, the `namesJson` string table it indexes, and `edgeRoundabout`. Turn-by-turn
 * instructions cannot be derived without them and cannot be faked from anything else in the file:
 * a manoeuvre is named after the road it puts you on, and "take the third exit" requires knowing
 * which edges form the circle. Both are FACTS ABOUT THE ROAD, which is why they live here and not
 * in the engine. The names are interned rather than stored per edge because they repeat heavily:
 * a long arterial is hundreds of edges carrying one string.
 */
export const GRAPH_FORMAT_VERSION = 6;

/** Byte length of the fixed header: magic, version, 4 counts, 3 JSON lengths, one spare, all u32. */
export const GRAPH_HEADER_BYTES = 4 * 10;

/** Per-edge u8 arrays, in write order. The count is what sizes the u8 block. */
export const U8_SECTIONS_PER_EDGE = 10;

/** Per-edge i32 arrays that are not derived from a count. Sizes the i32 block alongside the rest. */
export const I32_SECTIONS_PER_EDGE = 6;

/** `edgeNameId` where the way carries no usable name. Never an index into the table. */
export const NAME_NONE = -1;

/**
 * Values of `edgeTollGate`. Here rather than in the pipeline because the writer and the reader are
 * in packages that may not import each other, and two enums agreeing by comment is exactly the
 * failure this file exists to prevent.
 */
export const TOLL_GATE_NONE = 0;
/** A barrier across the through carriageway. Bills a flat fee per crossing. */
export const TOLL_GATE_MAINLINE = 1;
/** An interchange ramp booth. Bills by distance, and its existence is what closes the barrier dodge. */
export const TOLL_GATE_RAMP = 2;

/** `edgeTollSegment` where the edge is not on a closed-system road, or has no chainage. */
export const EPE_SEGMENT_NONE = 255;

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
