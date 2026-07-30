/**
 * Cuts a tiny but REAL .osm.pbf out of a downloaded extract, for use as a committed test
 * fixture.
 *
 * Why this exists: the 48 synthetic protobuf tests all passed against a decoder that
 * desynced on nearly every real parse, because the fixtures and the decoder shared the same
 * assumption about how a length-delimited field is skipped. Synthetic fixtures test
 * BRANCHES. Only real bytes test ASSUMPTIONS.
 *
 * The output is a valid PBF, not a byte dump: one OSMHeader blob followed by the first
 * OSMData blob containing dense nodes, the first containing ways, and the first containing
 * relations, copied verbatim with their framing intact. Because it is valid, an independent
 * reader (pyosmium / libosmium) can be pointed at the SAME file to produce the expected
 * values, which is what makes the resulting test an independent check rather than a
 * round-trip against our own output.
 *
 * Blob framing only is parsed here (4-byte big-endian length, then BlobHeader for type and
 * datasize). Element decoding is deliberately shallow: just enough to see which
 * PrimitiveGroup field numbers a block carries.
 *
 *   npm run make:fixture            # defaults to northern-zone, the smaller extract
 */
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { resolve } from 'node:path';
import { Reader, WireType } from '../packages/pipeline/pbf/protobuf.ts';
import { readLock } from './fetch-extracts.ts';

const OUT_DIR = resolve(import.meta.dirname, '../tests/pipeline/fixtures');

/** PrimitiveGroup field numbers, per the OSM PBF schema. */
const GROUP_NODES = 1;
const GROUP_DENSE = 2;
const GROUP_WAYS = 3;
const GROUP_RELATIONS = 4;

interface FramedBlob {
  /** The complete on-disk bytes: length prefix, BlobHeader, Blob. Copied verbatim. */
  readonly framed: Uint8Array;
  readonly type: string;
  readonly offset: number;
  /** Which PrimitiveGroup field numbers this block contains. Empty for OSMHeader. */
  readonly groupFields: ReadonlySet<number>;
}

/** Which PrimitiveGroup field numbers a PrimitiveBlock carries, without decoding elements. */
function groupFieldsOf(data: Uint8Array): Set<number> {
  const found = new Set<number>();
  const r = new Reader(data);
  while (r.hasMore) {
    const { field, wire } = r.readTag();
    if (field === 2 && wire === WireType.Bytes) {
      const g = new Reader(r.readBytes());
      while (g.hasMore) {
        const t = g.readTag();
        found.add(t.field);
        g.skip(t.wire);
      }
    } else r.skip(wire);
  }
  return found;
}

async function* framedBlobs(path: string): AsyncGenerator<FramedBlob> {
  const stream = createReadStream(path, { highWaterMark: 1 << 20 });
  let buf: Buffer = Buffer.alloc(0);
  let consumed = 0;

  for await (const chunk of stream) {
    const c = Buffer.from(chunk as Uint8Array);
    buf = buf.length === 0 ? c : Buffer.concat([buf, c]);

    for (;;) {
      if (buf.length < 4) break;
      const headerLen = buf.readUInt32BE(0);
      if (buf.length < 4 + headerLen) break;

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

      let groupFields = new Set<number>();
      if (type === 'OSMData') {
        const br = new Reader(buf.subarray(4 + headerLen, total));
        let raw: Uint8Array | null = null;
        let zlibData: Uint8Array | null = null;
        while (br.hasMore) {
          const { field, wire } = br.readTag();
          if (field === 1 && wire === WireType.Bytes) raw = br.readBytes();
          else if (field === 3 && wire === WireType.Bytes) zlibData = br.readBytes();
          else br.skip(wire);
        }
        const data = raw ?? (zlibData ? inflateSync(zlibData) : null);
        if (data) groupFields = groupFieldsOf(data);
      }

      yield {
        framed: Uint8Array.prototype.slice.call(buf.subarray(0, total)),
        type,
        offset: consumed,
        groupFields,
      };

      consumed += total;
      buf = buf.subarray(total);
    }
  }
}

