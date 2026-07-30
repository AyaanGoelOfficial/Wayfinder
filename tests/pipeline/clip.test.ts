/**
 * The clip and merge behaviours that no unit test of IdSet can reach: dedupe across two
 * overlapping sources, pass 2 completing a boundary-crossing way, and the cache round-trip.
 *
 * Elements are injected rather than read from a .osm.pbf, so these run with no `data/` and
 * stay instant. The real extracts are exercised by the build itself, which asserts the seam
 * against actual duplicated way ids and fails hard on a zero duplicate count.
 *
 * Coordinates: 28.5 / 77.5 is inside BUILD_AREA (28.058161..28.679899, 77.262262..77.768478).
 * 28.5 / 76.9 is well west of it, which is the direction the Central/Northern seam runs.
 */
import { describe, expect, it } from 'vitest';
import { buildClip, clipCacheKey, parseClip } from '../../packages/pipeline/clip/clip.ts';
import type { ClipExtractInput, OpenExtract } from '../../packages/pipeline/clip/clip.ts';
import type { OsmElement } from '../../packages/pipeline/pbf/osmpbf.ts';

const A: ClipExtractInput = { name: 'zone-a', localPath: '(injected)', md5: 'aaaa' };
const B: ClipExtractInput = { name: 'zone-b', localPath: '(injected)', md5: 'bbbb' };

function node(id: number, lat: number, lon: number, tags: Record<string, string> = {}): OsmElement {
  return { kind: 'node', id, lat, lon, tags: new Map(Object.entries(tags)) };
}
function way(id: number, refs: number[], tags: Record<string, string> = {}): OsmElement {
  return { kind: 'way', id, refs, tags: new Map(Object.entries(tags)) };
}

/** Elements MUST be emitted nodes first, then ways, then relations, as a real PBF is sorted. */
function source(per: Record<string, OsmElement[]>): OpenExtract {
  return (e) => {
    const list = per[e.name] ?? [];
    return (async function* () {
      for (const el of list) yield el;
    })();
  };
}

describe('clip: dedupe across two overlapping extracts', () => {
  it('keeps one copy and counts the duplicate, first-write-wins', async () => {
    // The same road and the same node present in both files, which is exactly what Geofabrik's
    // complete-ways cutting guarantees along the Central/Northern seam.
    const shared = [
      node(1, 28.5, 77.5),
      node(2, 28.51, 77.5),
      way(100, [1, 2], { highway: 'primary', name: 'Seam Road' }),
    ];
    const { clipped } = await buildClip([A, B], () => {}, source({ 'zone-a': shared, 'zone-b': shared }));

    expect(clipped.stats.duplicates.nodes).toBe(2);
    expect(clipped.stats.duplicates.ways).toBe(1);
    expect(clipped.nodeIds.length).toBe(2);
    expect(clipped.ways.length).toBe(1);
    // The seam metric the build report leads with: summed double counts, union does not.
    expect(clipped.stats.nodesInAreaSummed).toBe(4);
    expect(clipped.stats.nodesInAreaUnion).toBe(2);
    expect(clipped.stats.seamOverlapNodes).toBe(2);
  });

  it('samples a real duplicated highway id, so the seam check can name a way', async () => {
    const shared = [
      node(1, 28.5, 77.5),
      node(2, 28.51, 77.5),
      way(4242, [1, 2], { highway: 'secondary' }),
    ];
    const { clipped } = await buildClip([A, B], () => {}, source({ 'zone-a': shared, 'zone-b': shared }));
    expect(clipped.stats.sampleDuplicateWayIds).toContain(4242);
    expect(clipped.ways.filter((w) => w.id === 4242).length).toBe(1);
  });

  it('takes the FIRST file\'s copy, not the last', async () => {
    const first = [node(1, 28.5, 77.5, { name: 'first' })];
    const second = [node(1, 28.6, 77.6, { name: 'second' })];
    const { clipped } = await buildClip([A, B], () => {}, source({ 'zone-a': first, 'zone-b': second }));
    expect(clipped.nodeIds.length).toBe(1);
    // Last-write-wins would silently move the node, and the two extracts genuinely can carry
    // different versions if they were cut at different times.
    expect(clipped.nodeTags.get(1)?.get('name')).toBe('first');
    expect(clipped.nodeLat[0]).toBe(285_000_000);
  });
});

