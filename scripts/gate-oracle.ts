/**
 * Cross-validates the clip and the places index against an independent oracle. `npm run gate:oracle`.
 *
 * The oracle is `scripts/oracle-places.py`: libosmium's C++ PBF decoder plus Python tag handling.
 * Nothing in it shares code with the pipeline, so a decoder bug, a coordinate bug, a dedupe bug
 * or a name-selection bug shows up as a set difference rather than as a plausible-looking number
 * nobody can check.
 *
 * TWO LAYERS, because they cost three orders of magnitude apart.
 *
 * DEFAULT reads `data/clipped.osm.pbf`, our own written PBF, and validates two real things: that
 * `pbfwrite.ts` emitted what the clip actually holds (libosmium reads the file, and its counts
 * must match the independent `clipped.bin` cache), and that the places rules produce the same
 * index. About six minutes.
 *
 * `--full` ALSO re-derives the clip from the RAW extracts, which validates the selection step
 * itself. It is opt-in because it is 91.5 million Python callbacks: measured at roughly 6,200
 * objects per second, that is some four hours. It has NOT been run to completion, and nothing in
 * this repo claims otherwise.
 *
 * The honest limit of the default layer: it cannot see an element the clip wrongly DROPPED, since
 * it starts from the clip's own output. That gap is exactly what `--full` covers, and it is the
 * reason the flag exists rather than the check being deleted.
 *
 * WHY SET DIFFERENCES AND NOT COUNTS. Two counts can match while naming different elements, which
 * is exactly what a compensating pair of bugs looks like. Every comparison here is over ids or
 * names, and every failure prints the actual symmetric difference, capped for readability but
 * with the true size stated so a truncated list is never mistaken for the whole story.
 *
 * WHAT IT CANNOT CHECK: the keep POLICY. The oracle mirrors the same rules deliberately, so if a
 * rule is wrong both sides are wrong together. This validates execution, not intent.
 *
 * Slow on purpose: it decodes 546 MB of raw extract twice over. It is not part of `npm run gate`.
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BUILD_AREA } from '../config/city.ts';
import { loadOrBuildClip } from '../packages/pipeline/clip/clip.ts';
import { buildPlaces } from '../packages/pipeline/places/build.ts';
import { normalise, hasDevanagari } from '../packages/shared/text.ts';
import { readLock } from './fetch-extracts.ts';

const DATA = resolve(import.meta.dirname, '../data');

interface OraclePlace {
  readonly name: string;
  readonly kind: string;
  readonly category: string;
  readonly importance: number;
}
interface OracleRoad {
  readonly name: string;
  readonly normalised: string;
  readonly category: string;
}
interface Oracle {
  readonly read: { nodes: number; ways: number; relations: number };
  readonly duplicates: { nodes: number; ways: number; relations: number };
  readonly nodesInArea: number;
  readonly waysKept: number;
  readonly relationsKept: number;
  readonly nodePlaces: Record<string, OraclePlace>;
  readonly wayPlaces: Record<string, OraclePlace>;
  readonly relPlaces: Record<string, OraclePlace>;
  readonly roadWays: Record<string, OracleRoad>;
  readonly distinctRoadNames: readonly string[];
  readonly devanagariNonRoad: number;
  readonly devanagariRoadNames: number;
}

const failures: string[] = [];

function check(ok: boolean, label: string, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail !== '') console.log(`        ${detail}`);
  if (!ok) failures.push(label);
}

/** Symmetric difference, reported with its TRUE size even when the printed list is capped. */
function diff(ours: ReadonlySet<string>, theirs: ReadonlySet<string>, cap = 8): string {
  const onlyOurs = [...ours].filter((x) => !theirs.has(x));
  const onlyTheirs = [...theirs].filter((x) => !ours.has(x));
  if (onlyOurs.length === 0 && onlyTheirs.length === 0) {
    return `${ours.size} entries, identical on both sides`;
  }
  const show = (xs: string[]): string =>
    xs.length <= cap ? xs.join(', ') : `${xs.slice(0, cap).join(', ')} (+${xs.length - cap} more)`;
  return `ours only: ${onlyOurs.length} [${show(onlyOurs)}]; oracle only: ${onlyTheirs.length} [${show(onlyTheirs)}]`;
}

function runOracle(paths: readonly string[]): Promise<Oracle> {
  return new Promise((res, rej) => {
    const args = [
      resolve(import.meta.dirname, 'oracle-places.py'),
      JSON.stringify({
        minLat: BUILD_AREA.minLat, maxLat: BUILD_AREA.maxLat,
        minLon: BUILD_AREA.minLon, maxLon: BUILD_AREA.maxLon,
      }),
      ...paths,
    ];
    // UTF-8 forced explicitly. Windows defaults its Python stdio codec to the ANSI code page,
    // which mangles every Devanagari name in transit and would fail this gate for a reason that
    // has nothing to do with the data. Already bitten once in this repo.
    const p = spawn('python', args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => (out += d));
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d: string) => {
      err += d;
      // FORWARDED, not just captured. The oracle prints progress here, and capturing it silently
      // made a 48 minute run indistinguishable from a hung one, which is the exact confusion the
      // progress output was added to prevent.
      process.stderr.write(d);
    });
    p.on('error', (e: Error) => rej(new Error(`could not start python: ${e.message}`)));
    p.on('close', (code: number | null) => {
      if (code !== 0) {
        rej(new Error(`oracle exited ${code}. Is pyosmium installed? \`pip install osmium\`\n${err}`));
        return;
      }
      try {
        res(JSON.parse(out) as Oracle);
      } catch (e) {
        rej(new Error(`oracle emitted unparseable JSON: ${(e as Error).message}\nstderr: ${err}`));
      }
    });
  });
}

