/**
 * How rough are these roads, according to the mappers? `npm run calibrate:quality`.
 *
 * WHY THIS EXISTS. The objective gained a road QUALITY term, and a quality term needs a source.
 * The preferred source is what OSM already knows: `surface`, `smoothness`, and `lanes`. This
 * measures whether that source exists here before anything is derived from it, because a weight
 * table built on 2% coverage is a judgement call wearing measured clothes.
 *
 * THE ANSWER DECIDES THE DERIVATION, not the other way round. If the tags are dense, the class
 * weights in `config/city.ts` come from them. If they are as sparse as `maxspeed` (1,773 of
 * 121,084 drivable ways, 1.46%), they cannot carry a per-class weight and the weights come from a
 * stated judgement instead, with this output as the evidence for why.
 *
 * COVERAGE IS REPORTED TWO WAYS AND BOTH MATTER. By WAY count, and by METRES. A tag present on
 * few ways but on the long ones can still cover most of the network a route actually drives, and
 * a per-way percentage would hide that. Where the two disagree, metres is the one that decides.
 *
 * POSITIVE CONTROL, per hard-rules.md. Any "the tag is not there" claim from this script is
 * printed beside `highway` (present on 100% of drivable ways by construction) and `maxspeed`
 * (independently known to be 1.46% from `npm run calibrate:speeds`), both counted by this same
 * loop. If those two come out at their known values, a low number for `surface` is the data
 * being sparse; if they do not, it is this script being broken.
 */
import { resolve } from 'node:path';
import { loadOrBuildClip, scaledToDeg } from '../packages/pipeline/clip/clip.ts';
import { CLASS_RANK, classifyWay } from '../packages/pipeline/graph/profile.ts';
import { haversineM } from '../packages/shared/geo.ts';
import { readLock } from './fetch-extracts.ts';

const DATA = resolve(import.meta.dirname, '../data');

/** The keys under test, plus the two controls. Order is the print order. */
const KEYS = ['highway', 'maxspeed', 'surface', 'smoothness', 'lanes', 'tracktype'] as const;
const CONTROLS = new Set(['highway', 'maxspeed']);

const lock = await readLock();
const { clipped } = await loadOrBuildClip(
  lock.extracts.map((e) => ({ name: e.name, localPath: e.localPath, md5: e.md5 })),
  resolve(DATA, 'clipped.bin'),
  () => {},
);

const lengthOf = (refs: readonly number[]): number => {
  let m = 0;
  for (let i = 0; i + 1 < refs.length; i++) {
    const ia = clipped.nodeIndex.get(refs[i] as number);
    const ib = clipped.nodeIndex.get(refs[i + 1] as number);
    if (ia < 0 || ib < 0) continue;
    m += haversineM(
      scaledToDeg(clipped.nodeLat[ia] as number),
      scaledToDeg(clipped.nodeLon[ia] as number),
      scaledToDeg(clipped.nodeLat[ib] as number),
      scaledToDeg(clipped.nodeLon[ib] as number),
    );
  }
  return m;
};

interface Cover {
  ways: number;
  metres: number;
}
const overall = new Map<string, Cover>();
for (const k of KEYS) overall.set(k, { ways: 0, metres: 0 });

/** Per class rank, so a tag dense on motorways but absent on tertiary is visible as such. */
const byRank = new Map<number, { ways: number; metres: number; cover: Map<string, Cover> }>();
/** Value histograms, so a dense tag can actually be READ, not just counted. */
const values = new Map<string, Map<string, number>>();
for (const k of KEYS) values.set(k, new Map());

let drivableWays = 0;
let drivableMetres = 0;

for (const w of clipped.ways) {
  const cls = classifyWay(w.tags);
  if (!cls.drivable) continue;
  const m = lengthOf(w.refs);
  drivableWays++;
  drivableMetres += m;

  const rank = cls.classRank;
  let r = byRank.get(rank);
  if (r === undefined) {
    r = { ways: 0, metres: 0, cover: new Map() };
    for (const k of KEYS) r.cover.set(k, { ways: 0, metres: 0 });
    byRank.set(rank, r);
  }
  r.ways++;
  r.metres += m;

  for (const k of KEYS) {
    const v = w.tags.get(k);
    if (v === undefined) continue;
    const o = overall.get(k) as Cover;
    o.ways++;
    o.metres += m;
    const c = r.cover.get(k) as Cover;
    c.ways++;
    c.metres += m;
    const hist = values.get(k) as Map<string, number>;
    hist.set(v, (hist.get(v) ?? 0) + 1);
  }
}

const RANK_NAME = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service'];
const pct = (n: number, d: number): string => (d === 0 ? '-' : `${((n / d) * 100).toFixed(2)}%`);

console.log('=== road quality tag coverage, from our own clip ===\n');
console.log(`  drivable ways   ${drivableWays.toLocaleString('en-US')}`);
console.log(`  drivable km     ${(drivableMetres / 1000).toFixed(0)}\n`);

console.log('  CONTROLS FIRST. `highway` must read 100% and `maxspeed` about 1.46%, both known');
console.log('  independently. If they do, a low number below is sparse data, not a broken loop.\n');
console.log(`  ${'key'.padEnd(13)}${'ways'.padStart(10)}${'of ways'.padStart(10)}${'km'.padStart(10)}${'of km'.padStart(10)}   role`);
for (const k of KEYS) {
  const c = overall.get(k) as Cover;
  console.log(
    `  ${k.padEnd(13)}${c.ways.toLocaleString('en-US').padStart(10)}${pct(c.ways, drivableWays).padStart(10)}` +
      `${(c.metres / 1000).toFixed(0).padStart(10)}${pct(c.metres, drivableMetres).padStart(10)}` +
      `   ${CONTROLS.has(k) ? 'control' : 'under test'}`,
  );
}

console.log('\n=== coverage by class, in metres. A tag useless overall may still be dense somewhere ===\n');
const testKeys = KEYS.filter((k) => !CONTROLS.has(k));
console.log(`  ${'class'.padEnd(14)}${'km'.padStart(9)}${testKeys.map((k) => k.slice(0, 9).padStart(11)).join('')}`);
for (let rank = 0; rank < RANK_NAME.length; rank++) {
  const r = byRank.get(rank);
  if (r === undefined) {
    console.log(`  ${(RANK_NAME[rank] as string).padEnd(14)}${'0'.padStart(9)}   (absent from the clip)`);
    continue;
  }
  console.log(
    `  ${(RANK_NAME[rank] as string).padEnd(14)}${(r.metres / 1000).toFixed(0).padStart(9)}` +
      testKeys.map((k) => pct((r.cover.get(k) as Cover).metres, r.metres).padStart(11)).join(''),
  );
}

console.log('\n=== what the values actually say, top 8 per key ===\n');
for (const k of testKeys) {
  const hist = values.get(k) as Map<string, number>;
  const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (top.length === 0) {
    console.log(`  ${k}: no values present`);
    continue;
  }
  console.log(`  ${k}: ${top.map(([v, n]) => `${v}=${n.toLocaleString('en-US')}`).join(', ')}`);
}

console.log('\n  CLASS_RANK used above is the same table the graph stores per edge, so these rows');
console.log('  line up with the quality weights in config/city.ts by construction.');
console.log(`  ranks present: ${[...byRank.keys()].sort((a, b) => a - b).join(', ')} of ${new Set(Object.values(CLASS_RANK)).size} defined`);