describe('clip: pass 2 completes boundary-crossing ways', () => {
  it('fetches the coordinates of a node outside the area that a kept way needs', async () => {
    // Node 2 is west of BUILD_AREA. The way straddles the edge, so without pass 2 its geometry
    // would stop at the cut, severing the road. That is the failure the 3 km buffer exists to
    // prevent, and it would surface much later as a stranded SCC.
    const els = [
      node(1, 28.5, 77.5),
      node(2, 28.5, 76.9),
      way(100, [1, 2], { highway: 'trunk' }),
    ];
    const { clipped } = await buildClip([A], () => {}, source({ 'zone-a': els }));

    expect(clipped.stats.nodesInAreaUnion).toBe(1);
    expect(clipped.stats.extraNodesForCompleteWays).toBe(1);
    expect(clipped.nodeIds.length).toBe(2);
    expect(clipped.nodeIndex.get(2)).toBeGreaterThanOrEqual(0);
    expect(clipped.ways[0]?.refs).toEqual([1, 2]);
  });

  it('drops a way with no node inside the area', async () => {
    const els = [
      node(10, 28.5, 76.9),
      node(11, 28.5, 76.91),
      way(200, [10, 11], { highway: 'primary' }),
    ];
    const { clipped } = await buildClip([A], () => {}, source({ 'zone-a': els }));
    expect(clipped.ways.length).toBe(0);
    expect(clipped.nodeIds.length).toBe(0);
  });

  it('treats a node exactly on the boundary as inside', async () => {
    // Integer containment, inclusive bounds. The float comparison put a real node
    // (9942251826, lat 28.679899) outside and disagreed with libosmium by exactly one.
    const els = [node(1, 28.679899, 77.5), node(2, 28.058161, 77.262262)];
    const { clipped } = await buildClip([A], () => {}, source({ 'zone-a': els }));
    expect(clipped.stats.nodesInAreaUnion).toBe(2);
  });
});

describe('clip: relations are filtered spatially, not only by tag', () => {
  /** Relations must be emitted last, as a type-sorted PBF does, or membership is not decidable. */
  function relation(id: number, members: { type: 'node' | 'way'; ref: number }[], tags: Record<string, string>): OsmElement {
    return {
      kind: 'relation',
      id,
      members: members.map((m) => ({ ...m, role: '' })),
      tags: new Map(Object.entries(tags)),
    };
  }

  it('drops a named relation whose members are all outside the area', async () => {
    // This is the real defect this test exists for: a tag-only filter carried every named
    // relation in BOTH entire zone extracts, so rivers in Punjab and towns in central India
    // were being loaded into a Gautam Buddha Nagar build and would have entered the places
    // index and its ranking.
    const els = [
      node(1, 28.5, 77.5),
      node(2, 28.51, 77.5),
      node(50, 28.5, 76.9),
      node(51, 28.5, 76.91),
      way(100, [1, 2], { highway: 'primary' }),
      way(500, [50, 51], { waterway: 'river' }),
      relation(900, [{ type: 'way', ref: 500 }], { type: 'multipolygon', name: 'Far Away River' }),
      relation(901, [{ type: 'way', ref: 100 }], { type: 'multipolygon', name: 'Local Park' }),
    ];
    const { clipped } = await buildClip([A], () => {}, source({ 'zone-a': els }));

    expect(clipped.relations.map((r) => r.id)).toEqual([901]);
    expect(clipped.stats.relationsOutsideArea).toBe(1);
    expect(clipped.stats.keptRelations).toBe(1);
  });

  it('keeps a restriction whose via node is in the area', async () => {
    const els = [
      node(1, 28.5, 77.5),
      node(2, 28.51, 77.5),
      way(100, [1, 2], { highway: 'primary' }),
      relation(900, [{ type: 'node', ref: 2 }], { type: 'restriction', restriction: 'no_left_turn' }),
      relation(901, [{ type: 'node', ref: 9999 }], { type: 'restriction', restriction: 'no_u_turn' }),
    ];
    const { clipped } = await buildClip([A], () => {}, source({ 'zone-a': els }));
    expect(clipped.stats.keptRestrictions).toBe(1);
    expect(clipped.relations.map((r) => r.id)).toEqual([900]);
  });

  it('counts nested relation members as the blind spot they are', async () => {
    const els = [
      node(1, 28.5, 77.5),
      node(2, 28.51, 77.5),
      way(100, [1, 2], { highway: 'primary' }),
      {
        kind: 'relation' as const,
        id: 900,
        members: [{ type: 'relation' as const, ref: 7, role: 'subarea' }],
        tags: new Map([['type', 'boundary'], ['name', 'Held only by a nested relation']]),
      },
    ];
    const { clipped } = await buildClip([A], () => {}, source({ 'zone-a': els }));
    // Dropped, because membership cannot be decided from the node and way sets. Counted so the
    // gap is visible in the build report rather than silently swallowing a district outline.
    expect(clipped.stats.nestedRelationMembers).toBe(1);
    expect(clipped.relations.length).toBe(0);
  });
});

