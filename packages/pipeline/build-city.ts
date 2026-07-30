/**
 * `npm run build-city`. Extracts to artifacts, one command.
 *
 * Gate 1's deliverable is NUMBERS, so this reports rather than merely succeeds: deduped vertex
 * and edge counts, SCC coverage, the clipped restriction count, wall time and peak RSS per
 * stage. Those numbers decide contraction hierarchies, the matcher budget and the tile
 * strategy, and nothing downstream should be decided without them.
 *
 * Does NOT re-download. Run `npm run fetch:extracts` for that.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BUILD_AREA, BOUNDARY_RELATION } from '../../config/city.ts';
import { loadOrBuildClip, parseClip, clipCacheKey } from './clip/clip.ts';
import type { ClipExtractInput } from './clip/clip.ts';
import { buildGraph } from './graph/build.ts';
import { buildTurnTable } from './graph/restrictions.ts';
import { writeClipAsPbf } from './clip/pbfwrite.ts';
import { buildPlaces } from './places/build.ts';
import { SUPPORTED_SCRIPTS, buildRanges, isSupportedScript, loadFace } from './glyphs/build.ts';
import { buildTiles } from './tiles/build-tiles.ts';
import { readLock } from '../../scripts/fetch-extracts.ts';

const DATA = resolve(import.meta.dirname, '../../data');
const CLIP_CACHE = resolve(DATA, 'clipped.bin');
const CLIP_PBF = resolve(DATA, 'clipped.osm.pbf');
const PMTILES = resolve(DATA, 'wayfinder-gn.pmtiles');
/** Set BUILD_SKIP_TILES=1 to iterate on the graph without paying for tilemaker. */
const SKIP_TILES = process.env['BUILD_SKIP_TILES'] === '1';

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}
function n(v: number): string {
  return v.toLocaleString('en-US');
}
function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

const log = (m: string): void => {
  console.log(m);
};

await mkdir(DATA, { recursive: true });

console.log('=== Wayfinder GN build-city ===');
console.log(
  `  build area   lat ${BUILD_AREA.minLat}..${BUILD_AREA.maxLat} lon ${BUILD_AREA.minLon}..${BUILD_AREA.maxLon}`,
);
console.log(`  derived from OSM relation ${BOUNDARY_RELATION.id} (${BOUNDARY_RELATION.name})`);

const lock = await readLock();
const extracts: ClipExtractInput[] = lock.extracts.map((e) => ({
  name: e.name,
  localPath: e.localPath,
  md5: e.md5,
}));
for (const e of lock.extracts) {
  console.log(`  extract      ${e.name}  ${mb(e.bytes)}  md5 ${e.md5}  ${e.lastModified}`);
}

// ---- Stage 1: clip, merge, dedupe ----
console.log('\n--- stage 1: clip to BUILD_AREA, merge both extracts, dedupe by element id ---');
const tClip = performance.now();
const { clipped, fromCache } = await loadOrBuildClip(extracts, CLIP_CACHE, log);
const clipWall = (performance.now() - tClip) / 1000;
const cs = clipped.stats;

console.log(`\n  source                  ${fromCache ? 'clip cache' : 'full decode of both extracts'}`);
for (const f of cs.perFile) {
  console.log(
    `  ${f.name.padEnd(14)} read ${n(f.nodesRead).padStart(12)} nodes, ` +
      `${n(f.nodesInArea).padStart(9)} in area, ${n(f.waysTouchingArea).padStart(7)} ways kept`,
  );
}
console.log(`  nodes in area, summed   ${n(cs.nodesInAreaSummed)}`);
console.log(`  nodes in area, union    ${n(cs.nodesInAreaUnion)}   <- deduped, the real figure`);
console.log(`  seam overlap nodes      ${n(cs.seamOverlapNodes)}   <- summed minus union`);
console.log(
  `  duplicates dropped      nodes ${n(cs.duplicates.nodes)}, ways ${n(cs.duplicates.ways)}, ` +
    `relations ${n(cs.duplicates.relations)}`,
);
console.log(`  extra nodes for ways    ${n(cs.extraNodesForCompleteWays)}   <- outside area, kept so roads are not severed`);
console.log(`  kept                    ${n(cs.keptNodes)} nodes, ${n(cs.keptWays)} ways (${n(cs.keptWaysWithHighway)} with highway), ${n(cs.keptRelations)} relations`);
console.log(`  relations outside area  ${n(cs.relationsOutsideArea)}   <- tag-matched but spatially rejected`);
console.log(`  nested relation members ${n(cs.nestedRelationMembers)}   <- blind spot in the spatial filter`);
console.log(`  restriction relations   ${n(cs.keptRestrictions)}   <- touching the build area`);
if (!fromCache) {
  console.log(`  pass 1 / pass 2 / write ${cs.pass1Seconds}s / ${cs.pass2Seconds}s / ${cs.writeSeconds}s`);
  console.log(`  clip peak RSS           ${mb(cs.peakRssBytes)}`);
}
console.log(`  clip cache              ${mb(cs.cacheBytes)}`);
console.log(`  stage wall time         ${clipWall.toFixed(1)} s`);

