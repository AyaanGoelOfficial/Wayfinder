/**
 * Streaming OSM PBF decoder. Reads the file as a sequence of length-prefixed blobs, inflates
 * each one, and yields decoded elements without ever holding the whole file in memory.
 *
 * File layout, per https://wiki.openstreetmap.org/wiki/PBF_Format:
 *   [4-byte BE length of BlobHeader][BlobHeader][Blob]  repeated
 *   BlobHeader { 1: string type, 3: int32 datasize }   type is "OSMHeader" or "OSMData"
 *   Blob       { 1: bytes raw, 2: int32 raw_size, 3: bytes zlib_data, 6: bytes zstd_data }
 *   OSMData inflates to a PrimitiveBlock.
 *
 * Coordinates: lat = 1e-9 * (lat_offset + granularity * delta). Granularity defaults to 100,
 * offsets to 0, and both are per-block. Hardcoding 1e-7 works for most files and silently
 * misplaces everything in the ones that set a granularity, so the block values are read.
 */
import { createReadStream } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { Reader, WireType, readPackedVarint, readPackedSVarint } from './protobuf.ts';

export interface OsmNode {
  readonly kind: 'node';
  readonly id: number;
  readonly lat: number;
  readonly lon: number;
  readonly tags: ReadonlyMap<string, string>;
}

export interface OsmWay {
  readonly kind: 'way';
  readonly id: number;
  readonly refs: readonly number[];
  readonly tags: ReadonlyMap<string, string>;
}

export type MemberType = 'node' | 'way' | 'relation';

export interface OsmRelationMember {
  readonly type: MemberType;
  readonly ref: number;
  readonly role: string;
}

export interface OsmRelation {
  readonly kind: 'relation';
  readonly id: number;
  readonly members: readonly OsmRelationMember[];
  readonly tags: ReadonlyMap<string, string>;
}

export type OsmElement = OsmNode | OsmWay | OsmRelation;

const EMPTY_TAGS: ReadonlyMap<string, string> = new Map();

/** Reads the whole file as a stream of blobs, yielding each OSMData payload inflated. */
async function* readBlobs(path: string): AsyncGenerator<{ type: string; data: Uint8Array }> {
  const stream = createReadStream(path, { highWaterMark: 1 << 20 });
  let buf: Buffer = Buffer.alloc(0);

  for await (const chunk of stream) {
    const c = Buffer.from(chunk as Uint8Array);
    buf = buf.length === 0 ? c : Buffer.concat([buf, c]);

    for (;;) {
      if (buf.length < 4) break;
      const headerLen = buf.readUInt32BE(0);
      if (headerLen > 64 * 1024) {
        throw new Error(`implausible BlobHeader length ${headerLen}; file is not an OSM PBF`);
      }
      if (buf.length < 4 + headerLen) break;

      // BlobHeader
      const hr = new Reader(buf.subarray(4, 4 + headerLen));
      let type = '';
      let datasize = 0;
      while (hr.hasMore) {
        const { field, wire } = hr.readTag();
        if (field === 1 && wire === WireType.Bytes) type = hr.readString();
        else if (field === 3 && wire === WireType.Varint) datasize = hr.readVarint();
        else hr.skip(wire);
      }

      const total = 4 + headerLen + datasize;
      if (buf.length < total) break;

      // Blob
      const br = new Reader(buf.subarray(4 + headerLen, total));
      let raw: Uint8Array | null = null;
      let zlibData: Uint8Array | null = null;
      while (br.hasMore) {
        const { field, wire } = br.readTag();
        if (field === 1 && wire === WireType.Bytes) raw = br.readBytes();
        else if (field === 3 && wire === WireType.Bytes) zlibData = br.readBytes();
        else if (field === 4 || field === 5 || field === 6) {
          const enc = field === 4 ? 'lzma' : field === 5 ? 'bzip2' : 'zstd';
          throw new Error(
            `blob uses ${enc} compression, which this decoder does not support. ` +
              `Geofabrik publishes zlib; re-download the extract.`,
          );
        } else br.skip(wire);
      }

      const data = raw ?? (zlibData ? inflateSync(zlibData) : null);
      if (!data) throw new Error('blob carried neither raw nor zlib data');
      yield { type, data };

      buf = buf.subarray(total);
    }
  }
}

function decodeStringTable(r: Reader): string[] {
  const out: string[] = [];
  const dec = new TextDecoder('utf-8');
  while (r.hasMore) {
    const { field, wire } = r.readTag();
    if (field === 1 && wire === WireType.Bytes) out.push(dec.decode(r.readBytes()));
    else r.skip(wire);
  }
  return out;
}