describe('clip: cache round-trip', () => {
  it('reads back byte-identical content, including multi-script tags', async () => {
    const els: OsmElement[] = [
      node(1, 28.5, 77.5, { name: 'कासना', place: 'village' }),
      node(2, 28.51, 77.5),
      node(3, 28.52, 77.51),
      way(100, [1, 2, 3], { highway: 'tertiary', name: 'Old Kasana Road', oneway: '-1' }),
      {
        kind: 'relation',
        id: 900,
        members: [
          { type: 'way', ref: 100, role: 'from' },
          { type: 'node', ref: 2, role: 'via' },
        ],
        tags: new Map([['type', 'restriction'], ['restriction', 'no_left_turn']]),
      },
    ];
    const { clipped, bytes } = await buildClip([A], () => {}, source({ 'zone-a': els }));
    const reparsed = parseClip(bytes, clipCacheKey([A]));

    expect(reparsed.nodeIds.length).toBe(clipped.nodeIds.length);
    expect([...reparsed.nodeIds]).toEqual([...clipped.nodeIds]);
    expect([...reparsed.nodeLat]).toEqual([...clipped.nodeLat]);
    expect([...reparsed.nodeLon]).toEqual([...clipped.nodeLon]);
    // The string table is written before way and relation tags are interned, so a drift there
    // would make the cache reference indices past its own table and fail on the SECOND run.
    expect(reparsed.nodeTags.get(1)?.get('name')).toBe('कासना');
    expect(reparsed.ways[0]?.tags.get('name')).toBe('Old Kasana Road');
    expect(reparsed.ways[0]?.tags.get('oneway')).toBe('-1');
    expect(reparsed.ways[0]?.refs).toEqual([1, 2, 3]);
    expect(reparsed.relations[0]?.members).toEqual([
      { type: 'way', ref: 100, role: 'from' },
      { type: 'node', ref: 2, role: 'via' },
    ]);
    expect(reparsed.relations[0]?.tags.get('restriction')).toBe('no_left_turn');
  });

  it('refuses a cache built from different inputs instead of misreading it', async () => {
    const els = [node(1, 28.5, 77.5)];
    const { bytes } = await buildClip([A], () => {}, source({ 'zone-a': els }));
    // A re-downloaded extract changes its md5, which changes the key. Silently accepting the
    // old cache would build the city from stale data while reporting the new provenance.
    expect(() => parseClip(bytes, clipCacheKey([{ ...A, md5: 'different' }]))).toThrow(/different inputs/);
  });

  it('changes the cache key when an extract md5 changes', () => {
    expect(clipCacheKey([A])).not.toBe(clipCacheKey([{ ...A, md5: 'zzzz' }]));
    // Order must not matter: the same two extracts listed either way are the same inputs.
    expect(clipCacheKey([A, B])).toBe(clipCacheKey([B, A]));
  });
});