// hard-rules.md § Build and data: the Central/Northern seam crosses the western edge of the
// build area, so overlapping elements are guaranteed. Zero means the dedupe did not run.
if (cs.duplicates.nodes === 0) {
  console.error(
    '\nFAIL: zero duplicate nodes across two overlapping extracts. The seam is real and ' +
      'crosses the western edge of BUILD_AREA, so this means the dedupe did not run.',
  );
  process.exit(1);
}
if (cs.duplicates.ways === 0) {
  console.error(
    '\nFAIL: zero duplicate ways. Geofabrik cuts zones with complete ways, so a way whose ' +
      'nodes straddle the seam must appear in both files.',
  );
  process.exit(1);
}

// A count proves the dedupe ran. A NAMED way that arrived twice, present exactly once, proves
// it ran correctly. This is the seam assertion in the strongest form the data allows.
console.log('\n  seam dedupe check, against real duplicated ways:');
if (cs.sampleDuplicateWayIds.length === 0) {
  console.error('FAIL: duplicate ways were counted but none was sampled. The sampler is broken.');
  process.exit(1);
}
for (const dupId of cs.sampleDuplicateWayIds.slice(0, 5)) {
  const matches = clipped.ways.filter((w) => w.id === dupId);
  if (matches.length !== 1) {
    console.error(`FAIL: way ${dupId} arrived twice and is present ${matches.length} times, expected exactly 1.`);
    process.exit(1);
  }
  const w = matches[0] as (typeof clipped.ways)[number];
  console.log(
    `    way ${dupId} arrived twice, kept once: highway=${w.tags.get('highway')} ` +
      `name=${w.tags.get('name') ?? '(unnamed)'} refs=${w.refs.length}`,
  );
}

// ---- Stage 1b: cache round-trip check ----
if (!fromCache) {
  console.log('\n--- stage 1b: verify the cache reads back identically ---');
  const bytes = await stat(CLIP_CACHE);
  const reparsed = parseClip(new Uint8Array(await readFile(CLIP_CACHE)), clipCacheKey(extracts));
  const same =
    reparsed.nodeIds.length === clipped.nodeIds.length &&
    reparsed.ways.length === clipped.ways.length &&
    reparsed.relations.length === clipped.relations.length;
  if (!same) {
    console.error('FAIL: the clip cache does not read back with the same counts it was written with.');
    process.exit(1);
  }
  // Spot check content, not just counts: matching counts with shifted contents is exactly the
  // failure a string-table drift would produce.
  const lastWay = clipped.ways[clipped.ways.length - 1];
  const lastReparsed = reparsed.ways[reparsed.ways.length - 1];
  if (lastWay?.id !== lastReparsed?.id || lastWay?.refs.length !== lastReparsed?.refs.length) {
    console.error('FAIL: the last way differs after a cache round-trip.');
    process.exit(1);
  }
  console.log(`  round-trip OK: ${mb(bytes.size)}, counts and last way match`);
}

