/**
 * Clip both extracts to BUILD_AREA, merge them, dedupe by OSM element id, and cache the
 * result so no later pass pays the full decode again.
 *
 * WHY A CACHE: a full streaming decode of both extracts is about 190 s. Every downstream
 * pass (graph, places, spot checks, experiments) would pay that, which strangles the dev
 * loop and quietly discourages re-measuring. The cache is keyed by a hash of BUILD_AREA plus
 * both extract md5s plus a format version, so it cannot go stale silently: change the area,
 * re-download an extract, or change the format, and the key misses and it rebuilds.
 *
 * WHY TWO PASSES: a way is kept when ANY of its nodes is inside BUILD_AREA, and a kept way
 * needs ALL of its node coordinates, including the ones just outside. Nodes precede ways in
 * the file, so the set of outside-but-needed nodes is only knowable after the ways have been
 * read. Pass 1 reads everything and records which extra node ids are needed; pass 2 re-reads
 * only the node sections and fetches them, stopping as soon as ways begin. Dropping pass 2
 * would truncate every boundary-crossing road, which is precisely the severing the 3 km
 * buffer exists to prevent, and it would show up much later as a stranded SCC.
 *
 * DEDUPE, and why the count matters: Geofabrik cuts zones with complete ways, so every
 * element near the Central/Northern seam appears in BOTH files. Dedupe is by element id,
 * first-write-wins. hard-rules.md § Build and data: a duplicate count of zero is a bug, not
 * a clean run, because the seam demonstrably crosses the western edge of the area.
 *
 * SCOPE OF THE DEDUPE COUNT, stated because it is easy to misread: duplicates are counted
 * among elements the clip KEEPS, not across all 91.5M nodes in both files. Counting the
 * latter would need an id set over every node in both extracts, roughly 1.5 GB, to answer a
 * question nothing downstream asks. The seam metric that matters is the delta between the
 * summed per-file in-area node count and the deduped union, and that is reported.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { BUILD_AREA } from '../../../config/city.ts';
import { readOsmPbf } from '../pbf/osmpbf.ts';
import type { OsmElement } from '../pbf/osmpbf.ts';
import { IdMap, IdSet } from './idset.ts';
import { ByteReader, ByteWriter } from './binio.ts';
import { COORD_SCALE, inBuildAreaScaled, toScaled } from './area.ts';

/**
 * Bump when the on-disk layout changes. Part of the cache key, so old caches just miss.
 * v2: containment moved from degrees to scaled integers, which changes which nodes are kept
 * at the boundary, so every v1 cache is wrong by up to a node per edge and must be rebuilt.
 * v3: relation filter widened to keep multipolygon and boundary relations, which tilemaker
 * needs to assemble lakes, parks and the district outline. A v2 cache holds fewer relations
 * than this build expects, so it must not be reused.
 * v4: relations are now filtered SPATIALLY as well as by tag. v3 and earlier kept every named
 * relation in both entire zone extracts, which meant rivers in Punjab and towns in central
 * India were carried into a Gautam Buddha Nagar build, and would have gone straight into the
 * places index and the search ranking.
 */
export const CLIP_FORMAT_VERSION = 4;
const MAGIC = 0x57464331; // "WFC1"

export interface ClipExtractInput {
  readonly name: string;
  readonly localPath: string;
  readonly md5: string;
}

export interface PerFileCounts {
  readonly name: string;
  readonly nodesRead: number;
  readonly waysRead: number;
  readonly relationsRead: number;
  readonly nodesInArea: number;
  readonly waysTouchingArea: number;
  readonly relationsKept: number;
}

