/**
 * Which Gazette toll plaza is each EPE interchange in our graph? `npm run calibrate:epe`.
 *
 * DERIVATION ONLY. Reads and reports; changes no constant. Its OUTPUT is what justifies
 * `EPE_CHAINAGE_AT_CLIP_SOUTH_END_KM` in `config/city.ts`, and re-running it is how a future re-clip
 * proves that anchor still holds.
 *
 * WHY POSITION AND NOT NAME. Gazette S.O. 613(E) names all eleven plazas by village. OSM names
 * three of them, and the villages it does carry sit up to 18 km off the road. Matching a plaza to
 * an interchange by nearest village name is how a clipped map label reading `Old Kasna Road` was
 * really `Old Kasana Road`: it reads as observation and is inference. Chainage is a measurement, so
 * that is what this matches on.
 *
 * THE METHOD:
 *
 *   1. Chain the EPE mainline carriageway in our clip and measure the distance north from its
 *      southern terminus to every interchange on it. That is OUR measurement, in OUR graph, and it
 *      owes nothing to the notification.
 *   2. Fit ONE unknown, the chainage of that terminus, by sliding our measured positions against
 *      the eleven published plaza chainages. The slope is fixed at 1 because both quantities are
 *      kilometres along the same road, so a single number has to explain every interchange at once.
 *   3. NO NAME IS AN INPUT, and neither are the three plazas the earlier audit identified by hand.
 *      They are HELD OUT and used as the test: if position alone reproduces them, the method is
 *      validated on every case we can independently check.
 *
 * A DRIFTING RESIDUAL IS A FAILURE, not something to average away. If one anchor cannot explain
 * every interchange, our carriageway and the Gazette reference line are not measuring the same
 * road, and this script refuses the mapping rather than forcing it.
 */
import { resolve } from 'node:path';
import { EPE_PLAZAS, EPE_CHAINAGE_AT_CLIP_SOUTH_END_KM } from '../config/city.ts';
import { computeEpeChainage, isEpeTagged } from '../packages/pipeline/graph/epe.ts';
import { loadOrBuildClip, scaledToDeg } from '../packages/pipeline/clip/clip.ts';
import { haversineM } from '../packages/shared/geo.ts';
import { readLock } from './fetch-extracts.ts';

const DATA = resolve(import.meta.dirname, '../data');

/**
 * Ramps of one interchange spread over a few hundred metres and a cloverleaf over more than a
 * kilometre, so attachment points are clustered before anything is matched. 2 km is well below the
 * 5.948 km minimum gap between adjacent Gazette plazas, so no clustering choice inside that range
 * can merge two real interchanges.
 */
const CLUSTER_KM = 2.0;

/**
 * The three plazas the earlier audit identified from OSM evidence, HELD OUT of the fit and used
 * only to score it. Coordinates are the booth clusters `npm run audit:epe` reports, re-read from
 * that output rather than recalled.
 */
const HELD_OUT = [
  { label: 'main plaza on the mainline, south end', lat: 28.099401, lon: 77.364035, expect: 'Main Plaza Chhajju Nagar' },
  { label: 'ramp booths beside Beel Akbarpur, NH34', lat: 28.519000, lon: 77.593973, expect: 'Bilakbarpur' },
  { label: 'ramp booths at exit 10, unattributed', lat: 28.437032, lon: 77.585886, expect: 'Fatehpur Rampur' },
] as const;

const lock = await readLock();
const { clipped } = await loadOrBuildClip(
  lock.extracts.map((e) => ({ name: e.name, localPath: e.localPath, md5: e.md5 })),
  resolve(DATA, 'clipped.bin'),
  () => {},
);

const ll = (id: number): { lat: number; lon: number } | null => {
  const i = clipped.nodeIndex.get(id);
  if (i < 0) return null;
  return { lat: scaledToDeg(clipped.nodeLat[i] as number), lon: scaledToDeg(clipped.nodeLon[i] as number) };
};

console.log('=== EPE chainage calibration ===');
console.log('  plaza chainages: Gazette of India S.O. 613(E), 3 February 2025, Ministry of Road Transport and Highways');

const chain = computeEpeChainage(clipped);
console.log(`  mainline carriageways found: ${chain.runKm.length}, lengths ${chain.runKm.map((k) => k.toFixed(3)).join(', ')} km`);
console.log(`  ${chain.mainlineNodes.size} mainline nodes, ${chain.epeNodes.size} EPE nodes including ramps`);
if (!chain.usable) {
  console.log('  REFUSED: the clip holds too little continuous EPE mainline for chainage to mean anything.');
  process.exit(1);
}