const FULL = process.argv.includes('--full');
const lock = await readLock();
const paths = FULL
  ? lock.extracts.map((e) => e.localPath)
  : [resolve(DATA, 'clipped.osm.pbf')];

/**
 * The oracle pass is CACHED on the extract checksums.
 *
 * It decodes 91.5 million nodes, which took 2,877 s the first time it completed. A gate that
 * expensive gets run once and then avoided, which is the same as not having it. The cache key is
 * the extract md5s plus a format version, so it invalidates when the data changes or when this
 * script's output shape changes, and never because time passed.
 *
 * Lives in `data/`, which is git-ignored and regenerable by definition. Delete it to force a
 * fresh pass.
 */
const ORACLE_CACHE_VERSION = 3;
const cachePath = resolve(DATA, `oracle-places${FULL ? '-full' : ''}.json`);
const cacheKey = `v${ORACLE_CACHE_VERSION}:${FULL ? 'full' : 'clip'}:${lock.extracts.map((e) => `${e.name}=${e.md5}`).join(',')}`;

console.log('=== places oracle gate ===');
console.log(
  FULL
    ? `  oracle    pyosmium over ${paths.length} RAW extracts, same order as the pipeline`
    : '  oracle    pyosmium over data/clipped.osm.pbf. Add --full to re-derive from raw extracts.',
);

let oracle: Oracle | null = null;
try {
  const cached = JSON.parse(await readFile(cachePath, 'utf8')) as { key: string; oracle: Oracle };
  if (cached.key === cacheKey) {
    oracle = cached.oracle;
    console.log(`  oracle    reusing cached pass, key matches the extract checksums`);
  } else {
    console.log('  oracle    cache is stale (extracts changed), running a fresh pass');
  }
} catch {
  console.log('  oracle    no cached pass, running one now');
}

if (oracle === null) {
  console.log(
    FULL
      ? '  this decodes 546 MB of raw extract at about 6,200 objects/s. Expect HOURS; progress follows.'
      : '  decoding data/clipped.osm.pbf, about six minutes; progress follows.',
  );
  const tOracle = performance.now();
  oracle = await runOracle(paths);
  console.log(
    `  oracle    read ${oracle.read.nodes.toLocaleString('en-US')} nodes, ${oracle.read.ways.toLocaleString('en-US')} ways, ${oracle.read.relations.toLocaleString('en-US')} relations in ${((performance.now() - tOracle) / 1000).toFixed(0)}s`,
  );
  await writeFile(cachePath, JSON.stringify({ key: cacheKey, oracle }), 'utf8');
  console.log(`  oracle    cached to ${cachePath}`);
} else {
  console.log(
    `  oracle    ${oracle.read.nodes.toLocaleString('en-US')} nodes, ${oracle.read.ways.toLocaleString('en-US')} ways, ${oracle.read.relations.toLocaleString('en-US')} relations (from cache)`,
  );
}

const { clipped } = await loadOrBuildClip(
  lock.extracts.map((e) => ({ name: e.name, localPath: e.localPath, md5: e.md5 })),
  resolve(DATA, 'clipped.bin'),
  () => {},
);
const stats = clipped.stats;
const places = buildPlaces(clipped);

// ---------------------------------------------------------------------------
// Clip stage. Checked FIRST: if the clip disagrees, every places difference below is a
// consequence rather than a finding, and reading them the other way round wastes the signal.
// ---------------------------------------------------------------------------
console.log(FULL ? '\n--- clip selection, from raw extracts ---' : '\n--- written PBF vs the clip cache ---');
check(
  stats.nodesInAreaUnion === oracle.nodesInArea,
  FULL ? 'in-area node selection agrees with libosmium' : 'the written PBF holds every node the clip cache does',
  `ours ${stats.nodesInAreaUnion.toLocaleString('en-US')}, oracle ${oracle.nodesInArea.toLocaleString('en-US')}`,
);
check(
  stats.keptWays === oracle.waysKept,
  'kept-way count agrees',
  `ours ${stats.keptWays.toLocaleString('en-US')}, oracle ${oracle.waysKept.toLocaleString('en-US')}`,
);
check(
  stats.keptRelations === oracle.relationsKept,
  'kept-relation count agrees',
  `ours ${stats.keptRelations.toLocaleString('en-US')}, oracle ${oracle.relationsKept.toLocaleString('en-US')}`,
);