export interface ClipStats {
  readonly perFile: readonly PerFileCounts[];
  /** Sum of per-file in-area node counts. Double counts the seam on purpose, as a baseline. */
  readonly nodesInAreaSummed: number;
  /** Deduped union. The real figure. */
  readonly nodesInAreaUnion: number;
  /** nodesInAreaSummed - nodesInAreaUnion. The seam overlap, measured rather than assumed. */
  readonly seamOverlapNodes: number;
  readonly duplicates: { readonly nodes: number; readonly ways: number; readonly relations: number };
  /**
   * A few real ids that arrived twice, kept so the seam can be checked against a NAMED way
   * rather than only a count. A count proves the dedupe ran; a specific way crossing the
   * Central/Northern boundary with exactly one record proves it ran correctly.
   */
  readonly sampleDuplicateWayIds: readonly number[];
  readonly sampleDuplicateNodeIds: readonly number[];
  readonly keptNodes: number;
  readonly keptWays: number;
  readonly keptWaysWithHighway: number;
  readonly keptRelations: number;
  /** Restriction relations that touch the build area. NOT the whole-extract figure. */
  readonly keptRestrictions: number;
  /** Tag-matched but spatially outside. Large is expected: the extracts cover several states. */
  readonly relationsOutsideArea: number;
  readonly nestedRelationMembers: number;
  readonly extraNodesForCompleteWays: number;
  readonly pass1Seconds: number;
  readonly pass2Seconds: number;
  readonly writeSeconds: number;
  readonly peakRssBytes: number;
  readonly cacheBytes: number;
}

export interface ClippedWay {
  readonly id: number;
  readonly refs: readonly number[];
  readonly tags: ReadonlyMap<string, string>;
}

export interface ClippedRelationMember {
  readonly type: 'node' | 'way' | 'relation';
  readonly ref: number;
  readonly role: string;
}

export interface ClippedRelation {
  readonly id: number;
  readonly members: readonly ClippedRelationMember[];
  readonly tags: ReadonlyMap<string, string>;
}

/**
 * The clipped subset, as loaded from cache. Nodes stay in parallel typed arrays because the
 * graph builder wants them that way and there are millions; ways and relations are objects
 * because there are far fewer and they carry variable-length parts.
 */
export interface Clipped {
  readonly nodeIds: Float64Array;
  /** Scaled by 1e7. Divide by COORD_SCALE, or use nodeLatLon. */
  readonly nodeLat: Int32Array;
  readonly nodeLon: Int32Array;
  readonly nodeTags: ReadonlyMap<number, ReadonlyMap<string, string>>;
  readonly ways: readonly ClippedWay[];
  readonly relations: readonly ClippedRelation[];
  readonly stats: ClipStats;
  /** id to index into the node arrays. Built on load; the cache does not store it. */
  readonly nodeIndex: IdMap;
}

export function scaledToDeg(v: number): number {
  return v / COORD_SCALE;
}

/** Identifies exactly the inputs the clip depends on. A miss here must mean a rebuild. */
export function clipCacheKey(extracts: readonly ClipExtractInput[]): string {
  const h = createHash('sha256');
  h.update(`v${CLIP_FORMAT_VERSION}\n`);
  h.update(
    `${BUILD_AREA.minLat},${BUILD_AREA.maxLat},${BUILD_AREA.minLon},${BUILD_AREA.maxLon}\n`,
  );
  for (const e of [...extracts].sort((a, b) => a.name.localeCompare(b.name))) {
    h.update(`${e.name}:${e.md5}\n`);
  }
  return h.digest('hex');
}

// Containment is `inBuildAreaScaled` from ./area.ts, deliberately not a float compare on
// degrees. See that file: the float version disagreed with libosmium by exactly one node.

/**
 * Kept relations, one line per consumer so nothing is kept for a vague reason:
 *  - `restriction` drives legality in the graph.
 *  - `multipolygon` carries lakes with islands, big parks and forests. Without these, tilemaker
 *    cannot assemble those areas and they silently vanish from the map.
 *  - `boundary` gives the district outline and admin edges.
 *  - anything named feeds the places index.
 */
function keepRelation(tags: ReadonlyMap<string, string>): boolean {
  const type = tags.get('type');
  return (
    type === 'restriction' ||
    type === 'multipolygon' ||
    type === 'boundary' ||
    tags.has('name')
  );
}

interface Progress {
  (message: string): void;
}

/**
 * How an extract's elements are read. Injectable so the clip can be tested on synthetic
 * elements: dedupe across two overlapping sources, and pass 2 completing a boundary-crossing
 * way, are both integration behaviours that no unit test of IdSet can reach. Must return a
 * FRESH iterable on each call, because it is called once per pass.
 */
export type OpenExtract = (extract: ClipExtractInput) => AsyncIterable<OsmElement>;

const openFromFile: OpenExtract = (e) => readOsmPbf(e.localPath);

