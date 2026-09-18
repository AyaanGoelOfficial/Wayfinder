/**
 * Derives the live-tracking thresholds from the graph. `npm run calibrate:tracking`.
 *
 * WHY THIS SCRIPT EXISTS. `config/city.ts` carried five tracking numbers written at gate 0 as
 * TARGETS, before there was a graph to check them against. Shipping them unchecked would make
 * them picked constants wearing a comment, which is the one thing this project does not do.
 *
 * THE QUANTITY EVERYTHING DEPENDS ON is how close the two carriageways of a divided road get.
 * Precision charter item 3 is wrong-side snapping, and every threshold in the tracking pipeline
 * is really a statement about that one distance:
 *
 *   the matching corridor  must be narrower than half of it, or the corridor spans both sides
 *   the accuracy ceiling   must be under half of it, or the fix cannot tell the sides apart
 *   the off-route trigger  must be wider than the corridor, or ordinary driving reads as departure
 *
 * So it is measured here, over the real clip, rather than assumed.
 *
 * A DIVIDED ROAD IS TWO DIFFERENT ONE-WAY WAYS running antiparallel and close together. The two
 * directed edges of an ordinary two-way street are NOT that: they share one shape run and one way
 * id, and counting them would report a separation of zero for every residential street in the
 * district and make the whole measurement meaningless.
 */
import { resolve } from 'node:path';
import { BUILD_AREA, SNAP_TRACKING_M } from '../config/city.ts';
import { loadOrBuildClip } from '../packages/pipeline/clip/clip.ts';
import { buildGraph } from '../packages/pipeline/graph/build.ts';
import { haversineM } from '../packages/shared/geo.ts';
import { readLock } from './fetch-extracts.ts';

const DATA = resolve(import.meta.dirname, '../data');

/** Antiparallel means opposed within this many degrees. Two carriageways are never exactly 180. */
const ANTIPARALLEL_TOLERANCE_DEG = 30;
/** Look no further than this for an opposing carriageway. Beyond it they are separate roads. */
const SEARCH_RADIUS_M = 120;
/** Grid cell edge, in metres. One cell plus its ring must cover SEARCH_RADIUS_M. */
const CELL_M = 125;

const lock = await readLock();
const { clipped } = await loadOrBuildClip(
  lock.extracts.map((e) => ({ name: e.name, localPath: e.localPath, md5: e.md5 })),
  resolve(DATA, 'clipped.bin'),
  () => {},
);
const g = buildGraph(clipped);

const E = g.edgeFrom.length;
console.log('=== tracking threshold derivation ===');
console.log(
  `  graph  ${g.stats.verticesAfterScc.toLocaleString('en-US')} vertices, ${E.toLocaleString('en-US')} directed edges\n`,
);

// ---------------------------------------------------------------------------
// 1. Which shapes are genuinely one-way
// ---------------------------------------------------------------------------
// A two-way street emits two directed edges over the SAME shape run, one of them with
// edgeReversed set. A one-way street emits one. So a shape seen under both reversal flags is
// bidirectional, and a shape seen under exactly one is a one-way carriageway.
const reversalFlagsByShape = new Map<number, number>();
for (let e = 0; e < E; e++) {
  const shape = g.edgeShape[e] as number;
  const bit = 1 << (g.edgeReversed[e] as number);
  reversalFlagsByShape.set(shape, (reversalFlagsByShape.get(shape) ?? 0) | bit);
}
let oneWayEdges = 0;
let twoWayEdges = 0;
for (let e = 0; e < E; e++) {
  if (reversalFlagsByShape.get(g.edgeShape[e] as number) === 3) twoWayEdges++;
  else oneWayEdges++;
}
console.log('  carriageway census');
console.log(`    one-way directed edges   ${oneWayEdges.toLocaleString('en-US')}`);
console.log(
  `    two-way directed edges   ${twoWayEdges.toLocaleString('en-US')}  (both directions over one shape)`,
);

// ---------------------------------------------------------------------------
// 2. Sample the one-way network into a grid
// ---------------------------------------------------------------------------
const DEG_TO_RAD = Math.PI / 180;
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG_TO_RAD;
  const p2 = lat2 * DEG_TO_RAD;
  const dl = (lon2 - lon1) * DEG_TO_RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
function bearingGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const latSpanM = haversineM(BUILD_AREA.minLat, BUILD_AREA.minLon, BUILD_AREA.maxLat, BUILD_AREA.minLon);
const lonSpanM = haversineM(BUILD_AREA.minLat, BUILD_AREA.minLon, BUILD_AREA.minLat, BUILD_AREA.maxLon);
const rows = Math.max(1, Math.ceil(latSpanM / CELL_M));
const cols = Math.max(1, Math.ceil(lonSpanM / CELL_M));
const latStep = (BUILD_AREA.maxLat - BUILD_AREA.minLat) / rows;
const lonStep = (BUILD_AREA.maxLon - BUILD_AREA.minLon) / cols;

interface Sample {
  lat: number;
  lon: number;
  bearing: number;
  wayId: number;
  /** A roundabout is a one-way circle, so its own far side is antiparallel and close. Confounder. */
  roundabout: boolean;
}
const cells = new Map<number, Sample[]>();
const samples: Sample[] = [];

for (let e = 0; e < E; e++) {
  if (reversalFlagsByShape.get(g.edgeShape[e] as number) === 3) continue; // two-way, not divided
  if (g.edgeReversed[e] === 1) continue; // one direction of the pair is enough for geometry
  const shape = g.edgeShape[e] as number;
  const s0 = g.shapeOffset[shape] as number;
  const s1 = g.shapeOffset[shape + 1] as number;
  const wayId = g.edgeWayId[e] as number;
  const roundabout = g.edgeRoundabout[e] === 1;
  for (let i = s0; i + 1 < s1; i++) {
    const alat = (g.shapeLat[i] as number) / 1e7;
    const alon = (g.shapeLon[i] as number) / 1e7;
    const blat = (g.shapeLat[i + 1] as number) / 1e7;
    const blon = (g.shapeLon[i + 1] as number) / 1e7;
    const mlat = (alat + blat) / 2;
    const mlon = (alon + blon) / 2;
    if (mlat < BUILD_AREA.minLat || mlat > BUILD_AREA.maxLat) continue;
    if (mlon < BUILD_AREA.minLon || mlon > BUILD_AREA.maxLon) continue;
    const smp: Sample = {
      lat: mlat,
      lon: mlon,
      bearing: bearingDeg(alat, alon, blat, blon),
      wayId,
      roundabout,
    };
    samples.push(smp);
    const r = Math.min(rows - 1, Math.max(0, Math.floor((mlat - BUILD_AREA.minLat) / latStep)));
    const c = Math.min(cols - 1, Math.max(0, Math.floor((mlon - BUILD_AREA.minLon) / lonStep)));
    const key = r * cols + c;
    let bucket = cells.get(key);
    if (bucket === undefined) {
      bucket = [];
      cells.set(key, bucket);
    }
    bucket.push(smp);
  }
}
console.log(
  `    one-way segment samples  ${samples.length.toLocaleString('en-US')} in ${cells.size.toLocaleString('en-US')} occupied cells\n`,
);

// ---------------------------------------------------------------------------
// 3. Nearest antiparallel neighbour on a DIFFERENT way
// ---------------------------------------------------------------------------
const separations: number[] = [];
/** The same measurement with roundabout edges removed from BOTH sides. The control. */
const separationsNoCircle: number[] = [];
/**
 * Representative divided-carriageway SITES, for the browser gate's wrong-side scenario.
 *
 * The gate needs a place where two genuinely different one-way ways run antiparallel at a
 * realistic separation. Picking one off a map by eye is how a fixture ends up testing a two-way
 * street's forward and reverse edges, which is a different and much easier thing. These come out
 * of the same measurement as the thresholds, so the fixture and the constant agree by
 * construction. Kept near the median separation: the extreme tail is where OSM is untidy.
 */
const sites: { lat: number; lon: number; bearing: number; otherBearing: number; sepM: number }[] = [];
/** How far apart the two bearings are, for pairs that are close enough to be confusable. */
const headingGapsAtConfusableRange: number[] = [];
let confusableWithinSnapRadius = 0;
let oneWayNonCircle = 0;

