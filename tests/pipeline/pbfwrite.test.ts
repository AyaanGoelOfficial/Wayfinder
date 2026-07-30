/**
 * The PBF writer, round-tripped through our own decoder.
 *
 * This is the one place in the pipeline where we produce a file format rather than consume one,
 * and the consumer that matters is tilemaker, a separate C++ program. A writer verified only by
 * "tilemaker accepted it" is a writer with no test: tilemaker can accept a file whose
 * coordinates are all subtly wrong, and the result is a map that looks plausible and is not.
 *
 * So the writer is checked against the decoder, which is itself checked against libosmium on
 * real bytes in real-bytes.test.ts. That chain is what makes this meaningful rather than
 * circular: the decoder has an independent oracle, so agreeing with the decoder is evidence.
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClip } from '../../packages/pipeline/clip/clip.ts';
import { writeClipAsPbf } from '../../packages/pipeline/clip/pbfwrite.ts';
import type { ClipExtractInput, OpenExtract } from '../../packages/pipeline/clip/clip.ts';
import { readOsmPbf, readOsmPbfHeader } from '../../packages/pipeline/pbf/osmpbf.ts';
import type { OsmElement } from '../../packages/pipeline/pbf/osmpbf.ts';

const A: ClipExtractInput = { name: 'zone-a', localPath: '(injected)', md5: 'aaaa' };
const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function source(list: OsmElement[]): OpenExtract {
  return () =>
    (async function* () {
      for (const el of list) yield el;
    })();
}

async function roundTrip(els: OsmElement[]) {
  const { clipped } = await buildClip([A], () => {}, source(els));
  const { bytes, stats } = writeClipAsPbf(clipped);
  const dir = await mkdtemp(join(tmpdir(), 'wayfinder-pbf-'));
  dirs.push(dir);
  const path = join(dir, 'out.osm.pbf');
  await writeFile(path, bytes);

  const header = await readOsmPbfHeader(path);
  const nodes: OsmElement[] = [];
  const ways: OsmElement[] = [];
  const relations: OsmElement[] = [];
  for await (const el of readOsmPbf(path)) {
    if (el.kind === 'node') nodes.push(el);
    else if (el.kind === 'way') ways.push(el);
    else relations.push(el);
  }
  return { clipped, stats, header, nodes, ways, relations };
}

/** A small but realistic set: multi-script names, a reversed one-way, a restriction relation. */
const ELEMENTS: OsmElement[] = [
  { kind: 'node', id: 1_000_000_001, lat: 28.4712, lon: 77.5031, tags: new Map([['place', 'village'], ['name', 'कासना']]) },
  { kind: 'node', id: 1_000_000_002, lat: 28.4722, lon: 77.5041, tags: new Map() },
  { kind: 'node', id: 1_000_000_003, lat: 28.4732, lon: 77.5051, tags: new Map([['amenity', 'clinic'], ['name', 'Kasana Nursing Home']]) },
  { kind: 'node', id: 13_000_000_004, lat: 28.6054, lon: 77.4274, tags: new Map() },
  {
    kind: 'way',
    id: 900_000_001,
    refs: [1_000_000_001, 1_000_000_002, 1_000_000_003],
    tags: new Map([['highway', 'tertiary'], ['name', 'Old Kasana Road'], ['oneway', '-1']]),
  },
  {
    kind: 'way',
    id: 900_000_002,
    refs: [1_000_000_003, 13_000_000_004],
    tags: new Map([['highway', 'trunk'], ['name', 'Gaur City Link'], ['maxspeed', '60']]),
  },
  {
    kind: 'relation',
    id: 700_000_001,
    members: [
      { type: 'way', ref: 900_000_001, role: 'from' },
      { type: 'node', ref: 1_000_000_003, role: 'via' },
      { type: 'way', ref: 900_000_002, role: 'to' },
    ],
    tags: new Map([['type', 'restriction'], ['restriction', 'no_left_turn']]),
  },
];