// --- interchanges on the mainline -----------------------------------------------------------------
//
// An interchange is where a ramp meets the mainline. Detected as a mainline node that some OTHER
// drivable way also uses. Detecting it from ramps tagged as EPE would miss most of them: the ramps
// at six of our nine attachment sites carry no name and no ref at all.

interface Attach {
  node: number;
  kmFromSouth: number;
  lat: number;
  lon: number;
  via: Set<string>;
}
const attaches: Attach[] = [];
{
  const seen = new Map<number, Set<string>>();
  for (const w of clipped.ways) {
    const h = w.tags.get('highway');
    if (h === undefined) continue;
    if (isEpeTagged(w.tags) && h === 'motorway') continue;
    for (const r of w.refs) {
      if (!chain.mainlineNodes.has(r)) continue;
      let s = seen.get(r);
      if (s === undefined) {
        s = new Set<string>();
        seen.set(r, s);
      }
      s.add(h);
    }
  }
  for (const [node, via] of seen) {
    const km = chain.kmFromSouthOf.get(node);
    const p = ll(node);
    if (km === undefined || p === null) continue;
    attaches.push({ node, kmFromSouth: km, lat: p.lat, lon: p.lon, via });
  }
  attaches.sort((a, b) => a.kmFromSouth - b.kmFromSouth);
}

interface Interchange {
  kmFromSouth: number;
  lat: number;
  lon: number;
  via: Set<string>;
  exitRefs: string[];
  exitNames: string[];
}
const interchanges: Interchange[] = [];
for (const a of attaches) {
  const last = interchanges[interchanges.length - 1];
  if (last !== undefined && a.kmFromSouth - last.kmFromSouth < CLUSTER_KM) {
    for (const v of a.via) last.via.add(v);
    continue;
  }
  interchanges.push({ kmFromSouth: a.kmFromSouth, lat: a.lat, lon: a.lon, via: new Set(a.via), exitRefs: [], exitNames: [] });
}

/**
 * A ramp under `construction` is not an interchange a car can use, and both of ours attach at
 * points with no other ramp. Dropped BEFORE the fit and reported, rather than left in to be
 * explained away by a residual afterwards.
 */
const usable = interchanges.filter((ic) => [...ic.via].some((v) => v === 'motorway_link' || v === 'motorway'));
const dropped = interchanges.filter((ic) => !usable.includes(ic));

// Exit refs are collected as EVIDENCE for the report and never drive the match.
for (const [id, tags] of clipped.nodeTags) {
  if (tags.get('highway') !== 'motorway_junction') continue;
  if (!chain.epeNodes.has(id)) continue;
  const p = ll(id);
  if (p === null) continue;
  let best: Interchange | undefined;
  let bestD = Infinity;
  for (const ic of usable) {
    const d = haversineM(p.lat, p.lon, ic.lat, ic.lon) / 1000;
    if (d < bestD) {
      bestD = d;
      best = ic;
    }
  }
  if (best === undefined || bestD > 3.0) continue;
  const ref = tags.get('ref');
  const nm = tags.get('name');
  if (ref !== undefined && !best.exitRefs.includes(ref)) best.exitRefs.push(ref);
  if (nm !== undefined && !best.exitNames.includes(nm)) best.exitNames.push(nm);
}

console.log(`\n  ${usable.length} drivable interchanges on the mainline, ${dropped.length} attachment(s) dropped as not drivable`);
for (const d of dropped) {
  console.log(`    dropped at ${d.kmFromSouth.toFixed(3)} km north of the terminus: attaches only via ${[...d.via].join(', ')}`);
}

// --- the mainline plazas, which are not interchanges --------------------------------------------------
//
// THE TWO KINDS OF PLAZA ARE DIFFERENT ROAD FEATURES, and conflating them is what a first cut of
// this script did. Nine of the eleven are RAMP plazas at interchanges. Two are MAIN plazas, barriers
// across the open carriageway with no interchange at all: Jakhauli at km 5.5 and Chhajju Nagar at
// km 132.085. So a main plaza is matched to a toll booth ON THE MAINLINE, and an interchange is
// matched only against the nine ramp plazas. Matching the Palwal terminus tie-in against Chhajju
// Nagar pulled the anchor 2.5 km and made one anchor unable to explain the road, which is the
// failure this split removes rather than tunes away.