for (const s of samples) {
  if (!s.roundabout) oneWayNonCircle++;
  const r = Math.min(rows - 1, Math.max(0, Math.floor((s.lat - BUILD_AREA.minLat) / latStep)));
  const c = Math.min(cols - 1, Math.max(0, Math.floor((s.lon - BUILD_AREA.minLon) / lonStep)));
  let best = Infinity;
  let bestNoCircle = Infinity;
  let bestNoCircleHeadingGap = Number.NaN;
  let bestOtherBearing = Number.NaN;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
      const bucket = cells.get(rr * cols + cc);
      if (bucket === undefined) continue;
      for (const o of bucket) {
        if (o.wayId === s.wayId) continue;
        // Opposed, not merely non-parallel: the gap between the bearings must itself be near 180.
        const gap = bearingGap(s.bearing, o.bearing);
        if (bearingGap(gap, 180) > ANTIPARALLEL_TOLERANCE_DEG) continue;
        const d = haversineM(s.lat, s.lon, o.lat, o.lon);
        if (d > SEARCH_RADIUS_M) continue;
        if (d < best) best = d;
        if (!s.roundabout && !o.roundabout && d < bestNoCircle) {
          bestNoCircle = d;
          bestNoCircleHeadingGap = gap;
          bestOtherBearing = o.bearing;
        }
      }
    }
  }
  if (Number.isFinite(best)) separations.push(best);
  if (Number.isFinite(bestNoCircle)) {
    separationsNoCircle.push(bestNoCircle);
    // SNAP_TRACKING_M is the radius the live matcher searches. An opposing carriageway inside it
    // is a fix the nearest-edge rule could hand to the wrong side. That count IS the exposure.
    if (bestNoCircle <= SNAP_TRACKING_M) {
      confusableWithinSnapRadius++;
      headingGapsAtConfusableRange.push(bestNoCircleHeadingGap);
      // A site is only useful to the gate if the separation is near the median (untidy geometry
      // lives in the tail) and the two ways are close to exactly opposed.
      if (bestNoCircle >= 16 && bestNoCircle <= 24 && bestNoCircleHeadingGap >= 172) {
        sites.push({
          lat: s.lat,
          lon: s.lon,
          bearing: s.bearing,
          otherBearing: bestOtherBearing,
          sepM: bestNoCircle,
        });
      }
    }
  }
}

function report(label: string, xs: number[], denom: number): void {
  const sorted = [...xs].sort((a, b) => a - b);
  const q = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
  console.log(`  ${label}`);
  console.log(
    `    pairs found   ${sorted.length.toLocaleString('en-US')} of ${denom.toLocaleString('en-US')} samples`,
  );
  if (sorted.length === 0) return;
  console.log(`    min           ${(sorted[0] as number).toFixed(2)} m`);
  for (const p of [1, 5, 10, 25, 50, 75, 90]) {
    console.log(`    p${String(p).padStart(2)}           ${q(p).toFixed(2)} m`);
  }
}

report(
  'SEPARATION, all one-way pairs (roundabouts INCLUDED, so contaminated)',
  separations,
  samples.length,
);
console.log('');
report(
  'SEPARATION, roundabout edges excluded from both sides (the real divided carriageways)',
  separationsNoCircle,
  oneWayNonCircle,
);

const pctNc = (p: number): number => {
  const sorted = [...separationsNoCircle].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
};

console.log('\n  WRONG-SIDE EXPOSURE, precision charter item 3');
console.log(
  `    one-way samples with an opposing carriageway inside SNAP_TRACKING_M (${SNAP_TRACKING_M} m):  ` +
    `${confusableWithinSnapRadius.toLocaleString('en-US')} ` +
    `(${((100 * confusableWithinSnapRadius) / Math.max(1, oneWayNonCircle)).toFixed(1)}% of non-circle one-way samples)`,
);
if (headingGapsAtConfusableRange.length > 0) {
  const hs = [...headingGapsAtConfusableRange].sort((a, b) => a - b);
  const hq = (p: number): number => hs[Math.min(hs.length - 1, Math.floor((p / 100) * hs.length))] as number;
  console.log('    bearing gap between the confusable pairs, which is what heading has to separate:');
  console.log(`      min ${(hs[0] as number).toFixed(1)}   p5 ${hq(5).toFixed(1)}   p50 ${hq(50).toFixed(1)}   max ${(hs[hs.length - 1] as number).toFixed(1)} degrees`);
}

