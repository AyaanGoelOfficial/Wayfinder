/**
 * Packs a directory of `{z}/{x}/{y}.pbf` tiles into a single PMTiles v3 archive.
 *
 * WHY WE WRITE THIS OURSELVES: tilemaker v3 can emit `.pmtiles` directly, but its v3.0.0
 * Windows binary crashes on this machine before it reads a single byte of input, on ANY input
 * including a pristine Geofabrik extract and its own bundled config. v3.1.0 publishes no release
 * assets at all. v2.4.0 runs correctly but predates PMTiles and can only write `.mbtiles` or a
 * directory of tiles. A directory avoids SQLite entirely, so packing it ourselves is the
 * shortest correct path and keeps the whole tile strategy (one archive, HTTP 206 byte ranges)
 * intact. See packages/pipeline/tiles/CLAUDE.md for the full evidence.
 *
 * `zxyToTileId` comes from the `pmtiles` package rather than being reimplemented. It is the
 * Hilbert curve ordering the CLIENT'S reader uses to find a tile, and a writer that disagrees
 * with it by one curve orientation produces an archive that looks valid and serves the wrong
 * tile for every request. Using the same function makes that class of bug impossible.
 *
 * Format, per https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md:
 *   [127-byte header][root directory][JSON metadata][leaf directories][tile data]
 *
 * SINGLE ROOT DIRECTORY, NO LEAVES. The spec allows leaf directories so a client can fetch a
 * small root over one range request, and the convention is a root under about 16 KB. This
 * archive covers one district: a few thousand tiles, whose whole directory compresses to tens
 * of KB. Fetching that once beats the complexity of a two-level index for no measurable gain on
 * a local server. If the area ever grows enough for the root to get large, leaves are the fix,
 * not a smaller BUILD_AREA.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { zxyToTileId } from 'pmtiles';

/** PMTiles v3 enum values, matching the `pmtiles` reader's Compression and TileType. */
const COMPRESSION_NONE = 1;
const COMPRESSION_GZIP = 2;
const TILETYPE_MVT = 1;
const HEADER_SIZE = 127;

export interface PmtilesStats {
  readonly tilesFound: number;
  readonly uniqueTiles: number;
  readonly duplicateTilesShared: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly rootDirectoryBytes: number;
  readonly tileDataBytes: number;
  readonly totalBytes: number;
  readonly seconds: number;
}

interface TileEntry {
  readonly tileId: number;
  offset: number;
  length: number;
}

/** Writes a little-endian unsigned 64-bit value. Node's DataView needs a BigInt for this. */
function setU64(view: DataView, offset: number, value: number): void {
  view.setBigUint64(offset, BigInt(value), true);
}