// ---- Stage 2: graph ----
console.log('\n--- stage 2: routing graph ---');
const graph = buildGraph(clipped, log);
const gs = graph.stats;
console.log(`\n  clipped ways            ${n(gs.clippedWays)}`);
console.log(`  drivable ways           ${n(gs.drivableWays)}`);
console.log(`  skipped, not drivable   ${n(gs.waysSkippedNotDrivable)}`);
console.log(`  skipped, under 2 nodes  ${n(gs.waysSkippedTooShort)}`);
console.log(`  dangling node refs      ${n(gs.missingNodeRefs)} across ${n(gs.waysWithMissingRefs)} ways`);
console.log(`  VERTICES before SCC     ${n(gs.verticesBeforeScc)}`);
console.log(`  EDGES before SCC        ${n(gs.edgesBeforeScc)}`);
console.log(`  SCC components          ${n(gs.sccCount)}`);
console.log(`  largest SCC coverage    ${pct(gs.largestSccShare)}`);
console.log(`  VERTICES after SCC      ${n(gs.verticesAfterScc)}   <- the CH-relevant number`);
console.log(`  EDGES after SCC         ${n(gs.edgesAfterScc)}`);
console.log(`  shape points            ${n(gs.shapePoints)}`);
console.log(`  one-way segments        ${n(gs.onewayEdges)}`);
console.log(`  bidirectional ways      ${n(gs.bidirectionalWays)}`);
console.log(`  speed from maxspeed     ${n(gs.speedFromTag)}`);
console.log(`  speed from class table  ${n(gs.speedFromClassDefault)}   <- ESTIMATES until gate 4`);
console.log(`  private-access ways     ${n(gs.privateAccessWays)}`);
console.log(`  total drivable length   ${gs.totalLengthKm.toFixed(0)} km`);
console.log(`  graph build time        ${gs.buildSeconds} s`);
console.log(`  graph peak RSS          ${mb(gs.peakRssBytes)}`);

// ---- Stage 3: turn restrictions ----
console.log('\n--- stage 3: turn restrictions ---');
const vertexOfNodeId = new Map<number, number>();
for (let v = 0; v < graph.vertexNodeId.length; v++) {
  vertexOfNodeId.set(graph.vertexNodeId[v] as number, v);
}
const turns = buildTurnTable(graph, clipped.relations, vertexOfNodeId, clipped);
const rs = turns.stats;
console.log(`  restriction relations   ${n(rs.relationsSeen)}   <- in the clipped area`);
console.log(`  resolved                ${n(rs.resolved)}`);
console.log(`  banned turn pairs       ${n(rs.bannedTurnPairs)}`);
console.log(`  approaches with a ban   ${n(turns.banned.size)}`);
console.log(`  correctly ignored       ${n(rs.correctlyIgnored)}   <- cannot permit an illegal turn`);
console.log(`  NOT HONOURED            ${n(rs.notHonoured)}   <- real prohibitions we failed to apply (charter item 7)`);
console.log(`  "except" tags seen      ${n(rs.exceptTagsSeen)}   <- not yet applied per vehicle class`);