// ---------------------------------------------------------------------------
// 4. Speeds, for the implied-speed rejection
// ---------------------------------------------------------------------------
let maxSpeed = 0;
const speedHist = new Map<number, number>();
for (let e = 0; e < E; e++) {
  const v = g.edgeSpeedKmh[e] as number;
  if (v > maxSpeed) maxSpeed = v;
  speedHist.set(v, (speedHist.get(v) ?? 0) + 1);
}
console.log('\n  MODELLED SPEEDS');
console.log(`    fastest edge in the graph  ${maxSpeed} km/h`);
const topSpeeds = [...speedHist.entries()].sort((a, b) => b[0] - a[0]).slice(0, 4);
for (const [v, n] of topSpeeds) {
  console.log(`      ${String(v).padStart(3)} km/h   ${n.toLocaleString('en-US')} edges`);
}

// ---------------------------------------------------------------------------
// 5. Shape point spacing, for interpolation granularity
// ---------------------------------------------------------------------------
const spacings: number[] = [];
for (let shape = 0; shape + 1 < g.shapeOffset.length && spacings.length < 400_000; shape++) {
  const s0 = g.shapeOffset[shape] as number;
  const s1 = g.shapeOffset[shape + 1] as number;
  for (let i = s0; i + 1 < s1; i++) {
    spacings.push(
      haversineM(
        (g.shapeLat[i] as number) / 1e7,
        (g.shapeLon[i] as number) / 1e7,
        (g.shapeLat[i + 1] as number) / 1e7,
        (g.shapeLon[i + 1] as number) / 1e7,
      ),
    );
  }
}
spacings.sort((a, b) => a - b);
const spct = (p: number): number =>
  spacings[Math.min(spacings.length - 1, Math.floor((p / 100) * spacings.length))] as number;
console.log('\n  SHAPE POINT SPACING');
console.log(`    n      ${spacings.length.toLocaleString('en-US')}`);
for (const p of [50, 90, 99]) console.log(`    p${p}    ${spct(p).toFixed(2)} m`);

console.log('\n  DIVIDED CARRIAGEWAY SITES near the median, for the browser gate fixture');
console.log(`    candidates  ${sites.length.toLocaleString('en-US')}`);
// Spread the printed sample across the list rather than taking the first few, which would all
// come from one road: samples are emitted in edge order, so neighbours are the same carriageway.
for (let i = 0; i < Math.min(6, sites.length); i++) {
  const s = sites[Math.floor((i * sites.length) / 6)] as (typeof sites)[number];
  console.log(
    `      [${s.lon.toFixed(7)}, ${s.lat.toFixed(7)}]  travel ${s.bearing.toFixed(1)} deg, ` +
      `opposing ${s.otherBearing.toFixed(1)} deg, ${s.sepM.toFixed(1)} m apart`,
  );
}

console.log('\n=== what these numbers force ===');
if (separationsNoCircle.length > 0) {
  const p1 = pctNc(1);
  const p5 = pctNc(5);
  const p50 = pctNc(50);
  console.log(`  Genuine divided carriageways sit ${p1.toFixed(1)} m apart at p1, ${p5.toFixed(1)} m at p5, ${p50.toFixed(1)} m at the median.`);
  console.log(`  A distance corridor would have to be under ${(p5 / 2).toFixed(1)} m to stay on one side at p5,`);
  console.log('  which is tighter than any consumer GPS fix. DISTANCE CANNOT DISAMBIGUATE CARRIAGEWAYS HERE.');
  console.log('  Heading is therefore the primary discriminator, not a tiebreaker: the confusable pairs are');
  console.log('  opposed by close to 180 degrees, which is the largest signal available anywhere in the data.');
  console.log(`  Implied-speed rejection sits above the fastest modelled edge, ${maxSpeed} km/h.`);
}