function tagsFrom(keys: readonly number[], vals: readonly number[], st: readonly string[]): ReadonlyMap<string, string> {
  if (keys.length === 0) return EMPTY_TAGS;
  const m = new Map<string, string>();
  for (let i = 0; i < keys.length; i++) {
    const k = st[keys[i] as number];
    const v = st[vals[i] as number];
    if (k !== undefined && v !== undefined) m.set(k, v);
  }
  return m;
}

interface BlockMeta {
  readonly granularity: number;
  readonly latOffset: number;
  readonly lonOffset: number;
  readonly stringTable: readonly string[];
}

function* decodeDense(r: Reader, meta: BlockMeta): Generator<OsmNode> {
  const ids: number[] = [];
  const lats: number[] = [];
  const lons: number[] = [];
  const keysVals: number[] = [];

  while (r.hasMore) {
    const { field, wire } = r.readTag();
    if (field === 1 && wire === WireType.Bytes) readPackedSVarint(r, ids);
    else if (field === 8 && wire === WireType.Bytes) readPackedSVarint(r, lats);
    else if (field === 9 && wire === WireType.Bytes) readPackedSVarint(r, lons);
    else if (field === 10 && wire === WireType.Bytes) readPackedVarint(r, keysVals);
    else r.skip(wire);
  }

  const { granularity, latOffset, lonOffset, stringTable } = meta;
  let id = 0;
  let lat = 0;
  let lon = 0;
  let kv = 0;

  for (let i = 0; i < ids.length; i++) {
    id += ids[i] as number;
    lat += lats[i] as number;
    lon += lons[i] as number;

    // keys_vals is a flat, 0-terminated run per node. An absent array means no tags at all.
    let tags: ReadonlyMap<string, string> = EMPTY_TAGS;
    if (keysVals.length > 0) {
      const m = new Map<string, string>();
      while (kv < keysVals.length && keysVals[kv] !== 0) {
        const k = stringTable[keysVals[kv] as number];
        const v = stringTable[keysVals[kv + 1] as number];
        if (k !== undefined && v !== undefined) m.set(k, v);
        kv += 2;
      }
      kv++; // step over the 0 terminator
      if (m.size > 0) tags = m;
    }

    yield {
      kind: 'node',
      id,
      lat: 1e-9 * (latOffset + granularity * lat),
      lon: 1e-9 * (lonOffset + granularity * lon),
      tags,
    };
  }
}

function decodeNode(r: Reader, meta: BlockMeta): OsmNode {
  let id = 0;
  let lat = 0;
  let lon = 0;
  const keys: number[] = [];
  const vals: number[] = [];
  while (r.hasMore) {
    const { field, wire } = r.readTag();
    if (field === 1 && wire === WireType.Varint) id = r.readSVarint();
    else if (field === 2 && wire === WireType.Bytes) readPackedVarint(r, keys);
    else if (field === 3 && wire === WireType.Bytes) readPackedVarint(r, vals);
    else if (field === 8 && wire === WireType.Varint) lat = r.readSVarint();
    else if (field === 9 && wire === WireType.Varint) lon = r.readSVarint();
    else r.skip(wire);
  }
  return {
    kind: 'node',
    id,
    lat: 1e-9 * (meta.latOffset + meta.granularity * lat),
    lon: 1e-9 * (meta.lonOffset + meta.granularity * lon),
    tags: tagsFrom(keys, vals, meta.stringTable),
  };
}

function decodeWay(r: Reader, meta: BlockMeta): OsmWay {
  let id = 0;
  const keys: number[] = [];
  const vals: number[] = [];
  const deltas: number[] = [];
  while (r.hasMore) {
    const { field, wire } = r.readTag();
    if (field === 1 && wire === WireType.Varint) id = r.readVarint();
    else if (field === 2 && wire === WireType.Bytes) readPackedVarint(r, keys);
    else if (field === 3 && wire === WireType.Bytes) readPackedVarint(r, vals);
    else if (field === 8 && wire === WireType.Bytes) readPackedSVarint(r, deltas);
    else r.skip(wire);
  }
  const refs: number[] = new Array(deltas.length);
  let ref = 0;
  for (let i = 0; i < deltas.length; i++) {
    ref += deltas[i] as number;
    refs[i] = ref;
  }
  return { kind: 'way', id, refs, tags: tagsFrom(keys, vals, meta.stringTable) };
}

const MEMBER_TYPES: readonly MemberType[] = ['node', 'way', 'relation'];