const which = process.argv[2] ?? 'northern-zone';
const lock = await readLock();
const extract = lock.extracts.find((e) => e.name === which);
if (!extract) {
  console.error(`unknown extract "${which}". Known: ${lock.extracts.map((e) => e.name).join(', ')}`);
  console.error('Run `npm run fetch:extracts` first if data/ is empty.');
  process.exit(1);
}

console.log(`slicing fixture out of ${extract.name} (${extract.md5})`);

let header: FramedBlob | null = null;
let denseBlob: FramedBlob | null = null;
let wayBlob: FramedBlob | null = null;
let relBlob: FramedBlob | null = null;
let scanned = 0;

for await (const b of framedBlobs(extract.localPath)) {
  scanned++;
  if (b.type === 'OSMHeader' && !header) {
    header = b;
    continue;
  }
  if (!denseBlob && (b.groupFields.has(GROUP_DENSE) || b.groupFields.has(GROUP_NODES))) denseBlob = b;
  if (!wayBlob && b.groupFields.has(GROUP_WAYS)) wayBlob = b;
  if (!relBlob && b.groupFields.has(GROUP_RELATIONS)) relBlob = b;
  if (header && denseBlob && wayBlob && relBlob) break;
  if (scanned % 2000 === 0) {
    console.log(
      `  scanned ${scanned.toLocaleString('en-US')} blobs  ` +
        `header=${header ? 'y' : 'n'} dense=${denseBlob ? 'y' : 'n'} ` +
        `ways=${wayBlob ? 'y' : 'n'} rels=${relBlob ? 'y' : 'n'}`,
    );
  }
}

const missing = [
  ['OSMHeader', header],
  ['dense nodes', denseBlob],
  ['ways', wayBlob],
  ['relations', relBlob],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length > 0) {
  console.error(`could not find a blob for: ${missing.join(', ')} after ${scanned} blobs`);
  process.exit(1);
}

const parts = [header, denseBlob, wayBlob, relBlob] as FramedBlob[];
const out = Buffer.concat(parts.map((p) => Buffer.from(p.framed)));

await mkdir(OUT_DIR, { recursive: true });
const pbfPath = resolve(OUT_DIR, 'real-slice.osm.pbf');
await writeFile(pbfPath, out);

const provenance = {
  note:
    'Verbatim blob slice of a real Geofabrik extract, kept as a test fixture. Regenerate ' +
    'with `npm run make:fixture`. Expected values for the test come from pyosmium reading ' +
    'THIS file, never from our own decoder.',
  sourceExtract: extract.name,
  sourceUrl: extract.sourceUrl,
  sourceMd5: extract.md5,
  sourceLastModified: extract.lastModified,
  slicedOn: new Date().toISOString().slice(0, 10),
  fixtureBytes: out.length,
  fixtureMd5: createHash('md5').update(out).digest('hex'),
  blobsScannedToFindThem: scanned,
  blobs: parts.map((p) => ({
    type: p.type,
    byteOffsetInSource: p.offset,
    framedBytes: p.framed.length,
    groupFields: [...p.groupFields].sort((a, b) => a - b),
  })),
};
await writeFile(resolve(OUT_DIR, 'real-slice.provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');

console.log(`\nwrote ${pbfPath}`);
console.log(`  ${out.length.toLocaleString('en-US')} bytes, md5 ${provenance.fixtureMd5}`);
for (const b of provenance.blobs) {
  console.log(
    `  ${b.type.padEnd(9)} offset ${b.byteOffsetInSource.toLocaleString('en-US').padStart(12)} ` +
      `${b.framedBytes.toLocaleString('en-US').padStart(8)} bytes  groups [${b.groupFields.join(',')}]`,
  );
}