interface MainBooth {
  kmFromSouth: number;
  lat: number;
  lon: number;
}
const mainBooths: MainBooth[] = [];
for (const [id, tags] of clipped.nodeTags) {
  if (tags.get('barrier') !== 'toll_booth' && tags.get('highway') !== 'toll_gantry') continue;
  const km = chain.kmFromSouthOf.get(id);
  if (km === undefined) continue;
  const p = ll(id);
  if (p === null) continue;
  mainBooths.push({ kmFromSouth: km, lat: p.lat, lon: p.lon });
}
mainBooths.sort((a, b) => a.kmFromSouth - b.kmFromSouth);
const mainSites: MainBooth[] = [];
for (const b of mainBooths) {
  const last = mainSites[mainSites.length - 1];
  if (last !== undefined && b.kmFromSouth - last.kmFromSouth < CLUSTER_KM) continue;
  mainSites.push(b);
}
console.log(
  `  ${mainBooths.length} toll booth node(s) sit on the mainline carriageway itself, forming ${mainSites.length} main-plaza site(s)`,
);

// --- fit the one unknown ---------------------------------------------------------------------------
//
// Chainage decreases as we go north, so predicted chainage is `anchor - kmFromSouth`. Each observed
// feature is assigned to its nearest plaza OF ITS OWN KIND under a candidate anchor, and the anchor
// minimising total squared residual wins. The penalty is capped so a feature with no plaza, which
// the terminus tie-in is, cannot drag the fit instead of being reported as unmatched.

const CAP_KM = 3.0;
const RAMP_PLAZAS = EPE_PLAZAS.map((p, i) => ({ p, i })).filter(({ p }) => !p.mainPlaza);
const MAIN_PLAZAS = EPE_PLAZAS.map((p, i) => ({ p, i })).filter(({ p }) => p.mainPlaza);

function nearest(
  candidates: readonly { p: { chainageKm: number }; i: number }[],
  predicted: number,
): { idx: number | null; residual: number } {
  let bestI: number | null = null;
  let bestR = Infinity;
  for (const c of candidates) {
    const r = c.p.chainageKm - predicted;
    if (Math.abs(r) < Math.abs(bestR)) {
      bestR = r;
      bestI = c.i;
    }
  }
  return { idx: Math.abs(bestR) <= CAP_KM ? bestI : null, residual: bestR };
}

function score(anchor: number): {
  total: number;
  assign: (number | null)[];
  residual: number[];
  mainAssign: (number | null)[];
  mainResidual: number[];
} {
  const assign: (number | null)[] = [];
  const residual: number[] = [];
  const mainAssign: (number | null)[] = [];
  const mainResidual: number[] = [];
  let total = 0;
  for (const ic of usable) {
    const n = nearest(RAMP_PLAZAS, anchor - ic.kmFromSouth);
    const capped = Math.min(Math.abs(n.residual), CAP_KM);
    total += capped * capped;
    assign.push(n.idx);
    residual.push(n.residual);
  }
  for (const b of mainSites) {
    const n = nearest(MAIN_PLAZAS, anchor - b.kmFromSouth);
    const capped = Math.min(Math.abs(n.residual), CAP_KM);
    total += capped * capped;
    mainAssign.push(n.idx);
    mainResidual.push(n.residual);
  }
  return { total, assign, residual, mainAssign, mainResidual };
}

let bestAnchor = 0;
let bestTotal = Infinity;
for (let a = 125; a <= 150; a += 0.001) {
  const s = score(a);
  if (s.total < bestTotal - 1e-12) {
    bestTotal = s.total;
    bestAnchor = a;
  }
}
const fit = score(bestAnchor);
const matched = fit.assign.filter((a) => a !== null).length;

console.log(`\n  fitted terminus chainage: ${bestAnchor.toFixed(3)} km  (config holds ${EPE_CHAINAGE_AT_CLIP_SOUTH_END_KM.toFixed(3)})`);
console.log(`  the notification's tolled section is km 1.000 to km 136.000, so a physical terminus near km 137 is expected`);