function decodeRelation(r: Reader, meta: BlockMeta): OsmRelation {
  let id = 0;
  const keys: number[] = [];
  const vals: number[] = [];
  const roleSids: number[] = [];
  const memDeltas: number[] = [];
  const types: number[] = [];
  while (r.hasMore) {
    const { field, wire } = r.readTag();
    if (field === 1 && wire === WireType.Varint) id = r.readVarint();
    else if (field === 2 && wire === WireType.Bytes) readPackedVarint(r, keys);
    else if (field === 3 && wire === WireType.Bytes) readPackedVarint(r, vals);
    else if (field === 8 && wire === WireType.Bytes) readPackedVarint(r, roleSids);
    else if (field === 9 && wire === WireType.Bytes) readPackedSVarint(r, memDeltas);
    else if (field === 10 && wire === WireType.Bytes) readPackedVarint(r, types);
    else r.skip(wire);
  }
  const members: OsmRelationMember[] = new Array(memDeltas.length);
  let ref = 0;
  for (let i = 0; i < memDeltas.length; i++) {
    ref += memDeltas[i] as number;
    members[i] = {
      type: MEMBER_TYPES[types[i] as number] ?? 'node',
      ref,
      role: meta.stringTable[roleSids[i] as number] ?? '',
    };
  }
  return { kind: 'relation', id, members, tags: tagsFrom(keys, vals, meta.stringTable) };
}

function* decodePrimitiveBlock(data: Uint8Array): Generator<OsmElement> {
  const r = new Reader(data);
  let stringTable: string[] = [];
  let granularity = 100;
  let latOffset = 0;
  let lonOffset = 0;
  const groups: Uint8Array[] = [];

  while (r.hasMore) {
    const { field, wire } = r.readTag();
    if (field === 1 && wire === WireType.Bytes) stringTable = decodeStringTable(r.readMessage());
    else if (field === 2 && wire === WireType.Bytes) groups.push(r.readBytes());
    else if (field === 17 && wire === WireType.Varint) granularity = r.readVarint();
    else if (field === 19 && wire === WireType.Varint) latOffset = r.readSVarint();
    else if (field === 20 && wire === WireType.Varint) lonOffset = r.readSVarint();
    else r.skip(wire);
  }

  const meta: BlockMeta = { granularity, latOffset, lonOffset, stringTable };

  for (const g of groups) {
    const gr = new Reader(g);
    while (gr.hasMore) {
      const { field, wire } = gr.readTag();
      if (wire !== WireType.Bytes) {
        gr.skip(wire);
        continue;
      }
      if (field === 1) yield decodeNode(gr.readMessage(), meta);
      else if (field === 2) yield* decodeDense(gr.readMessage(), meta);
      else if (field === 3) yield decodeWay(gr.readMessage(), meta);
      else if (field === 4) yield decodeRelation(gr.readMessage(), meta);
      else gr.skip(wire);
    }
  }
}

/** Yields every element in the file, in file order. Nodes precede ways precede relations. */
export async function* readOsmPbf(path: string): AsyncGenerator<OsmElement> {
  for await (const blob of readBlobs(path)) {
    if (blob.type !== 'OSMData') continue;
    yield* decodePrimitiveBlock(blob.data);
  }
}

/** Reads only the OSMHeader blob and returns its declared bbox and required features. */
export async function readOsmPbfHeader(
  path: string,
): Promise<{ bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }; features: string[] }> {
  for await (const blob of readBlobs(path)) {
    if (blob.type !== 'OSMHeader') continue;
    const r = new Reader(blob.data);
    const features: string[] = [];
    let bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | undefined;
    while (r.hasMore) {
      const { field, wire } = r.readTag();
      if (field === 1 && wire === WireType.Bytes) {
        const b = r.readMessage();
        let left = 0;
        let right = 0;
        let top = 0;
        let bottom = 0;
        while (b.hasMore) {
          const t = b.readTag();
          if (t.field === 1) left = b.readSVarint();
          else if (t.field === 2) right = b.readSVarint();
          else if (t.field === 3) top = b.readSVarint();
          else if (t.field === 4) bottom = b.readSVarint();
          else b.skip(t.wire);
        }
        bbox = {
          minLon: left * 1e-9,
          maxLon: right * 1e-9,
          maxLat: top * 1e-9,
          minLat: bottom * 1e-9,
        };
      } else if ((field === 4 || field === 5) && wire === WireType.Bytes) {
        features.push(r.readString());
      } else r.skip(wire);
    }
    return bbox ? { bbox, features } : { features };
  }
  throw new Error(`${path} contains no OSMHeader blob`);
}