if (rs.unresolved.length > 0) {
  console.log('\n  every unresolved restriction, by reason:');
  for (const [reason, count] of Object.entries(rs.byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason.padEnd(34)} ${String(count).padStart(3)}`);
  }
  console.log('\n  relation by relation:');
  for (const u of rs.unresolved) {
    const flag = u.verdict === 'not-honoured' ? 'NOT HONOURED  ' : 'ignored       ';
    console.log(`    ${flag} r${u.relationId} ${u.kind}`);
    console.log(`                   ${u.detail}`);
  }
}

// ---- Stage 3b: places index, the third derivative ----
console.log('\n--- stage 3b: places index ---');
const places = buildPlaces(clipped);
const pl = places.stats;
console.log(`  places total            ${n(pl.total)}`);
console.log(`  from nodes / ways / rel ${n(pl.fromNodes)} / ${n(pl.fromWays)} / ${n(pl.fromRelations)}`);
console.log(`  settlements             ${n(pl.settlements)}`);
console.log(`  POIs                    ${n(pl.pois)}`);
console.log(`  named roads             ${n(pl.namedRoads)}   <- ${n(pl.roadWaysCollapsed)} extra OSM ways collapsed into them`);
console.log(`  names with Devanagari   ${n(pl.withDevanagariName)}`);
console.log(`  distinct normalised     ${n(pl.distinctNormalisedNames)}`);
console.log(`  build time              ${pl.buildSeconds} s`);
await writeFile(
  resolve(DATA, 'places.json'),
  JSON.stringify({ builtAt: new Date().toISOString(), stats: pl, places: places.places }),
  'utf8',
);
const placesBytes = (await stat(resolve(DATA, 'places.json'))).size;
console.log(`  wrote data/places.json  ${mb(placesBytes)}`);

// ---- Stage 3c: SDF glyph ranges, generated offline from vendored fonts ----
console.log('\n--- stage 3c: SDF glyph ranges ---');
{
  const fontDir = resolve(import.meta.dirname, '../../vendor/fonts');
  const faces = [
    { name: 'NotoSans-Regular', font: await loadFace(resolve(fontDir, 'NotoSans-Regular.ttf')) },
    { name: 'NotoSansDevanagari-Regular', font: await loadFace(resolve(fontDir, 'NotoSansDevanagari-Regular.ttf')) },
    // Urdu is an additional official language of Uttar Pradesh, so Arabic script here is a
    // local script, not a foreign one.
    { name: 'NotoNaskhArabic-Regular', font: await loadFace(resolve(fontDir, 'NotoNaskhArabic-Regular.ttf')) },
  ];

  // COVERAGE IS DERIVED FROM THE DATA, not from a guessed codepoint list. Every codepoint that
  // appears in any indexed place name must have a glyph, or that label renders as blank boxes.
  const needed = new Set<number>();
  for (let cp = 0x20; cp < 0x7f; cp++) needed.add(cp); // ASCII always, for ref shields and numerals
  for (const p of places.places) {
    for (const ch of p.name) needed.add(ch.codePointAt(0) as number);
  }

  const { ranges, stats: gstats } = buildRanges('Noto Sans Regular', faces, needed);
  const outDir = resolve(DATA, 'fonts', 'Noto Sans Regular');
  await mkdir(outDir, { recursive: true });
  for (const [label, bytes] of ranges) await writeFile(resolve(outDir, `${label}.pbf`), bytes);

  console.log(`  fontstack               ${gstats.stackName}`);
  console.log(`  faces                   ${gstats.faces.join(' + ')}`);
  console.log(`  codepoints in index     ${n(gstats.codepointsRequested)}`);
  console.log(`  glyphs rendered         ${n(gstats.glyphsRendered)}`);
  console.log(`  ranges written          ${n(gstats.rangesWritten)}  (${mb(gstats.totalBytes)})`);
  console.log(`  build time              ${gstats.seconds} s`);

  // THE ASSERTION, split by whether the gap is an oversight or a scope decision.
  // In a supported script: a missing glyph means a face is absent or wrong. Hard failure.
  // Outside them: reported in full, with the characters, as a stated limit rather than a pass.
  const show = (cps: readonly number[]): string =>
    cps
      .slice(0, 40)
      .map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')} ${String.fromCodePoint(cp)}`)
      .join(', ') + (cps.length > 40 ? ', ...' : '');

  const missingSupported = gstats.codepointsMissing.filter(isSupportedScript);
  const missingUnsupported = gstats.codepointsMissing.filter((cp) => !isSupportedScript(cp));

  console.log(`  scripts supported       ${SUPPORTED_SCRIPTS.map((s) => s.name).join(', ')}`);
  if (missingUnsupported.length > 0) {
    console.log(
      `  outside those scripts   ${n(missingUnsupported.length)} codepoint(s), which will render as blank boxes:`,
    );
    console.log(`    ${show(missingUnsupported)}`);
  }
  if (missingSupported.length > 0) {
    console.error(
      `\nFAIL: ${missingSupported.length} codepoint(s) in a SUPPORTED script have no glyph, ` +
        `so a vendored face is missing or wrong.`,
    );
    console.error(`  ${show(missingSupported)}`);
    process.exit(1);
  }
  console.log('  coverage                every codepoint in a supported script has a glyph');
}