export async function buildClip(
  extracts: readonly ClipExtractInput[],
  log: Progress = () => {},
  open: OpenExtract = openFromFile,
): Promise<{ clipped: Clipped; bytes: Uint8Array }> {
  let peakRss = 0;
  const sampleRss = (): void => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  };

  // String interning. Storing tag pairs as string-table indices avoids millions of small
  // strings and, more importantly, avoids one Map per element.
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const intern = (s: string): number => {
    const existing = stringIndex.get(s);
    if (existing !== undefined) return existing;
    const i = strings.length;
    strings.push(s);
    stringIndex.set(s, i);
    return i;
  };

  const inAreaIds = new IdSet(2_500_000);
  const nodeIndexMap = new IdMap(2_500_000);
  const nodeIds: number[] = [];
  const nodeLat: number[] = [];
  const nodeLon: number[] = [];
  const nodeTagOff: number[] = [0];
  const nodeTagPairs: number[] = [];

  const wayIdsSeen = new IdSet(400_000);
  const ways: ClippedWay[] = [];
  const relIdsSeen = new IdSet(100_000);
  const relations: ClippedRelation[] = [];

  /** Refs of kept ways that are NOT inside the area. Pass 2 fetches their coordinates. */
  const extraNeeded = new IdSet(400_000);

  const duplicates = { nodes: 0, ways: 0, relations: 0 };
  let relationsOutsideArea = 0;
  /**
   * Relation members that are themselves relations. Their membership cannot be decided from the
   * node and way sets, so a relation held together ONLY by nested relations is dropped. Counted
   * rather than ignored, because it is a known blind spot in the spatial filter.
   */
  let nestedRelationMembers = 0;
  const SAMPLE_LIMIT = 10;
  const sampleDuplicateWayIds: number[] = [];
  const sampleDuplicateNodeIds: number[] = [];
  const perFile: PerFileCounts[] = [];
  let nodesInAreaSummed = 0;
  let keptWaysWithHighway = 0;
  let keptRestrictions = 0;

  const storeNode = (
    id: number,
    latScaled: number,
    lonScaled: number,
    tags: ReadonlyMap<string, string>,
  ): void => {
    const idx = nodeIds.length;
    if (!nodeIndexMap.set(id, idx)) return; // first-write-wins
    nodeIds.push(id);
    nodeLat.push(latScaled);
    nodeLon.push(lonScaled);
    if (tags.size > 0) {
      for (const [k, v] of tags) {
        nodeTagPairs.push(intern(k), intern(v));
      }
    }
    nodeTagOff.push(nodeTagPairs.length);
  };

  // ---- Pass 1: everything. Nodes to find the in-area set, then ways, then relations. ----
  const t1 = performance.now();
  for (const e of extracts) {
    let nodesRead = 0;
    let waysRead = 0;
    let relationsRead = 0;
    let nodesInArea = 0;
    let waysTouchingArea = 0;
    let relationsKept = 0;

    for await (const el of open(e)) {
      if (el.kind === 'node') {
        nodesRead++;
        const latS = toScaled(el.lat);
        const lonS = toScaled(el.lon);
        if (!inBuildAreaScaled(latS, lonS)) continue;
        nodesInArea++;
        nodesInAreaSummed++;
        if (!inAreaIds.add(el.id)) {
          duplicates.nodes++;
          if (sampleDuplicateNodeIds.length < SAMPLE_LIMIT) sampleDuplicateNodeIds.push(el.id);
          continue;
        }
        storeNode(el.id, latS, lonS, el.tags);
        if ((nodesInArea & 0x3ffff) === 0) {
          sampleRss();
          log(`  ${e.name} pass1 nodes in area ${nodesInArea.toLocaleString('en-US')}`);
        }
      } else if (el.kind === 'way') {
        waysRead++;
        let touches = false;
        for (const r of el.refs) {
          if (inAreaIds.has(r)) {
            touches = true;
            break;
          }
        }
        if (!touches) continue;
        waysTouchingArea++;
        if (!wayIdsSeen.add(el.id)) {
          duplicates.ways++;
          // Prefer a named highway as the sample: it is the case a doubled label or a doubled
          // edge would actually be visible in, so it makes the better committed fixture.
          if (sampleDuplicateWayIds.length < SAMPLE_LIMIT && el.tags.has('highway')) {
            sampleDuplicateWayIds.push(el.id);
          }
          continue;
        }
        ways.push({ id: el.id, refs: el.refs, tags: el.tags });
        if (el.tags.has('highway')) keptWaysWithHighway++;
        for (const r of el.refs) {
          if (!inAreaIds.has(r)) extraNeeded.add(r);
        }
        if ((waysTouchingArea & 0xffff) === 0) {
          sampleRss();
          log(`  ${e.name} pass1 ways touching area ${waysTouchingArea.toLocaleString('en-US')}`);
        }
      } else {
        relationsRead++;
        if (!keepRelation(el.tags)) continue;
        // SPATIAL filter, not just a tag filter. Relations come last in a type-sorted file, so
        // by now the kept-way and in-area-node sets are complete for this file and membership
        // is decidable. Without this the clip carried every named relation in both entire zone
        // extracts, so rivers in Punjab and towns in central India would land in the places
        // index for a Gautam Buddha Nagar build.
        let touches = false;
        for (const m of el.members) {
          if (m.type === 'way' && wayIdsSeen.has(m.ref)) {
            touches = true;
            break;
          }
          if (m.type === 'node' && inAreaIds.has(m.ref)) {
            touches = true;
            break;
          }
          if (m.type === 'relation') nestedRelationMembers++;
        }
        if (!touches) {
          relationsOutsideArea++;
          continue;
        }
        relationsKept++;
        if (!relIdsSeen.add(el.id)) {
          duplicates.relations++;
          continue;
        }
        relations.push({ id: el.id, members: el.members, tags: el.tags });
        if (el.tags.get('type') === 'restriction') keptRestrictions++;
      }
    }

    sampleRss();
    perFile.push({ name: e.name, nodesRead, waysRead, relationsRead, nodesInArea, waysTouchingArea, relationsKept });
    log(
      `  ${e.name} pass1 done: ${nodesRead.toLocaleString('en-US')} nodes read, ` +
        `${nodesInArea.toLocaleString('en-US')} in area, ${waysTouchingArea.toLocaleString('en-US')} ways kept`,
    );
  }
  const pass1Seconds = (performance.now() - t1) / 1000;

  // ---- Pass 2: node sections only, to complete boundary-crossing ways. ----
  const t2 = performance.now();
  let extraFetched = 0;
  if (extraNeeded.size > 0) {
    for (const e of extracts) {
      let scanned = 0;
      for await (const el of open(e)) {
        // Nodes come first in a type-sorted PBF. The moment a way appears, this file has no
        // more nodes to offer, so stop rather than stream the remaining hundreds of MB.
        if (el.kind !== 'node') break;
        scanned++;
        if (!extraNeeded.has(el.id)) continue;
        if (nodeIndexMap.has(el.id)) continue;
        storeNode(el.id, toScaled(el.lat), toScaled(el.lon), el.tags);
        extraFetched++;
      }
      sampleRss();
      log(
        `  ${e.name} pass2 done: ${scanned.toLocaleString('en-US')} nodes scanned, ` +
          `${extraFetched.toLocaleString('en-US')} extra fetched so far`,
      );
    }
  }
  const pass2Seconds = (performance.now() - t2) / 1000;

  // ---- Serialize ----
  const t3 = performance.now();
  const w = new ByteWriter(1 << 22);
  w.i32(MAGIC);
  w.varint(CLIP_FORMAT_VERSION);
  w.string(clipCacheKey(extracts));

  const statsPlaceholder: ClipStats = {
    perFile,
    nodesInAreaSummed,
    nodesInAreaUnion: inAreaIds.size,
    seamOverlapNodes: nodesInAreaSummed - inAreaIds.size,
    duplicates,
    sampleDuplicateWayIds,
    sampleDuplicateNodeIds,
    keptNodes: nodeIds.length,
    keptWays: ways.length,
    keptWaysWithHighway,
    keptRelations: relations.length,
    keptRestrictions,
    relationsOutsideArea,
    nestedRelationMembers,
    extraNodesForCompleteWays: extraFetched,
    pass1Seconds: Number(pass1Seconds.toFixed(1)),
    pass2Seconds: Number(pass2Seconds.toFixed(1)),
    writeSeconds: 0,
    peakRssBytes: peakRss,
    cacheBytes: 0,
  };
  w.string(JSON.stringify(statsPlaceholder));

  // Intern EVERYTHING before the table is written. Node tags were interned during pass 1,
  // but way tags, relation tags and member roles were not, and interning them lazily further
  // down would append to the table after it had already been serialized. The cache would then
  // reference indices past its own table and fail to parse, which is the kind of bug that
  // only shows up on the second run.
  for (const way of ways) {
    for (const [k, v] of way.tags) {
      intern(k);
      intern(v);
    }
  }
  for (const rel of relations) {
    for (const m of rel.members) intern(m.role);
    for (const [k, v] of rel.tags) {
      intern(k);
      intern(v);
    }
  }

  const tableSize = strings.length;
  w.varint(tableSize);
  for (const s of strings) w.string(s);

  w.varint(nodeIds.length);
  // Ids delta-encoded. The in-area set arrives in file order, which is id-ascending within
  // each file, so deltas are small and this is most of the cache's size win.
  let prev = 0;
  for (const id of nodeIds) {
    w.svarint(id - prev);
    prev = id;
  }
  for (let i = 0; i < nodeIds.length; i++) w.i32(nodeLat[i] as number);
  for (let i = 0; i < nodeIds.length; i++) w.i32(nodeLon[i] as number);
  w.varint(nodeTagPairs.length);
  for (const v of nodeTagPairs) w.varint(v);
  for (let i = 0; i < nodeIds.length; i++) w.varint(nodeTagOff[i + 1] as number);

  w.varint(ways.length);
  for (const way of ways) {
    w.varint(way.id);
    w.varint(way.refs.length);
    let p = 0;
    for (const r of way.refs) {
      w.svarint(r - p);
      p = r;
    }
    w.varint(way.tags.size);
    for (const [k, v] of way.tags) {
      w.varint(intern(k));
      w.varint(intern(v));
    }
  }

  w.varint(relations.length);
  const MEMBER_CODE = { node: 0, way: 1, relation: 2 } as const;
  for (const rel of relations) {
    w.varint(rel.id);
    w.varint(rel.members.length);
    let p = 0;
    for (const m of rel.members) {
      w.u8(MEMBER_CODE[m.type]);
      w.svarint(m.ref - p);
      p = m.ref;
      w.varint(intern(m.role));
    }
    w.varint(rel.tags.size);
    for (const [k, v] of rel.tags) {
      w.varint(intern(k));
      w.varint(intern(v));
    }
  }

  // Guards the invariant above: nothing may have been interned after the table was written.
  if (strings.length !== tableSize) {
    throw new Error(
      `string table grew from ${tableSize} to ${strings.length} after being serialized; ` +
        `the cache would reference indices past its own table`,
    );
  }
  const bytes = Uint8Array.prototype.slice.call(w.view());
  const writeSeconds = (performance.now() - t3) / 1000;
  sampleRss();

  const stats: ClipStats = {
    ...statsPlaceholder,
    writeSeconds: Number(writeSeconds.toFixed(1)),
    peakRssBytes: peakRss,
    cacheBytes: bytes.length,
  };

  const clipped: Clipped = {
    nodeIds: new Float64Array(nodeIds),
    nodeLat: new Int32Array(nodeLat),
    nodeLon: new Int32Array(nodeLon),
    nodeTags: readNodeTags(nodeIds, nodeTagOff, nodeTagPairs, strings),
    ways,
    relations,
    stats,
    nodeIndex: nodeIndexMap,
  };

  return { clipped, bytes };
}

