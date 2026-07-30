/**
 * Serializes the clipped subset back out as a valid `.osm.pbf`.
 *
 * WHY: tilemaker reads `.osm.pbf`, and the alternative is pointing it at the two raw extracts.
 * That would be wrong in three ways at once. It would process 91.5M nodes to render a district
 * of 2M. It would re-introduce the Central/Northern seam that the clip just deduped, so
 * every element along the western edge would be drawn twice and every label along it doubled.
 * And it would mean the tiles came from different bytes than the graph, which breaks the one
 * governing principle of this project: one source, three derivatives. A route line and the
 * road under it can only be guaranteed to agree if they were built from identical input.
 *
 * Feeding a pre-deduped single file makes doubled seam labels STRUCTURALLY IMPOSSIBLE rather
 * than something to inspect the output for, which is a better guarantee than a visual check.
 *
 * Format written, per https://wiki.openstreetmap.org/wiki/PBF_Format:
 *   [4-byte BE length of BlobHeader][BlobHeader][Blob]  repeated
 *   BlobHeader { 1: string type, 3: int32 datasize }
 *   Blob       { 2: int32 raw_size, 3: bytes zlib_data }
 *   OSMHeader  -> HeaderBlock, OSMData -> PrimitiveBlock
 *
 * Granularity is 100 with zero offsets, which is the default and makes the DenseNodes delta
 * values EXACTLY the 1e7-scaled integers already held in the clip: lat = 1e-9 * (0 + 100 * d)
 * = 1e-7 * d. So no coordinate is converted, rounded, or re-derived on the way out.
 */
import { deflateSync } from 'node:zlib';
import { ByteWriter } from './binio.ts';
import { IdSet } from './idset.ts';
import type { Clipped } from './clip.ts';

/** Elements per PrimitiveBlock. 8000 is the format's conventional figure. */
const BLOCK_SIZE = 8000;
const GRANULARITY = 100;
/** Scaled 1e7 to the nanodegrees the header bbox is expressed in. */
const SCALED_TO_NANO = 100;

export interface PbfWriteStats {
  readonly bytes: number;
  readonly nodes: number;
  readonly ways: number;
  readonly relations: number;
  readonly blocks: number;
  /** Way refs pointing at a node not in the clip. Dropped so the output stays self-consistent. */
  readonly danglingRefsDropped: number;
  readonly waysDroppedTooShort: number;
  readonly seconds: number;
}

function tag(w: ByteWriter, field: number, wire: number): void {
  w.varint(field * 8 + wire);
}
const VARINT = 0;
const BYTES = 2;

function submessage(w: ByteWriter, field: number, body: ByteWriter): void {
  tag(w, field, BYTES);
  w.bytes(body.view());
}

/** Packed repeated field: one length-delimited run of varints. */
function packedVarint(w: ByteWriter, field: number, values: readonly number[]): void {
  if (values.length === 0) return;
  const inner = new ByteWriter(values.length * 2 + 16);
  for (const v of values) inner.varint(v);
  submessage(w, field, inner);
}
function packedSVarint(w: ByteWriter, field: number, values: readonly number[]): void {
  if (values.length === 0) return;
  const inner = new ByteWriter(values.length * 2 + 16);
  for (const v of values) inner.svarint(v);
  submessage(w, field, inner);
}

/** Interns strings for one block. Index 0 MUST be the empty string, per the format. */
class BlockStrings {
  private readonly index = new Map<string, number>();
  readonly list: string[] = [''];

  of(s: string): number {
    const existing = this.index.get(s);
    if (existing !== undefined) return existing;
    const i = this.list.length;
    this.list.push(s);
    this.index.set(s, i);
    return i;
  }

  write(): ByteWriter {
    const w = new ByteWriter(1 << 14);
    for (const s of this.list) {
      tag(w, 1, BYTES);
      w.string(s);
    }
    return w;
  }
}

function framedBlob(type: string, payload: Uint8Array): Uint8Array {
  const compressed = deflateSync(payload, { level: 6 });

  const blob = new ByteWriter(compressed.length + 32);
  tag(blob, 2, VARINT);
  blob.varint(payload.length); // raw_size
  tag(blob, 3, BYTES);
  blob.bytes(compressed);
  const blobBytes = blob.view();

  const header = new ByteWriter(64);
  tag(header, 1, BYTES);
  header.string(type);
  tag(header, 3, VARINT);
  header.varint(blobBytes.length);
  const headerBytes = header.view();

  const out = new Uint8Array(4 + headerBytes.length + blobBytes.length);
  // Length prefix is BIG-endian, unlike everything else in the format.
  out[0] = (headerBytes.length >>> 24) & 0xff;
  out[1] = (headerBytes.length >>> 16) & 0xff;
  out[2] = (headerBytes.length >>> 8) & 0xff;
  out[3] = headerBytes.length & 0xff;
  out.set(headerBytes, 4);
  out.set(blobBytes, 4 + headerBytes.length);
  return out;
}

