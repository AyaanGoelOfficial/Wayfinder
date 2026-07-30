/**
 * Decoder tested against ACTUAL bytes from a Geofabrik extract.
 *
 * Why this file exists, stated plainly: the 48 synthetic tests in protobuf.test.ts all
 * passed against a decoder that desynced on nearly every real parse. They could not catch
 * it, because the test encoder and the decoder shared one wrong assumption about how a
 * length-delimited field is skipped. Synthetic fixtures test BRANCHES. Real bytes test
 * ASSUMPTIONS. Both are needed and neither substitutes for the other.
 *
 * EVERY expected value below was produced by pyosmium 4.3.1 (libosmium) reading the SAME
 * fixture file, and none of it came from our own decoder. That is the whole point: a value
 * copied out of our output would only prove the decoder is self-consistent, which it was
 * while it was broken. Regenerate with the script in the session scratchpad, or any other
 * independent reader, if the fixture is ever re-sliced.
 *
 * The fixture is a valid tiny .osm.pbf: one real OSMHeader blob, the first real block of
 * dense nodes, the first real block of ways, and the first real block of relations, copied
 * verbatim out of northern-zone with their framing intact. Provenance, including source md5
 * and byte offsets, is in fixtures/real-slice.provenance.json.
 *
 * KNOWN GAP, stated rather than left implied: the sliced relation block happens to contain
 * zero `type=restriction` relations, so restriction TAG SEMANTICS are not covered by real
 * bytes here. The relation PARSE PATH is covered, by 8,000 real relations with 159,350
 * members and 34,991 tag pairs. Restrictions are not a different parse path, only a
 * different tag value, which is why this gap is acceptable rather than urgent.
 */
import { describe, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readOsmPbf, readOsmPbfHeader } from '../../packages/pipeline/pbf/osmpbf.ts';
import type { OsmNode, OsmRelation, OsmWay } from '../../packages/pipeline/pbf/osmpbf.ts';

const FIXTURE = resolve(import.meta.dirname, 'fixtures/real-slice.osm.pbf');

/**
 * Independent expected values. Source: pyosmium 4.3.1 / libosmium, reading FIXTURE.
 * Do not update any number here from our decoder's output. Re-run the oracle instead.
 */
const OSMIUM = {
  headerBbox: { minLat: 23.046881, maxLat: 36.137884, minLon: 69.169911, maxLon: 80.167546 },
  nodes: { count: 8000, idSum: 1611180876799, tagged: 2217, tagPairs: 5054 },
  ways: { count: 8000, idSum: 257975670192, refTotal: 243358, tagPairs: 21131, highway: 5871 },
  relations: { count: 8000, idSum: 41296221713, memberTotal: 159350, tagPairs: 34991, restriction: 0 },
  nodeBounds: { minLat: 23.123522, maxLat: 35.6957555, minLon: 70.04279, maxLon: 79.7942897 },
  firstNode: { id: 16173236, lat: 28.6138954, lon: 77.2090057, tagCount: 164 },
  lastNode: { id: 251014367, lat: 33.6725, lon: 79.62875, tags: { created_by: 'JOSM' } },
  firstWay: {
    id: 5822857,
    refCount: 9,
    firstRefs: [46547686, 247065302, 247176135, 247065303, 247176136],
    lastRef: 46547686,
    tags: { amenity: 'school', name: 'Nankana Sahib Public School' },
  },
  lastWay: {
    id: 44631755,
    refCount: 2,
    firstRefs: [566572976, 566572977],
    lastRef: 566572977,
    tags: { bridge: 'yes', highway: 'tertiary', layer: '1', source: 'Yahoo hires' },
  },
  firstRelation: {
    id: 36288,
    memberCount: 11,
    firstMembers: [
      { type: 'way', ref: 969787425, role: 'inner' },
      { type: 'way', ref: 969783685, role: 'inner' },
      { type: 'way', ref: 969783684, role: 'inner' },
      { type: 'way', ref: 969783691, role: 'inner' },
    ],
  },
  lastRelation: {
    id: 8990212,
    memberCount: 1,
    firstMembers: [{ type: 'node', ref: 6073225483, role: '' }],
    tags: { public_transport: 'stop_area', 'public_transport:version': '2', type: 'public_transport' },
  },
} as const;

interface Decoded {
  nodes: OsmNode[];
  ways: OsmWay[];
  relations: OsmRelation[];
}

let cached: Decoded | null = null;
async function decodeFixture(): Promise<Decoded> {
  if (cached) return cached;
  const d: Decoded = { nodes: [], ways: [], relations: [] };
  for await (const el of readOsmPbf(FIXTURE)) {
    if (el.kind === 'node') d.nodes.push(el);
    else if (el.kind === 'way') d.ways.push(el);
    else d.relations.push(el);
  }
  cached = d;
  return d;
}