// ---- Stage 4: write the clipped subset back out as a PBF, for tilemaker ----
console.log('\n--- stage 4: clipped subset to .osm.pbf (one source, three derivatives) ---');
const { bytes: pbfBytes, stats: ps } = writeClipAsPbf(clipped);
await writeFile(CLIP_PBF, pbfBytes);
console.log(`  wrote ${n(ps.bytes)} bytes (${mb(ps.bytes)}) in ${ps.seconds} s, ${n(ps.blocks)} blobs`);
console.log(`  nodes ${n(ps.nodes)}, ways ${n(ps.ways)}, relations ${n(ps.relations)}`);
console.log(`  dangling refs dropped   ${n(ps.danglingRefsDropped)} (kept the file self-consistent)`);
console.log(`  ways dropped, under 2   ${n(ps.waysDroppedTooShort)}`);
console.log(`  vs raw extracts         ${mb(lock.extracts.reduce((a, e) => a + e.bytes, 0))} -> ${mb(ps.bytes)}`);

// The PBF must be readable by our own decoder before tilemaker is trusted with it. A writer
// verified only by the consumer that accepts it is a writer with no test at all.
console.log('\n  round-tripping the written PBF through our own decoder:');
{
  const { readOsmPbf, readOsmPbfHeader } = await import('./pbf/osmpbf.ts');
  const hdr = await readOsmPbfHeader(CLIP_PBF);
  console.log(
    `    header bbox lat ${hdr.bbox?.minLat.toFixed(6)}..${hdr.bbox?.maxLat.toFixed(6)} ` +
      `lon ${hdr.bbox?.minLon.toFixed(6)}..${hdr.bbox?.maxLon.toFixed(6)}`,
  );
  console.log(`    features ${hdr.features.join(', ')}`);
  let rn = 0;
  let rw = 0;
  let rr = 0;
  for await (const el of readOsmPbf(CLIP_PBF)) {
    if (el.kind === 'node') rn++;
    else if (el.kind === 'way') rw++;
    else rr++;
  }
  console.log(`    read back nodes ${n(rn)}, ways ${n(rw)}, relations ${n(rr)}`);
  if (rn !== ps.nodes || rw !== ps.ways || rr !== ps.relations) {
    console.error('FAIL: the PBF we wrote does not read back with the counts we wrote.');
    process.exit(1);
  }
  console.log('    round-trip OK');
}

// ---- Stage 5: vector tiles ----
let tiles: Awaited<ReturnType<typeof buildTiles>> | null = null;
if (SKIP_TILES) {
  console.log('\n--- stage 5: tiles SKIPPED (BUILD_SKIP_TILES=1) ---');
} else {
  console.log('\n--- stage 5: vector tiles via tilemaker ---');
  tiles = await buildTiles(CLIP_PBF, PMTILES, DATA, log);
  console.log(`\n  exit code               ${tiles.exitCode}`);
  console.log(`  tilemaker wall time     ${tiles.tilemakerSeconds} s`);
  console.log(`  tilemaker peak RSS      ${mb(tiles.tilemakerPeakRssBytes)}`);
  if (tiles.pmtiles) {
    const p = tiles.pmtiles;
    console.log(`  tiles generated         ${n(p.tilesFound)} (z${p.minZoom}..z${p.maxZoom})`);
    console.log(`  unique tile bodies      ${n(p.uniqueTiles)}, ${n(p.duplicateTilesShared)} shared`);
    console.log(`  root directory          ${n(p.rootDirectoryBytes)} bytes, gzipped, no leaves`);
    console.log(`  pack time               ${p.seconds} s`);
  }
  console.log(`  .pmtiles size           ${mb(tiles.pmtilesBytes)} (${n(tiles.pmtilesBytes)} bytes)`);
  if (!tiles.ok) {
    console.error('\nFAIL: tilemaker did not produce a .pmtiles. Last stderr:');
    console.error(tiles.stderrTail);
    process.exit(1);
  }
}

// ---- Report ----
const report = {
  builtAt: new Date().toISOString(),
  buildArea: BUILD_AREA,
  boundaryRelation: BOUNDARY_RELATION.id,
  extracts: lock.extracts.map((e) => ({
    name: e.name,
    md5: e.md5,
    bytes: e.bytes,
    lastModified: e.lastModified,
    sourceUrl: e.sourceUrl,
    snapshotUrl: e.snapshotUrl,
  })),
  clip: cs,
  clipFromCache: fromCache,
  graph: gs,
  restrictions: rs,
  places: pl,
  clippedPbf: ps,
  tiles,
};
await writeFile(resolve(DATA, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('\nwrote data/build-report.json');
