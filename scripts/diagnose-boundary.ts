/**
 * Explains a disagreement between our in-area node count and libosmium's.
 *
 * Cross-validation of central-zone matched libosmium exactly on nodes, ways, ways with
 * highway, relations and restrictions, but differed by ONE on nodes inside BUILD_AREA. One
 * node is exactly the signature of a boundary comparison done in floating point rather than
 * an off-by-one in the decode, and this settles which it is instead of assuming.
 *
 * The mechanism: our decoder computes `lat = 1e-9 * (latOffset + granularity * delta)`, while
 * libosmium keeps an int32 at 1e-7 and divides. Neither 1e-9 nor a coordinate like 28.058161
 * is exactly representable in binary, so the two routes to the same number can land one unit
 * in the last place apart. Against an INCLUSIVE bound that happens to fall exactly on a node,
 * one says inside and the other says outside. Both are defensible; both are also arbitrary.
 *
 * The fix is not to pick the luckier comparison. It is to compare in the integer space the
 * data actually lives in: coordinates are exact multiples of 1e-7, and BUILD_AREA is given to
 * six decimals, so scaling both by 1e7 and comparing integers has no rounding step at all.
 *
 *   npm run diagnose:boundary [extract-name]
 */
import { BUILD_AREA } from '../config/city.ts';
import { readOsmPbf } from '../packages/pipeline/pbf/osmpbf.ts';
import { inBuildAreaDegrees, inBuildAreaScaled, toScaled } from '../packages/pipeline/clip/area.ts';

const which = process.argv[2] ?? 'central-zone';
const { readLock } = await import('./fetch-extracts.ts');
const lock = await readLock();
const extract = lock.extracts.find((e) => e.name === which);
if (!extract) {
  console.error(`unknown extract "${which}". Known: ${lock.extracts.map((e) => e.name).join(', ')}`);
  process.exit(1);
}

console.log(`scanning ${extract.name} for boundary disagreements`);
console.log(
  `  BUILD_AREA degrees  lat ${BUILD_AREA.minLat}..${BUILD_AREA.maxLat} lon ${BUILD_AREA.minLon}..${BUILD_AREA.maxLon}`,
);
console.log(
  `  BUILD_AREA scaled   lat ${toScaled(BUILD_AREA.minLat)}..${toScaled(BUILD_AREA.maxLat)} ` +
    `lon ${toScaled(BUILD_AREA.minLon)}..${toScaled(BUILD_AREA.maxLon)}`,
);

let floatIn = 0;
let intIn = 0;
let scanned = 0;
const disagreements: string[] = [];

const t0 = performance.now();
for await (const el of readOsmPbf(extract.localPath)) {
  if (el.kind !== 'node') break; // nodes come first; nothing after them is relevant
  scanned++;
  const f = inBuildAreaDegrees(el.lat, el.lon);
  const i = inBuildAreaScaled(toScaled(el.lat), toScaled(el.lon));
  if (f) floatIn++;
  if (i) intIn++;
  if (f !== i && disagreements.length < 40) {
    disagreements.push(
      `  node ${el.id}  lat ${el.lat.toPrecision(17)} (scaled ${toScaled(el.lat)})  ` +
        `lon ${el.lon.toPrecision(17)} (scaled ${toScaled(el.lon)})  float=${f} int=${i}`,
    );
  }
  if (scanned % 10_000_000 === 0) {
    console.log(`  ${(scanned / 1e6).toFixed(0)}M nodes scanned, float ${floatIn}, int ${intIn}`);
  }
}
const secs = (performance.now() - t0) / 1000;

console.log(`\n  nodes scanned          ${scanned.toLocaleString('en-US')}`);
console.log(`  in area, float compare ${floatIn.toLocaleString('en-US')}`);
console.log(`  in area, int compare   ${intIn.toLocaleString('en-US')}`);
console.log(`  disagreements          ${disagreements.length === 40 ? '40+ (capped)' : disagreements.length}`);
for (const d of disagreements) console.log(d);
console.log(`  wall time              ${secs.toFixed(1)} s`);

if (disagreements.length === 0 && floatIn === intIn) {
  console.log('\n  The two comparisons agree on this file. The count gap is NOT boundary rounding here.');
} else {
  console.log('\n  Boundary rounding confirmed. Integer comparison is the one with no rounding step.');
}