describe('real bytes: fixture integrity', () => {
  it('is present, and small enough that it is a fixture rather than a committed extract', async () => {
    const s = await stat(FIXTURE);
    expect(s.size).toBeGreaterThan(100_000);
    // Guard, not a preference. hard-rules.md bans committing an extract; a careless
    // re-slice must not be able to smuggle one in behind the gitignore exception.
    expect(s.size).toBeLessThan(2_000_000);
  });

  it('starts with a big-endian BlobHeader length, so it really is PBF framing', async () => {
    const buf = await readFile(FIXTURE);
    const headerLen = buf.readUInt32BE(0);
    // Hand-decoded from the file, independent of the decoder: a BlobHeader is tens of bytes,
    // never megabytes. Reading this length little-endian would yield an absurd number, which
    // is the classic way this format is got wrong.
    expect(headerLen).toBeGreaterThan(8);
    expect(headerLen).toBeLessThan(1000);
    expect(buf.readUInt32LE(0)).toBeGreaterThan(1_000_000);
  });
});

describe('real bytes: OSMHeader stage', () => {
  it('decodes the declared bbox to the values libosmium reports', async () => {
    const h = await readOsmPbfHeader(FIXTURE);
    expect(h.bbox).toBeDefined();
    expect(h.bbox?.minLat).toBeCloseTo(OSMIUM.headerBbox.minLat, 6);
    expect(h.bbox?.maxLat).toBeCloseTo(OSMIUM.headerBbox.maxLat, 6);
    expect(h.bbox?.minLon).toBeCloseTo(OSMIUM.headerBbox.minLon, 6);
    expect(h.bbox?.maxLon).toBeCloseTo(OSMIUM.headerBbox.maxLon, 6);
  });

  it('reports the required features the real file declares', async () => {
    const h = await readOsmPbfHeader(FIXTURE);
    expect(h.features).toContain('OsmSchema-V0.6');
    expect(h.features).toContain('DenseNodes');
  });
});

describe('real bytes: blob framing and inflate', () => {
  it('yields every element in all four blobs, with none lost to a cursor desync', async () => {
    const d = await decodeFixture();
    // The desync bug did not throw. It silently produced fewer, or corrupted, elements.
    // An exact total across three block types is what makes that detectable.
    expect(d.nodes.length).toBe(OSMIUM.nodes.count);
    expect(d.ways.length).toBe(OSMIUM.ways.count);
    expect(d.relations.length).toBe(OSMIUM.relations.count);
  });
});

describe('real bytes: DenseNodes stage', () => {
  it('matches libosmium on count, id sum, tag counts and bounds', async () => {
    const { nodes } = await decodeFixture();
    let idSum = 0;
    let tagged = 0;
    let tagPairs = 0;
    let minLat = 91;
    let maxLat = -91;
    let minLon = 181;
    let maxLon = -181;
    for (const n of nodes) {
      idSum += n.id;
      if (n.tags.size > 0) tagged++;
      tagPairs += n.tags.size;
      if (n.lat < minLat) minLat = n.lat;
      if (n.lat > maxLat) maxLat = n.lat;
      if (n.lon < minLon) minLon = n.lon;
      if (n.lon > maxLon) maxLon = n.lon;
    }
    // An id sum past 2^31 is the assertion that catches shift-based varint decoding, which
    // wraps silently. 1.6e12 is well past it.
    expect(idSum).toBe(OSMIUM.nodes.idSum);
    expect(tagged).toBe(OSMIUM.nodes.tagged);
    expect(tagPairs).toBe(OSMIUM.nodes.tagPairs);
    expect(minLat).toBeCloseTo(OSMIUM.nodeBounds.minLat, 6);
    expect(maxLat).toBeCloseTo(OSMIUM.nodeBounds.maxLat, 6);
    expect(minLon).toBeCloseTo(OSMIUM.nodeBounds.minLon, 6);
    expect(maxLon).toBeCloseTo(OSMIUM.nodeBounds.maxLon, 6);
  });

  it('places the first node exactly where libosmium places it', async () => {
    const { nodes } = await decodeFixture();
    const n = nodes[0];
    expect(n).toBeDefined();
    expect(n?.id).toBe(OSMIUM.firstNode.id);
    // Granularity and lat/lon offsets are read per block. Hardcoding 1e-7 would still pass
    // on this file, so this assertion proves placement, not the granularity handling; the
    // granularity path is covered synthetically in protobuf.test.ts.
    expect(n?.lat).toBeCloseTo(OSMIUM.firstNode.lat, 6);
    expect(n?.lon).toBeCloseTo(OSMIUM.firstNode.lon, 6);
    expect(n?.tags.size).toBe(OSMIUM.firstNode.tagCount);
  });

  it('decodes multi-script tag values byte for byte', async () => {
    const { nodes } = await decodeFixture();
    const tags = nodes[0]?.tags;
    expect(tags?.get('name')).toBe('New Delhi');
    // Devanagari and Arabic script from a real string table. Root CLAUDE.md records that the
    // Windows default text codec mangles this, and it has already bitten once. A mangled
    // decode yields replacement characters or mojibake, both of which fail here.
    expect(tags?.get('name:hi')).toBe('नई दिल्ली');
    expect(tags?.get('name:ur')).toBe('نئی دہلی');
    expect(tags?.get('capital')).toBe('yes');
  });

  it('keeps keys_vals aligned to the end of the block', async () => {
    const { nodes } = await decodeFixture();
    const last = nodes[nodes.length - 1];
    // keys_vals is ONE flat 0-terminated run for the whole block. Losing the cursor shifts
    // every later node's tags onto the wrong node, and the damage is worst at the end.
    expect(last?.id).toBe(OSMIUM.lastNode.id);
    expect(last?.lat).toBeCloseTo(OSMIUM.lastNode.lat, 6);
    expect(last?.lon).toBeCloseTo(OSMIUM.lastNode.lon, 6);
    expect(Object.fromEntries(last?.tags ?? [])).toEqual(OSMIUM.lastNode.tags);
  });
});