function headerBlock(bbox: {
  minLatScaled: number;
  maxLatScaled: number;
  minLonScaled: number;
  maxLonScaled: number;
}): Uint8Array {
  const bb = new ByteWriter(64);
  tag(bb, 1, VARINT); bb.svarint(bbox.minLonScaled * SCALED_TO_NANO); // left
  tag(bb, 2, VARINT); bb.svarint(bbox.maxLonScaled * SCALED_TO_NANO); // right
  tag(bb, 3, VARINT); bb.svarint(bbox.maxLatScaled * SCALED_TO_NANO); // top
  tag(bb, 4, VARINT); bb.svarint(bbox.minLatScaled * SCALED_TO_NANO); // bottom

  const h = new ByteWriter(256);
  submessage(h, 1, bb);
  // Field 4 is required_features and field 5 is optional_features, and the distinction is not
  // cosmetic: a reader MUST refuse a file whose required features it does not implement. Only
  // OsmSchema-V0.6, DenseNodes and HistoricalInformation belong in field 4. Declaring
  // Sort.Type_then_ID as REQUIRED made libosmium reject the file outright with
  // "required feature not supported", and crashed tilemaker with a stack-buffer fail-fast.
  for (const f of ['OsmSchema-V0.6', 'DenseNodes']) {
    tag(h, 4, BYTES);
    h.string(f);
  }
  for (const f of ['Sort.Type_then_ID']) {
    tag(h, 5, BYTES);
    h.string(f);
  }
  tag(h, 16, BYTES);
  h.string('wayfinder-gn clip writer');
  return Uint8Array.prototype.slice.call(h.view());
}

/**
 * Writes the clip as a type-sorted, id-sorted PBF.
 *
 * Sorting is required, not cosmetic: DenseNodes stores ids as deltas, and the header declares
 * `Sort.Type_then_ID`, which readers (including ours, in the clip's own pass 2) rely on to stop
 * early. Declaring it while writing unsorted data would be a lie that breaks other tools
 * silently.
 */
