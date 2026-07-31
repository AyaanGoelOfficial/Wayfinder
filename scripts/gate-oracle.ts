/**
 * Cross-validates the clip and the places index against an independent oracle. `npm run gate:oracle`.
 *
 * The oracle is `scripts/oracle-places.py`: libosmium's C++ PBF decoder plus Python tag handling,
 * reading the RAW extracts. Nothing in it shares code with the pipeline, so a decoder bug, a
 * coordinate bug, a dedupe bug or a name-selection bug shows up as a set difference rather than
 * as a plausible-looking number nobody can check.
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
  readonly withDevanagariName: number;
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

const lock = await readLock();
const paths = lock.extracts.map((e) => e.localPath);

console.log('=== places oracle gate ===');
console.log(`  oracle    pyosmium over ${paths.length} raw extracts, same order as the pipeline`);
console.log('  this decodes 546 MB of raw extract, so it takes minutes rather than seconds');

const tOracle = performance.now();
const oracle = await runOracle(paths);
console.log(`  oracle    read ${oracle.read.nodes.toLocaleString('en-US')} nodes, ${oracle.read.ways.toLocaleString('en-US')} ways, ${oracle.read.relations.toLocaleString('en-US')} relations in ${((performance.now() - tOracle) / 1000).toFixed(0)}s`);

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
console.log('\n--- clip stage ---');
check(
  stats.nodesInAreaUnion === oracle.nodesInArea,
  'in-area node count agrees with libosmium',
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

check(
  places.stats.withDevanagariName === oracle.withDevanagariName,
  'Devanagari-named place count agrees',
  `ours ${places.stats.withDevanagariName}, oracle ${oracle.withDevanagariName}`,
);
// Positive control for that count: a zero would also "agree" if both sides dropped every
// non-Latin name, and the encoding trap on Windows makes that a real failure mode.
check(
  oracle.withDevanagariName > 0,
  'the oracle independently reads Devanagari names (control for the encoding path)',
  `${oracle.withDevanagariName} names carrying U+0900..U+097F survived the Python to Node hop`,
);

console.log('');
if (failures.length > 0) {
  console.error(`places oracle gate FAIL: ${failures.length} check(s) failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('places oracle gate PASS: the clip and the places index agree with libosmium');
