/**
 * Cross-algorithm equality. `npm run gate:equality`.
 *
 * THE RUNGS MUST AGREE EXACTLY. Dijkstra is the definition of correct in this package; A\* and
 * anything after it are optimisations, and an optimisation that changes an answer is a bug, never
 * a rounding difference. A mismatch here is release blocking.
 *
 * WHY THE PAIRS ARE NOT RANDOM. Random pairs mostly traverse ordinary junctions, and the bug this
 * suite exists to catch does not live there. It lives where a turn RESTRICTION is enforced, because
 * that is the one place a search can be correct forwards and wrong in another order: a via-way
 * restriction is a statement about an ordered triple, so applying it with the sequence reversed
 * still forbids something, just the wrong thing. Random pairs would find that roughly never. So
 * every restriction site in the graph is routed through deliberately, from an edge entering the
 * junction to an edge some hops past it, in every direction the junction offers.
 *
 * Random and landmark pairs are included AS WELL, for breadth, and are reported separately so a
 * green line cannot be read as "the restriction sites passed" when it was the easy pairs passing.
 *
 * WHAT IS COMPARED, and it is deliberately more than the cost. Two searches can agree on a total
 * and disagree on the road, which is the failure a cost-only check waves through. So the EDGE
 * SEQUENCE is compared element by element, and the cost within 1e-6 on top.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUILD_AREA, OBJECTIVE, SNAP_DESTINATION_M, TURN_COST } from '../config/city.ts';
import { ROUTING_FIXTURES } from '../config/fixtures/routing.ts';
import { SnapIndex } from '../packages/engine/snap.ts';
import { Router } from '../packages/engine/dijkstra.ts';
import { parseGraphArtifact } from '../packages/engine/graphfile.ts';
import type { RoutingAlgorithm } from '../packages/shared/index.ts';

const DATA = resolve(import.meta.dirname, '../data');
const COST_TOLERANCE = 1e-6;
const HOPS_PAST_JUNCTION = 12;
const SEED = 20260731;
const RANDOM_PAIRS = 60;

const graphPath = resolve(DATA, 'graph.bin');
if (!existsSync(graphPath)) {
  console.error('data/graph.bin is missing. Run `npm run build-city` first.');
  process.exit(1);
}

const artifact = parseGraphArtifact(await readFile(graphPath));
const g = artifact.graph;
const r = artifact.restrictions;
const snap = new SnapIndex(g, BUILD_AREA);

// `dijkstra-h-discarded` is in here on purpose: it is a measurement mode, and the claim that it
// searches exactly as Dijkstra does is only worth anything if something checks it.
const ALGORITHMS: readonly RoutingAlgorithm[] = ['dijkstra', 'astar', 'dijkstra-h-discarded'];
const routers = new Map<RoutingAlgorithm, Router>();
for (const a of ALGORITHMS) routers.set(a, new Router(g, r, TURN_COST, OBJECTIVE));

/**
 * An edge roughly `hops` steps downstream of `from`, by breadth-first walk over the CSR.
 *
 * Breadth first rather than "keep taking the first outgoing edge": a greedy walk gets trapped in
 * a cul-de-sac or oscillates on a two-way stub, and the pair it produces then never reaches past
 * the junction, which is the whole point of the pair.
 */