export function writeClipAsPbf(clipped: Clipped): { bytes: Uint8Array; stats: PbfWriteStats } {
  const t0 = performance.now();
  const { nodeIds, nodeLat, nodeLon, nodeTags, nodeIndex } = clipped;
  const nodeCount = nodeIds.length;

  const order = new Uint32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) order[i] = i;
  // Typed-array sort with a comparator over a parallel Float64Array. 2M entries, about a second.
  const orderArr = Array.from(order);
  orderArr.sort((a, b) => (nodeIds[a] as number) - (nodeIds[b] as number));

  const chunks: Uint8Array[] = [];
  let minLatScaled = Number.POSITIVE_INFINITY;
  let maxLatScaled = Number.NEGATIVE_INFINITY;
  let minLonScaled = Number.POSITIVE_INFINITY;
  let maxLonScaled = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < nodeCount; i++) {
    const la = nodeLat[i] as number;
    const lo = nodeLon[i] as number;
    if (la < minLatScaled) minLatScaled = la;
    if (la > maxLatScaled) maxLatScaled = la;
    if (lo < minLonScaled) minLonScaled = lo;
    if (lo > maxLonScaled) maxLonScaled = lo;
  }
  chunks.push(
    framedBlob('OSMHeader', headerBlock({ minLatScaled, maxLatScaled, minLonScaled, maxLonScaled })),
  );

  let blocks = 1;

  // ---- Node blocks (DenseNodes) ----
  for (let start = 0; start < nodeCount; start += BLOCK_SIZE) {
    const end = Math.min(start + BLOCK_SIZE, nodeCount);
    const st = new BlockStrings();
    const ids: number[] = [];
    const lats: number[] = [];
    const lons: number[] = [];
    const keysVals: number[] = [];
    let prevId = 0;
    let prevLat = 0;
    let prevLon = 0;

    for (let k = start; k < end; k++) {
      const i = orderArr[k] as number;
      const id = nodeIds[i] as number;
      const la = nodeLat[i] as number;
      const lo = nodeLon[i] as number;
      ids.push(id - prevId);
      lats.push(la - prevLat);
      lons.push(lo - prevLon);
      prevId = id;
      prevLat = la;
      prevLon = lo;

      const tags = nodeTags.get(id);
      if (tags) {
        for (const [key, value] of tags) keysVals.push(st.of(key), st.of(value));
      }
      // keys_vals is ONE flat run for the whole block, 0-terminated per node. The terminator is
      // required even for an untagged node, or every later node's tags land on the wrong node.
      keysVals.push(0);
    }

    const dense = new ByteWriter(1 << 16);
    packedSVarint(dense, 1, ids);
    packedSVarint(dense, 8, lats);
    packedSVarint(dense, 9, lons);
    packedVarint(dense, 10, keysVals);

    const group = new ByteWriter(1 << 16);
    submessage(group, 2, dense);

    chunks.push(framedBlob('OSMData', primitiveBlock(st, group)));
    blocks++;
  }

  // ---- Way blocks ----
  const ways = [...clipped.ways].sort((a, b) => a.id - b.id);
  const present = new IdSet(Math.max(1024, nodeCount));
  for (let i = 0; i < nodeCount; i++) present.add(nodeIds[i] as number);
  let danglingRefsDropped = 0;
  let waysDroppedTooShort = 0;
  let waysWritten = 0;

  for (let start = 0; start < ways.length; start += BLOCK_SIZE) {
    const end = Math.min(start + BLOCK_SIZE, ways.length);
    const st = new BlockStrings();
    const group = new ByteWriter(1 << 18);
    let wroteAny = false;

    for (let k = start; k < end; k++) {
      const way = ways[k] as (typeof ways)[number];
      // Drop refs the clip does not hold. Emitting them would produce an invalid file that
      // needs --skip-integrity, and a reader would then draw a road to nowhere.
      const refs: number[] = [];
      for (const r of way.refs) {
        if (nodeIndex.get(r) < 0) {
          danglingRefsDropped++;
          continue;
        }
        refs.push(r);
      }
      if (refs.length < 2) {
        waysDroppedTooShort++;
        continue;
      }

      const body = new ByteWriter(1 << 12);
      tag(body, 1, VARINT);
      body.varint(way.id);
      const keys: number[] = [];
      const vals: number[] = [];
      for (const [key, value] of way.tags) {
        keys.push(st.of(key));
        vals.push(st.of(value));
      }
      packedVarint(body, 2, keys);
      packedVarint(body, 3, vals);
      const deltas: number[] = [];
      let prev = 0;
      for (const r of refs) {
        deltas.push(r - prev);
        prev = r;
      }
      packedSVarint(body, 8, deltas);

      submessage(group, 3, body);
      wroteAny = true;
      waysWritten++;
    }

    if (wroteAny) {
      chunks.push(framedBlob('OSMData', primitiveBlock(st, group)));
      blocks++;
    }
  }

  // ---- Relation blocks ----
  const MEMBER_CODE = { node: 0, way: 1, relation: 2 } as const;
  const relations = [...clipped.relations].sort((a, b) => a.id - b.id);
  for (let start = 0; start < relations.length; start += BLOCK_SIZE) {
    const end = Math.min(start + BLOCK_SIZE, relations.length);
    const st = new BlockStrings();
    const group = new ByteWriter(1 << 18);

    for (let k = start; k < end; k++) {
      const rel = relations[k] as (typeof relations)[number];
      const body = new ByteWriter(1 << 12);
      tag(body, 1, VARINT);
      body.varint(rel.id);
      const keys: number[] = [];
      const vals: number[] = [];
      for (const [key, value] of rel.tags) {
        keys.push(st.of(key));
        vals.push(st.of(value));
      }
      packedVarint(body, 2, keys);
      packedVarint(body, 3, vals);

      const roles: number[] = [];
      const memDeltas: number[] = [];
      const types: number[] = [];
      let prev = 0;
      for (const m of rel.members) {
        roles.push(st.of(m.role));
        memDeltas.push(m.ref - prev);
        prev = m.ref;
        types.push(MEMBER_CODE[m.type]);
      }
      packedVarint(body, 8, roles);
      packedSVarint(body, 9, memDeltas);
      packedVarint(body, 10, types);

      submessage(group, 4, body);
    }

    if (end > start) {
      chunks.push(framedBlob('OSMData', primitiveBlock(st, group)));
      blocks++;
    }
  }

  let total = 0;
  for (const c of chunks) total += c.length;
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }

  return {
    bytes,
    stats: {
      bytes: total,
      nodes: nodeCount,
      ways: waysWritten,
      relations: relations.length,
      blocks,
      danglingRefsDropped,
      waysDroppedTooShort,
      seconds: Number(((performance.now() - t0) / 1000).toFixed(1)),
    },
  };
}

function primitiveBlock(st: BlockStrings, group: ByteWriter): Uint8Array {
  const block = new ByteWriter(1 << 18);
  submessage(block, 1, st.write());
  submessage(block, 2, group);
  tag(block, 17, VARINT);
  block.varint(GRANULARITY);
  // lat_offset and lon_offset are left at their default of 0, so they are not written.
  return Uint8Array.prototype.slice.call(block.view());
}