describe('real bytes: Way stage', () => {
  it('matches libosmium on count, id sum, ref total and tag counts', async () => {
    const { ways } = await decodeFixture();
    let idSum = 0;
    let refTotal = 0;
    let tagPairs = 0;
    let highway = 0;
    for (const w of ways) {
      idSum += w.id;
      refTotal += w.refs.length;
      tagPairs += w.tags.size;
      if (w.tags.has('highway')) highway++;
    }
    expect(idSum).toBe(OSMIUM.ways.idSum);
    expect(refTotal).toBe(OSMIUM.ways.refTotal);
    expect(tagPairs).toBe(OSMIUM.ways.tagPairs);
    expect(highway).toBe(OSMIUM.ways.highway);
  });

  it('delta-decodes real node refs, including a closed way', async () => {
    const { ways } = await decodeFixture();
    const w = ways[0];
    expect(w?.id).toBe(OSMIUM.firstWay.id);
    expect(w?.refs.length).toBe(OSMIUM.firstWay.refCount);
    // Refs are delta+zigzag encoded and run to ~1e9 here, so a wrong sign or a 32-bit wrap
    // shows up immediately. The last ref equalling the first is a closed way, which is also
    // the shape a broken delta chain is least likely to reproduce by accident.
    expect(w?.refs.slice(0, 5)).toEqual(OSMIUM.firstWay.firstRefs);
    expect(w?.refs[w.refs.length - 1]).toBe(OSMIUM.firstWay.lastRef);
    expect(Object.fromEntries(w?.tags ?? [])).toEqual(OSMIUM.firstWay.tags);
  });

  it('is still aligned on the last way in the block', async () => {
    const { ways } = await decodeFixture();
    const w = ways[ways.length - 1];
    expect(w?.id).toBe(OSMIUM.lastWay.id);
    expect(w?.refs).toEqual(OSMIUM.lastWay.firstRefs);
    expect(Object.fromEntries(w?.tags ?? [])).toEqual(OSMIUM.lastWay.tags);
  });
});

describe('real bytes: Relation stage', () => {
  it('matches libosmium on count, id sum, member total and tag counts', async () => {
    const { relations } = await decodeFixture();
    let idSum = 0;
    let memberTotal = 0;
    let tagPairs = 0;
    let restriction = 0;
    for (const r of relations) {
      idSum += r.id;
      memberTotal += r.members.length;
      tagPairs += r.tags.size;
      if (r.tags.get('type') === 'restriction') restriction++;
    }
    expect(idSum).toBe(OSMIUM.relations.idSum);
    expect(memberTotal).toBe(OSMIUM.relations.memberTotal);
    expect(tagPairs).toBe(OSMIUM.relations.tagPairs);
    // Documents the known gap above rather than hiding it. If a re-slice changes this, the
    // comment at the top of the file is stale and must be updated with it.
    expect(restriction).toBe(OSMIUM.relations.restriction);
  });

  it('decodes member types, refs and roles from the real role string table', async () => {
    const { relations } = await decodeFixture();
    const r = relations[0];
    expect(r?.id).toBe(OSMIUM.firstRelation.id);
    expect(r?.members.length).toBe(OSMIUM.firstRelation.memberCount);
    // Three parallel packed arrays: roles_sid, memids (delta), types. A misread of any one
    // of them still yields plausible-looking members, which is why type, ref and role are
    // all asserted together.
    expect(r?.members.slice(0, 4)).toEqual(OSMIUM.firstRelation.firstMembers);
  });

  it('is still aligned on the last relation in the block', async () => {
    const { relations } = await decodeFixture();
    const r = relations[relations.length - 1];
    expect(r?.id).toBe(OSMIUM.lastRelation.id);
    expect(r?.members).toEqual(OSMIUM.lastRelation.firstMembers);
    expect(Object.fromEntries(r?.tags ?? [])).toEqual(OSMIUM.lastRelation.tags);
  });
});