function downstream(from: number, hops: number): number {
  let frontier = [from];
  const seen = new Set<number>([from]);
  let last = from;
  for (let d = 0; d < hops && frontier.length > 0; d++) {
    const next: number[] = [];
    for (const e of frontier) {
      const v = g.edgeTo[e] as number;
      for (let i = g.csrOffset[v] as number; i < (g.csrOffset[v + 1] as number); i++) {
        const f = g.csrEdge[i] as number;
        if (seen.has(f)) continue;
        seen.add(f);
        next.push(f);
        last = f;
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return last;
}

interface Pair {
  readonly label: string;
  readonly group: string;
  readonly startEdge: number;
  readonly startFraction: number;
  readonly endEdge: number;
  readonly endFraction: number;
}
const pairs: Pair[] = [];

// --- the restriction sites, which is the point of this suite ---------------------------------

let pairSites = 0;
let viaWaySites = 0;

for (const [via, tos] of r.banned) {
  pairSites++;
  const v = g.edgeTo[via] as number;
  for (let i = g.csrOffset[v] as number; i < (g.csrOffset[v + 1] as number); i++) {
    const f = g.csrEdge[i] as number;
    const end = downstream(f, HOPS_PAST_JUNCTION);
    if (end === f) continue;
    pairs.push({
      label: `pair-restriction via ${via} out ${f}${tos.has(f) ? ' BANNED' : ''}`,
      group: 'pair restriction',
      startEdge: via, startFraction: 0, endEdge: end, endFraction: 1,
    });
  }
}

for (const [via, seqs] of r.bannedSequences) {
  viaWaySites++;
  // A via-way restriction is an ordered triple, so the pair has to START on the `fromEdge` and be
  // able to continue past `toEdge`. Starting at the via edge would skip the first leg of the
  // triple entirely and test nothing that the pair table does not already cover.
  for (const s of seqs) {
    const end = downstream(s.toEdge, HOPS_PAST_JUNCTION);
    if (end === s.toEdge) continue;
    pairs.push({
      label: `via-way ${s.fromEdge} -> ${via} -> ${s.toEdge} BANNED`,
      group: 'via-way restriction',
      startEdge: s.fromEdge, startFraction: 0, endEdge: end, endFraction: 1,
    });
    // And the same junction approached so the banned triple is NOT the natural continuation, so
    // the suite covers the legal crossing as well as the forbidden one.
    pairs.push({
      label: `via-way ${via} -> ${s.toEdge} legal approach`,
      group: 'via-way restriction',
      startEdge: via, startFraction: 0, endEdge: end, endFraction: 1,
    });
  }
}

// --- is this suite even CAPABLE of catching a reversed-order backward search? -------------------
//
// A backward search walks the same directed edges in reverse order, so the bug it is exposed to is
// checking the triple with its ends swapped: `forbidden(via, from, to)` where it should be
// `forbidden(via, to, from)`. That bug is INVISIBLE at a site where both (f,v,t) and (t,v,f) are
// banned, because the wrong lookup still lands on a ban. A suite made only of such sites would pass
// a reversed implementation and prove nothing.
//
// So the property is asserted rather than assumed, and re-derived from the data on every run: a
// future extract could add a symmetric pair and quietly blind this gate.
const tripleKey = (f: number, v: number, t: number): string => `${f}|${v}|${t}`;
const bannedTriples = new Set<string>();
for (const [via, seqs] of r.bannedSequences) for (const s of seqs) bannedTriples.add(tripleKey(s.fromEdge, via, s.toEdge));
let blindSites = 0;
let detectingSites = 0;
for (const [via, seqs] of r.bannedSequences) {
  for (const s of seqs) {
    if (s.fromEdge === s.toEdge) continue;
    if (bannedTriples.has(tripleKey(s.toEdge, via, s.fromEdge))) blindSites++;
    else detectingSites++;
  }
}

// --- breadth: landmarks and seeded random pairs ------------------------------------------------

for (let i = 0; i < ROUTING_FIXTURES.length; i++) {
  const f = ROUTING_FIXTURES[i] as (typeof ROUTING_FIXTURES)[number];
  const hh = ROUTING_FIXTURES[(i + 1) % ROUTING_FIXTURES.length] as (typeof ROUTING_FIXTURES)[number];
  const sa = snap.snap([f.lon, f.lat], 'destination', SNAP_DESTINATION_M);
  const sb = snap.snap([hh.lon, hh.lat], 'destination', SNAP_DESTINATION_M);
  if (sa === null || sb === null) continue;
  pairs.push({
    label: `${f.id} to ${hh.id}`, group: 'landmark',
    startEdge: sa.edgeId, startFraction: sa.fraction, endEdge: sb.edgeId, endFraction: sb.fraction,
  });
}

{
  let a = SEED >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let made = 0;
  let attempts = 0;
  while (made < RANDOM_PAIRS && attempts < RANDOM_PAIRS * 40) {
    attempts++;
    const pick = (): [number, number] => [
      BUILD_AREA.minLon + next() * (BUILD_AREA.maxLon - BUILD_AREA.minLon),
      BUILD_AREA.minLat + next() * (BUILD_AREA.maxLat - BUILD_AREA.minLat),
    ];
    const sa = snap.snap(pick(), 'destination', SNAP_DESTINATION_M);
    const sb = snap.snap(pick(), 'destination', SNAP_DESTINATION_M);
    if (sa === null || sb === null) continue;
    made++;
    pairs.push({
      label: `random ${made}`, group: 'random breadth',
      startEdge: sa.edgeId, startFraction: sa.fraction, endEdge: sb.edgeId, endFraction: sb.fraction,
    });
  }
}

// --- run -------------------------------------------------------------------------------------

console.log('=== cross-algorithm equality ===\n');
console.log(`  graph            ${g.edgeFrom.length.toLocaleString('en-US')} directed edges`);
console.log(`  restriction sites ${pairSites} via-node pair, ${viaWaySites} via-way sequence`);
console.log(
  `  via-way triples   ${detectingSites} order-ASYMMETRIC (can catch a reversed backward search), ` +
    `${blindSites} symmetric (blind to it)`,
);
console.log(`  pairs            ${pairs.length}\n`);

interface Stat { pairs: number; mismatches: number; settled: Record<string, number> }
const stats = new Map<string, Stat>();
const failures: string[] = [];
let bothNull = 0;

for (const p of pairs) {
  const results = ALGORITHMS.map((a) => {
    const res = (routers.get(a) as Router).route(p.startEdge, p.startFraction, p.endEdge, p.endFraction, {
      algorithm: a,
    });
    return { a, res };
  });

  let st = stats.get(p.group);
  if (st === undefined) {
    st = { pairs: 0, mismatches: 0, settled: {} };
    stats.set(p.group, st);
  }
  st.pairs++;

  const first = results[0] as (typeof results)[number];
  const baseRes = first.res;
  const base = { a: first.a, res: baseRes };
  if (baseRes === null) {
    // A pair with no route is still a comparison: every rung must agree that there is none.
    // Silently skipping it would let a rung that finds nothing pass by finding nothing.
    bothNull++;
    for (const { a, res } of results) {
      if (res !== null) failures.push(`${p.label}: dijkstra found no route but ${a} did`);
    }
    continue;
  }

  for (const { a, res } of results) {
    st.settled[a] = (st.settled[a] ?? 0) + (res === null ? 0 : res.settled);
    if (a === base.a) continue;
    if (res === null) {
      st.mismatches++;
      failures.push(`${p.label}: ${a} found no route, dijkstra found one`);
      continue;
    }
    if (Math.abs(res.seconds - baseRes.seconds) > COST_TOLERANCE) {
      st.mismatches++;
      failures.push(
        `${p.label}: cost ${a} ${res.seconds.toFixed(9)} against dijkstra ${baseRes.seconds.toFixed(9)}`,
      );
      continue;
    }
    // Same cost, different road: the failure a cost-only check waves through.
    const same =
      res.edges.length === baseRes.edges.length && res.edges.every((e, i) => e === baseRes.edges[i]);
    if (!same) {
      st.mismatches++;
      failures.push(
        `${p.label}: same cost but a DIFFERENT path, ${a} used ${res.edges.length} edges against ${baseRes.edges.length}`,
      );
    }
  }
}

console.log(`  ${'group'.padEnd(22)}${'pairs'.padStart(8)}${'mismatch'.padStart(10)}${ALGORITHMS.map((a) => `${a} settled`.padStart(18)).join('')}${'saved'.padStart(9)}`);
for (const [group, st] of stats) {
  const d = st.settled['dijkstra'] ?? 0;
  const others = ALGORITHMS.filter((a) => a !== 'dijkstra').map((a) => st.settled[a] ?? 0);
  const best = others.length === 0 ? d : (others[0] as number);
  console.log(
    `  ${group.padEnd(22)}${st.pairs.toString().padStart(8)}${st.mismatches.toString().padStart(10)}` +
      ALGORITHMS.map((a) => (st.settled[a] ?? 0).toLocaleString('en-US').padStart(18)).join('') +
      `${d === 0 ? '-' : `${(((d - best) / d) * 100).toFixed(1)}%`}`.padStart(9),
  );
}
console.log(`\n  pairs with no route under any rung: ${bothNull} (agreement on absence is still agreement)`);

// A suite that cannot fail is not evidence. If every via-way site became symmetric, this gate
// would go green against a reversed backward search, so that condition is itself a failure.
if (detectingSites === 0 && viaWaySites > 0) {
  failures.push(
    'every via-way triple is order-symmetric, so this suite is BLIND to a reversed-order backward ' +
      'search. Add an asymmetric site before trusting a green run.',
  );
}

if (failures.length > 0) {
  console.error(`\nequality gate FAIL: ${failures.length} mismatch(es). This is release blocking.`);
  for (const f of failures.slice(0, 40)) console.error(`  ${f}`);
  if (failures.length > 40) console.error(`  ... and ${failures.length - 40} more`);
  process.exit(1);
}
console.log('\nequality gate PASS: every rung returned the identical path and cost on every pair.');