/** Growable varint writer for directory serialization. */
class Varints {
  private buf: number[] = [];
  push(v: number): void {
    let x = v;
    while (x >= 128) {
      this.buf.push((x % 128) + 128);
      x = Math.floor(x / 128);
    }
    this.buf.push(x);
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

/**
 * Directory serialization, per the v3 spec: entry count, then four parallel varint runs.
 *
 * Offsets use the spec's shorthand: 0 means "immediately after the previous entry", which is
 * what makes a clustered archive's directory small. Anything else is `offset + 1`.
 */
function serializeDirectory(entries: readonly TileEntry[]): Uint8Array {
  const v = new Varints();
  v.push(entries.length);

  let prevId = 0;
  for (const e of entries) {
    v.push(e.tileId - prevId);
    prevId = e.tileId;
  }
  // Run length 1 for every entry. Run-length merging of consecutive identical tiles is a size
  // optimisation, not a correctness requirement, and skipping it keeps this readable.
  for (let i = 0; i < entries.length; i++) v.push(1);
  for (const e of entries) v.push(e.length);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as TileEntry;
    const prev = i > 0 ? (entries[i - 1] as TileEntry) : null;
    if (prev !== null && e.offset === prev.offset + prev.length) v.push(0);
    else v.push(e.offset + 1);
  }
  return v.bytes();
}

async function collectTiles(dir: string): Promise<Array<{ z: number; x: number; y: number; path: string }>> {
  const out: Array<{ z: number; x: number; y: number; path: string }> = [];
  for (const zEnt of await readdir(dir, { withFileTypes: true })) {
    if (!zEnt.isDirectory()) continue;
    const z = Number(zEnt.name);
    if (!Number.isInteger(z)) continue;
    const zDir = join(dir, zEnt.name);
    for (const xEnt of await readdir(zDir, { withFileTypes: true })) {
      if (!xEnt.isDirectory()) continue;
      const x = Number(xEnt.name);
      if (!Number.isInteger(x)) continue;
      const xDir = join(zDir, xEnt.name);
      for (const yEnt of await readdir(xDir, { withFileTypes: true })) {
        if (!yEnt.isFile() || !yEnt.name.endsWith('.pbf')) continue;
        const y = Number(yEnt.name.slice(0, -4));
        if (!Number.isInteger(y)) continue;
        out.push({ z, x, y, path: join(xDir, yEnt.name) });
      }
    }
  }
  return out;
}

export interface PackOptions {
  readonly tileDir: string;
  readonly outputPath: string;
  /** tilemaker's metadata.json, carrying vector_layers. MapLibre needs it to know the schema. */
  readonly metadata: Record<string, unknown>;
  readonly bounds: readonly [number, number, number, number];
  readonly center: readonly [number, number];
  readonly centerZoom: number;
  /** True when tilemaker already gzipped each tile, which its `compress: gzip` setting does. */
  readonly tilesAreGzipped: boolean;
}

export async function packPmtiles(opts: PackOptions): Promise<PmtilesStats> {
  const t0 = performance.now();
  const found = await collectTiles(opts.tileDir);
  if (found.length === 0) {
    throw new Error(`no .pbf tiles found under ${opts.tileDir}; tilemaker produced nothing`);
  }

  let minZoom = Infinity;
  let maxZoom = -Infinity;
  for (const t of found) {
    if (t.z < minZoom) minZoom = t.z;
    if (t.z > maxZoom) maxZoom = t.z;
  }

  // Sort by Hilbert tile id. The reader binary-searches the directory, so ascending order is a
  // correctness requirement, not a tidiness one.
  const withIds = found.map((t) => ({ ...t, tileId: zxyToTileId(t.z, t.x, t.y) }));
  withIds.sort((a, b) => a.tileId - b.tileId);

  const entries: TileEntry[] = [];
  const chunks: Uint8Array[] = [];
  // Identical tiles are extremely common (empty water, repeated countryside), and sharing one
  // copy is most of why a PMTiles archive is smaller than the directory it came from.
  const seen = new Map<string, { offset: number; length: number }>();
  let dataOffset = 0;
  let duplicateTilesShared = 0;

  for (const t of withIds) {
    const body = await readFile(t.path);
    const hash = createHash('sha256').update(body).digest('hex');
    const existing = seen.get(hash);
    if (existing !== undefined) {
      entries.push({ tileId: t.tileId, offset: existing.offset, length: existing.length });
      duplicateTilesShared++;
      continue;
    }
    const bytes = new Uint8Array(body);
    entries.push({ tileId: t.tileId, offset: dataOffset, length: bytes.length });
    seen.set(hash, { offset: dataOffset, length: bytes.length });
    chunks.push(bytes);
    dataOffset += bytes.length;
  }

  const rootDir = gzipSync(serializeDirectory(entries));
  const metadataJson = gzipSync(Buffer.from(JSON.stringify(opts.metadata), 'utf8'));

  const rootDirOffset = HEADER_SIZE;
  const metadataOffset = rootDirOffset + rootDir.length;
  const leafOffset = metadataOffset + metadataJson.length;
  const leafLength = 0;
  const tileDataOffset = leafOffset + leafLength;

  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer);
  header.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73], 0); // "PMTiles"
  header[7] = 3;
  setU64(view, 8, rootDirOffset);
  setU64(view, 16, rootDir.length);
  setU64(view, 24, metadataOffset);
  setU64(view, 32, metadataJson.length);
  setU64(view, 40, leafOffset);
  setU64(view, 48, leafLength);
  setU64(view, 56, tileDataOffset);
  setU64(view, 64, dataOffset);
  setU64(view, 72, entries.length); // addressed tiles
  setU64(view, 80, entries.length); // tile entries
  setU64(view, 88, seen.size); // distinct tile contents
  header[96] = 1; // clustered: tile data is written in tile id order
  header[97] = COMPRESSION_GZIP; // internal compression, for directories and metadata
  header[98] = opts.tilesAreGzipped ? COMPRESSION_GZIP : COMPRESSION_NONE;
  header[99] = TILETYPE_MVT;
  header[100] = minZoom;
  header[101] = maxZoom;
  view.setInt32(102, Math.round(opts.bounds[0] * 1e7), true);
  view.setInt32(106, Math.round(opts.bounds[1] * 1e7), true);
  view.setInt32(110, Math.round(opts.bounds[2] * 1e7), true);
  view.setInt32(114, Math.round(opts.bounds[3] * 1e7), true);
  header[118] = opts.centerZoom;
  view.setInt32(119, Math.round(opts.center[0] * 1e7), true);
  view.setInt32(123, Math.round(opts.center[1] * 1e7), true);

  const total = tileDataOffset + dataOffset;
  const out = Buffer.allocUnsafe(total);
  let at = 0;
  const put = (b: Uint8Array): void => {
    out.set(b, at);
    at += b.length;
  };
  put(header);
  put(rootDir);
  put(metadataJson);
  for (const c of chunks) put(c);
  if (at !== total) throw new Error(`archive assembly wrote ${at} bytes, expected ${total}`);

  await writeFile(opts.outputPath, out);

  return {
    tilesFound: found.length,
    uniqueTiles: seen.size,
    duplicateTilesShared,
    minZoom,
    maxZoom,
    rootDirectoryBytes: rootDir.length,
    tileDataBytes: dataOffset,
    totalBytes: total,
    seconds: Number(((performance.now() - t0) / 1000).toFixed(1)),
  };
}