function readNodeTags(
  ids: ArrayLike<number>,
  offsets: readonly number[],
  pairs: readonly number[],
  strings: readonly string[],
): Map<number, ReadonlyMap<string, string>> {
  const out = new Map<number, ReadonlyMap<string, string>>();
  for (let i = 0; i < ids.length; i++) {
    const from = offsets[i] as number;
    const to = offsets[i + 1] as number;
    if (to === from) continue;
    const m = new Map<string, string>();
    for (let p = from; p < to; p += 2) {
      m.set(strings[pairs[p] as number] as string, strings[pairs[p + 1] as number] as string);
    }
    out.set(ids[i] as number, m);
  }
  return out;
}

/** Parses a cache written by buildClip. Throws when the key does not match the inputs. */
export function parseClip(bytes: Uint8Array, expectedKey: string): Clipped {
  const r = new ByteReader(bytes);
  if (r.i32() !== MAGIC) throw new Error('clip cache magic mismatch; the file is not a clip cache');
  const version = r.varint();
  if (version !== CLIP_FORMAT_VERSION) {
    throw new Error(`clip cache is format v${version}, this build wants v${CLIP_FORMAT_VERSION}`);
  }
  const key = r.string();
  if (key !== expectedKey) {
    throw new Error(
      `clip cache was built from different inputs (key ${key.slice(0, 12)} vs ${expectedKey.slice(0, 12)}). ` +
        `Re-run npm run build-city to rebuild it.`,
    );
  }
  const stats = JSON.parse(r.string()) as ClipStats;

  const stringCount = r.varint();
  const strings: string[] = new Array(stringCount);
  for (let i = 0; i < stringCount; i++) strings[i] = r.string();

  const nodeCount = r.varint();
  const nodeIds = new Float64Array(nodeCount);
  let prev = 0;
  for (let i = 0; i < nodeCount; i++) {
    prev += r.svarint();
    nodeIds[i] = prev;
  }
  const nodeLat = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) nodeLat[i] = r.i32();
  const nodeLon = new Int32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) nodeLon[i] = r.i32();
  const pairCount = r.varint();
  const pairs: number[] = new Array(pairCount);
  for (let i = 0; i < pairCount; i++) pairs[i] = r.varint();
  const offsets: number[] = new Array(nodeCount + 1);
  offsets[0] = 0;
  for (let i = 0; i < nodeCount; i++) offsets[i + 1] = r.varint();

  const nodeIndex = new IdMap(Math.max(1024, nodeCount));
  for (let i = 0; i < nodeCount; i++) nodeIndex.set(nodeIds[i] as number, i);

  const wayCount = r.varint();
  const ways: ClippedWay[] = new Array(wayCount);
  for (let i = 0; i < wayCount; i++) {
    const id = r.varint();
    const refCount = r.varint();
    const refs: number[] = new Array(refCount);
    let p = 0;
    for (let j = 0; j < refCount; j++) {
      p += r.svarint();
      refs[j] = p;
    }
    const tagCount = r.varint();
    const tags = new Map<string, string>();
    for (let j = 0; j < tagCount; j++) {
      tags.set(strings[r.varint()] as string, strings[r.varint()] as string);
    }
    ways[i] = { id, refs, tags };
  }

  const MEMBER_TYPES = ['node', 'way', 'relation'] as const;
  const relCount = r.varint();
  const relations: ClippedRelation[] = new Array(relCount);
  for (let i = 0; i < relCount; i++) {
    const id = r.varint();
    const memberCount = r.varint();
    const members: ClippedRelationMember[] = new Array(memberCount);
    let p = 0;
    for (let j = 0; j < memberCount; j++) {
      const type = MEMBER_TYPES[r.u8()] ?? 'node';
      p += r.svarint();
      members[j] = { type, ref: p, role: strings[r.varint()] as string };
    }
    const tagCount = r.varint();
    const tags = new Map<string, string>();
    for (let j = 0; j < tagCount; j++) {
      tags.set(strings[r.varint()] as string, strings[r.varint()] as string);
    }
    relations[i] = { id, members, tags };
  }

  return {
    nodeIds,
    nodeLat,
    nodeLon,
    nodeTags: readNodeTags(nodeIds, offsets, pairs, strings),
    ways,
    relations,
    stats,
    nodeIndex,
  };
}

/**
 * Loads the cache when its key matches the current inputs, otherwise rebuilds and writes it.
 * The cache is disposable: any failure to read it is a rebuild, never a hard error, because
 * data/ is git-ignored and regenerable by definition.
 */
export async function loadOrBuildClip(
  extracts: readonly ClipExtractInput[],
  cachePath: string,
  log: Progress = () => {},
  open: OpenExtract = openFromFile,
): Promise<{ clipped: Clipped; fromCache: boolean }> {
  const key = clipCacheKey(extracts);
  try {
    const bytes = await readFile(cachePath);
    const clipped = parseClip(bytes, key);
    log(`clip cache HIT (${(bytes.length / 1024 / 1024).toFixed(1)} MB, key ${key.slice(0, 12)})`);
    return { clipped, fromCache: true };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    log(`clip cache MISS: ${why}`);
  }
  const { clipped, bytes } = await buildClip(extracts, log, open);
  await writeFile(cachePath, bytes);
  log(`clip cache written: ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
  return { clipped, fromCache: false };
}