describe('PBF writer', () => {
  it('produces a file our decoder reads back with identical counts', async () => {
    const { stats, nodes, ways, relations } = await roundTrip(ELEMENTS);
    expect(nodes.length).toBe(stats.nodes);
    expect(ways.length).toBe(stats.ways);
    expect(relations.length).toBe(stats.relations);
    expect(nodes.length).toBe(4);
    expect(ways.length).toBe(2);
    expect(relations.length).toBe(1);
  });

  it('declares a header the decoder understands, with a bbox around the data', async () => {
    const { header } = await roundTrip(ELEMENTS);
    // REQUIRED must contain only what the spec allows there. Declaring Sort.Type_then_ID as
    // required made libosmium refuse the file with "required feature not supported" and crashed
    // tilemaker with a stack-buffer fail-fast, because a conforming reader MUST reject a
    // required feature it does not implement.
    expect(header.requiredFeatures).toEqual(['OsmSchema-V0.6', 'DenseNodes']);
    // Sort order is genuinely true of the file, so it is declared, but as OPTIONAL.
    expect(header.optionalFeatures).toContain('Sort.Type_then_ID');
    expect(header.requiredFeatures).not.toContain('Sort.Type_then_ID');
    expect(header.bbox?.minLat).toBeCloseTo(28.4712, 5);
    expect(header.bbox?.maxLat).toBeCloseTo(28.6054, 5);
    expect(header.bbox?.minLon).toBeCloseTo(77.4274, 5);
    expect(header.bbox?.maxLon).toBeCloseTo(77.5051, 5);
  });

  it('preserves coordinates exactly, with no rounding on the way out', async () => {
    const { nodes } = await roundTrip(ELEMENTS);
    const byId = new Map(nodes.map((el) => [el.id, el]));
    const a = byId.get(1_000_000_001);
    expect(a?.kind).toBe('node');
    if (a?.kind !== 'node') throw new Error('expected a node');
    // Granularity 100 with zero offsets makes the stored delta exactly the 1e7-scaled integer
    // already held in the clip, so nothing is converted or re-derived. 1e-7 is OSM's own
    // precision, so this must be exact, not merely close.
    expect(Math.round(a.lat * 1e7)).toBe(284_712_000);
    expect(Math.round(a.lon * 1e7)).toBe(775_031_000);
  });

  it('preserves ids past 2^32, where a 32-bit path would wrap', async () => {
    const { nodes } = await roundTrip(ELEMENTS);
    expect(nodes.map((el) => el.id)).toContain(13_000_000_004);
  });

  it('writes nodes in ascending id order, as the declared sort promises', async () => {
    const { nodes } = await roundTrip(ELEMENTS);
    const ids = nodes.map((el) => el.id);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
  });

  it('preserves tags, including Devanagari and a reversed one-way', async () => {
    const { nodes, ways } = await roundTrip(ELEMENTS);
    const kasna = nodes.find((el) => el.tags.get('place') === 'village');
    expect(kasna?.tags.get('name')).toBe('कासना');
    const road = ways.find((el) => el.id === 900_000_001);
    expect(road?.tags.get('name')).toBe('Old Kasana Road');
    // A dropped or mangled oneway=-1 silently reverses a road, and the map still looks fine.
    expect(road?.tags.get('oneway')).toBe('-1');
    expect(road?.tags.get('highway')).toBe('tertiary');
  });

  it('preserves way refs and their order', async () => {
    const { ways } = await roundTrip(ELEMENTS);
    const road = ways.find((el) => el.id === 900_000_001);
    if (road?.kind !== 'way') throw new Error('expected a way');
    expect(road.refs).toEqual([1_000_000_001, 1_000_000_002, 1_000_000_003]);
  });

  it('preserves relation member types, refs and roles', async () => {
    const { relations } = await roundTrip(ELEMENTS);
    const rel = relations[0];
    if (rel?.kind !== 'relation') throw new Error('expected a relation');
    expect(rel.tags.get('restriction')).toBe('no_left_turn');
    expect(rel.members).toEqual([
      { type: 'way', ref: 900_000_001, role: 'from' },
      { type: 'node', ref: 1_000_000_003, role: 'via' },
      { type: 'way', ref: 900_000_002, role: 'to' },
    ]);
  });

  it('keeps keys_vals aligned when tagged and untagged nodes are interleaved', async () => {
    // The flat 0-terminated keys_vals run is the single most fragile part of DenseNodes. An
    // untagged node still needs its terminator, or every later node's tags land on the wrong
    // node and the map fills with plausible, wrongly-placed labels.
    const { nodes } = await roundTrip(ELEMENTS);
    const byId = new Map(nodes.map((el) => [el.id, el]));
    expect(byId.get(1_000_000_001)?.tags.get('name')).toBe('कासना');
    expect(byId.get(1_000_000_002)?.tags.size).toBe(0);
    expect(byId.get(1_000_000_003)?.tags.get('name')).toBe('Kasana Nursing Home');
    expect(byId.get(13_000_000_004)?.tags.size).toBe(0);
  });
});