console.log('\n  per-interchange result under that one anchor:');
console.log(
  `  ${'km north'.padStart(9)}  ${'predicted'.padStart(9)}  ${'plaza'.padEnd(26)}${'chainage'.padStart(9)}  ${'residual'.padStart(9)}  evidence`,
);
let worst = 0;
for (let i = 0; i < usable.length; i++) {
  const ic = usable[i] as Interchange;
  const idx = fit.assign[i];
  const p = idx === null || idx === undefined ? undefined : EPE_PLAZAS[idx];
  const r = fit.residual[i] as number;
  if (p !== undefined) worst = Math.max(worst, Math.abs(r));
  const ev = [...ic.exitRefs.map((x) => `exit ${x}`), ...ic.exitNames].join(', ');
  console.log(
    `  ${(bestAnchor - ic.kmFromSouth).toFixed(3).padStart(9)}  ${ic.kmFromSouth.toFixed(3).padStart(9)}  ${(p?.label ?? 'NO PLAZA WITHIN ' + CAP_KM.toFixed(0) + ' KM').padEnd(26)}${(p?.chainageKm ?? 0).toFixed(3).padStart(9)}  ${p === undefined ? '        -' : r.toFixed(3).padStart(9)}  ${ev === '' ? '(no exit ref in OSM)' : ev}`,
  );
}
console.log('\n  main plazas, matched to toll booths on the mainline carriageway rather than to interchanges:');
for (let i = 0; i < mainSites.length; i++) {
  const b = mainSites[i] as MainBooth;
  const idx = fit.mainAssign[i];
  const p = idx === null || idx === undefined ? undefined : EPE_PLAZAS[idx];
  const r = fit.mainResidual[i] as number;
  if (p !== undefined) worst = Math.max(worst, Math.abs(r));
  console.log(
    `  ${(bestAnchor - b.kmFromSouth).toFixed(3).padStart(9)}  ${b.kmFromSouth.toFixed(3).padStart(9)}  ${(p?.label ?? 'NO MAIN PLAZA WITHIN 3 KM').padEnd(26)}${(p?.chainageKm ?? 0).toFixed(3).padStart(9)}  ${p === undefined ? '        -' : r.toFixed(3).padStart(9)}  lat ${b.lat.toFixed(5)} lon ${b.lon.toFixed(5)}`,
  );
}

const mainMatched = fit.mainAssign.filter((a) => a !== null).length;
console.log(
  `\n  matched ${matched} of ${usable.length} interchanges and ${mainMatched} of ${mainSites.length} main-plaza sites; largest residual ${worst.toFixed(3)} km`,
);

const allAssigned = [...fit.assign, ...fit.mainAssign];
const unmatchedPlazas = EPE_PLAZAS.map((p, i) => ({ p, i })).filter(({ i }) => !allAssigned.includes(i));
console.log(`  plazas with no feature in this clip: ${unmatchedPlazas.map(({ p }) => p.label).join(', ') || '(none)'}`);

// --- the held-out test -------------------------------------------------------------------------------

console.log('\n  held-out check: three sites identified by hand in the earlier audit, not used in the fit');
let passed = 0;
for (const h of HELD_OUT) {
  // Nearest FEATURE of either kind. A main plaza is a barrier on the carriageway and a ramp plaza
  // is an interchange, so searching only one kind would fail the other by construction.
  let idx: number | null = null;
  let bestD = Infinity;
  for (let i = 0; i < usable.length; i++) {
    const ic = usable[i] as Interchange;
    const d = haversineM(h.lat, h.lon, ic.lat, ic.lon) / 1000;
    if (d < bestD) {
      bestD = d;
      idx = fit.assign[i] ?? null;
    }
  }
  for (let i = 0; i < mainSites.length; i++) {
    const b = mainSites[i] as MainBooth;
    const d = haversineM(h.lat, h.lon, b.lat, b.lon) / 1000;
    if (d < bestD) {
      bestD = d;
      idx = fit.mainAssign[i] ?? null;
    }
  }
  const got = idx === null ? undefined : EPE_PLAZAS[idx];
  const ok = got?.label === h.expect;
  if (ok) passed++;
  console.log(
    `    ${ok ? 'PASS' : 'FAIL'}  ${h.label.padEnd(38)} hand said ${h.expect.padEnd(25)} chainage says ${(got?.label ?? 'nothing').padEnd(25)} (booth ${bestD.toFixed(2)} km from that feature)`,
  );
}

console.log('\n  VERDICT');
if (worst > 1.5) {
  console.log(`    REFUSED. Largest residual is ${worst.toFixed(3)} km, so one anchor does not explain every`);
  console.log('    interchange and our carriageway is not the Gazette reference line. Mapping NOT adopted.');
  process.exit(1);
} else if (passed !== HELD_OUT.length) {
  console.log(`    REFUSED. Chainage reproduced ${passed} of ${HELD_OUT.length} hand identifications.`);
  console.log('    The method disagrees with the only cases we can independently check.');
  process.exit(1);
} else {
  console.log(`    ACCEPTED. One anchor explains all ${matched} matched interchanges to ${worst.toFixed(3)} km,`);
  console.log(`    and position alone reproduced all ${passed} hand identifications without using a name.`);
  if (Math.abs(bestAnchor - EPE_CHAINAGE_AT_CLIP_SOUTH_END_KM) > 0.05) {
    console.log(`    NOTE: config holds ${EPE_CHAINAGE_AT_CLIP_SOUTH_END_KM.toFixed(3)}, the fit says ${bestAnchor.toFixed(3)}. Update the constant.`);
  }
}
