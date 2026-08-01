/**
 * What do the mappers say the speed limit is, per highway class? `npm run calibrate:speeds`.
 *
 * WHY THIS EXISTS. `CLASS_SPEED_KMH` in `packages/pipeline/graph/profile.ts` was written as a
 * judgement call: below legal limits, targeting real travel speed on Greater Noida roads
 * including signals, autos, cattle and unmarked speed breakers. That intent is right. The
 * problem gate 4 exposed is that it was applied UNEVENLY. If motorway keeps 90 out of a 100
 * limit while secondary keeps 40 out of a 60, the table is not "conservative", it is a table
 * with a hidden 2:1 bias toward motorways, and the router will spend 12 km of detour to reach
 * one. That is a route-SHAPE decision hiding inside numbers that each look reasonable alone.
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT. It reports the distribution of PARSEABLE `maxspeed`
 * tags per class, from our own clipped extract. That is the LEGAL LIMIT, not a travel speed, and
 * the two are not the same number: nobody averages the limit through a village. So this does not
 * produce the table. It produces the RATIOS between classes, plus the implied discount each
 * current default is taking against its own class limit, so the discount can be made deliberate
 * and uniform instead of accidental and per class.
 *
 * WHY NOT JUST COPY OSRM's car.lua. Because OSRM is a reference, not an oracle, and its profile
 * is tuned for a different road network. Its numbers would be as unexamined here as ours were.
 * This uses the tags on the roads we actually route over.
 *
 * SAMPLE SIZE IS REPORTED PER CLASS AND IS LOAD BEARING. Only 1,773 of 121,084 drivable ways
 * here carry a parseable maxspeed. A class with a handful of tagged ways cannot calibrate
 * anything, and this prints the count beside every median so a number resting on four samples is
 * visibly not evidence.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadOrBuildClip, scaledToDeg } from '../packages/pipeline/clip/clip.ts';
import { CLASS_SPEED_KMH, classifyWay, parseMaxspeed } from '../packages/pipeline/graph/profile.ts';
import { haversineM } from '../packages/shared/geo.ts';
import { readLock } from './fetch-extracts.ts';

const DATA = resolve(import.meta.dirname, '../data');

const lock = await readLock();
const { clipped } = await loadOrBuildClip(
  lock.extracts.map((e) => ({ name: e.name, localPath: e.localPath, md5: e.md5 })),
  resolve(DATA, 'clipped.bin'),
  () => {},
);

interface Bucket {
  /** Every parseable tagged limit on this class, one entry per way. */
  readonly tagged: number[];
  /** Metres of road in this class, tagged or not. Shows what the class is worth to a route. */
  metres: number;
  taggedMetres: number;
  ways: number;
}
const buckets = new Map<string, Bucket>();

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

for (const w of clipped.ways) {
  const cls = classifyWay(w.tags);
  if (!cls.drivable) continue;
  const highway = cls.highway;
  let b = buckets.get(highway);
  if (b === undefined) {
    b = { tagged: [], metres: 0, taggedMetres: 0, ways: 0 };
    buckets.set(highway, b);
  }
  const m = lengthOf(w.refs);
  b.metres += m;
  b.ways++;
  const tagged = parseMaxspeed(w.tags.get('maxspeed'));
  if (tagged !== undefined) {
    b.tagged.push(tagged);
    b.taggedMetres += m;
  }
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) / 2;
  return Number.isInteger(i)
    ? (s[i] as number)
    : ((s[Math.floor(i)] as number) + (s[Math.ceil(i)] as number)) / 2;
}

console.log('=== class speed calibration, from tagged maxspeed in our own clip ===\n');
console.log('The median is the LEGAL LIMIT mappers recorded, not a travel speed. The last column');
console.log('is what our current default keeps of that limit: the discount we are already taking.');
console.log('A discount that varies wildly by class is a route-shape bias, not conservatism.\n');
console.log(
  `  ${'class'.padEnd(16)}${'ways'.padStart(8)}${'tagged'.padStart(8)}${'km'.padStart(10)}` +
    `${'median'.padStart(8)}${'p25'.padStart(6)}${'p75'.padStart(6)}${'ours'.padStart(7)}${'keeps'.padStart(8)}`,
);

const order = Object.keys(CLASS_SPEED_KMH);
for (const cls of order) {
  const b = buckets.get(cls);
  if (b === undefined) {
    console.log(`  ${cls.padEnd(16)}${'0'.padStart(8)}  (absent from the clip)`);
    continue;
  }
  const s = [...b.tagged].sort((x, y) => x - y);
  const med = median(s);
  const q = (p: number): string =>
    s.length === 0 ? '-' : (s[Math.min(s.length - 1, Math.floor(p * s.length))] as number).toFixed(0);
  const ours = CLASS_SPEED_KMH[cls] as number;
  const keeps = Number.isNaN(med) ? '-' : `${Math.round((ours / med) * 100)}%`;
  console.log(
    `  ${cls.padEnd(16)}${b.ways.toLocaleString('en-US').padStart(8)}${s.length.toString().padStart(8)}` +
      `${(b.metres / 1000).toFixed(0).padStart(10)}${(Number.isNaN(med) ? '-' : med.toFixed(0)).padStart(8)}` +
      `${q(0.25).padStart(6)}${q(0.75).padStart(6)}${ours.toFixed(0).padStart(7)}${keeps.padStart(8)}`,
  );
}

const totalTagged = [...buckets.values()].reduce((a, b) => a + b.tagged.length, 0);
const totalWays = [...buckets.values()].reduce((a, b) => a + b.ways, 0);
console.log(
  `\n  ${totalTagged.toLocaleString('en-US')} of ${totalWays.toLocaleString('en-US')} drivable ways carry a parseable maxspeed ` +
    `(${((totalTagged / totalWays) * 100).toFixed(1)}%).`,
);
console.log('  Any class whose tagged count is small cannot calibrate anything. Read the count first.');