if (FULL) {
  check(
    stats.duplicates.nodes === oracle.duplicates.nodes && stats.duplicates.ways === oracle.duplicates.ways,
    'seam duplicate counts agree',
    `ours nodes ${stats.duplicates.nodes.toLocaleString('en-US')} ways ${stats.duplicates.ways.toLocaleString('en-US')}, oracle nodes ${oracle.duplicates.nodes.toLocaleString('en-US')} ways ${oracle.duplicates.ways.toLocaleString('en-US')}`,
  );
  // A zero here is a bug, not a clean run: the Central/Northern seam crosses the build area, so
  // overlapping elements are guaranteed. This is the positive control for the dedupe itself.
  check(
    oracle.duplicates.nodes > 0,
    'the oracle independently sees the seam overlap (control for the dedupe)',
    `${oracle.duplicates.nodes.toLocaleString('en-US')} duplicate node ids seen by libosmium`,
  );
} else {
  // Deliberately NOT checked in the default mode, and said out loud rather than quietly skipped.
  // The clip already deduped, so a zero here would be correct and would prove nothing about
  // whether the dedupe ran. Only `--full` can test that, because only it sees both extracts.
  console.log('  SKIP  seam dedupe: the written PBF is already deduped. Use --full to test it.');
  check(
    oracle.duplicates.nodes === 0,
    'no duplicate ids survive into the written PBF',
    `${oracle.duplicates.nodes} duplicate node ids, ${oracle.duplicates.ways} duplicate way ids`,
  );
}

// ---------------------------------------------------------------------------
// Places stage.
// ---------------------------------------------------------------------------
console.log('\n--- places index ---');

const oracleNonRoad = new Map<string, OraclePlace>();
for (const [id, p] of Object.entries(oracle.nodePlaces)) oracleNonRoad.set(`${id}:${p.kind}:${p.name}`, p);
for (const [id, p] of Object.entries(oracle.wayPlaces)) oracleNonRoad.set(`${id}:${p.kind}:${p.name}`, p);
for (const [id, p] of Object.entries(oracle.relPlaces)) oracleNonRoad.set(`${id}:${p.kind}:${p.name}`, p);

const ourNonRoad = new Set<string>();
const ourRoadNames = new Set<string>();
for (const p of places.places) {
  if (p.kind === 'highway') ourRoadNames.add(normalise(p.name));
  else ourNonRoad.add(`${p.id}:${p.kind}:${p.name}`);
}

check(
  ourNonRoad.size === oracleNonRoad.size &&
    [...ourNonRoad].every((k) => oracleNonRoad.has(k)),
  'every non-road place matches by id, kind and name',
  diff(ourNonRoad, new Set(oracleNonRoad.keys())),
);

// Roads are compared by NAME, not by id: one road is one place on our side, so our entries are
// clusters of ways while the oracle's are individual ways. The name set is the thing that must
// agree; the collapse ratio is reported so a clustering change is visible rather than silent.
check(
  ourRoadNames.size === oracle.distinctRoadNames.length &&
    oracle.distinctRoadNames.every((n) => ourRoadNames.has(n)),
  'named-road name set matches',
  diff(ourRoadNames, new Set(oracle.distinctRoadNames)),
);
console.log(
  `        ${Object.keys(oracle.roadWays).length.toLocaleString('en-US')} named road ways collapse to ${places.stats.namedRoads.toLocaleString('en-US')} road places across ${ourRoadNames.size.toLocaleString('en-US')} distinct names`,
);

// Counted SEPARATELY for roads and non-roads. One road is one place on our side and one entry per
// way on the oracle's, so a single combined total can never match and comparing them produced a
// failure that was purely this gate's own arithmetic.
{
  let ourNonRoad = 0;
  const ourRoadDevanagari = new Set<string>();
  for (const p of places.places) {
    if (!hasDevanagari(p.name)) continue;
    if (p.kind === 'highway') ourRoadDevanagari.add(normalise(p.name));
    else ourNonRoad++;
  }
  check(
    ourNonRoad === oracle.devanagariNonRoad,
    'Devanagari-named NON-ROAD place count agrees',
    `ours ${ourNonRoad}, oracle ${oracle.devanagariNonRoad}`,
  );
  check(
    ourRoadDevanagari.size === oracle.devanagariRoadNames,
    'Devanagari-named distinct ROAD name count agrees',
    `ours ${ourRoadDevanagari.size}, oracle ${oracle.devanagariRoadNames}`,
  );
  // Positive control: a zero on both sides would also "agree" if the encoding path had eaten
  // every non-Latin name, which on Windows is a real failure mode rather than a hypothetical.
  check(
    oracle.devanagariNonRoad + oracle.devanagariRoadNames > 0,
    'the oracle independently reads Devanagari names (control for the encoding path)',
    `${oracle.devanagariNonRoad} non-road and ${oracle.devanagariRoadNames} road names carrying U+0900..U+097F survived the Python to Node hop`,
  );
}

console.log('');
if (failures.length > 0) {
  console.error(`places oracle gate FAIL: ${failures.length} check(s) failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('places oracle gate PASS: the clip and the places index agree with libosmium');
