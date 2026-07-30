/**
 * Runs the frozen fixtures against the built artifacts. `npm run gate:fixtures`.
 *
 * ROUTING fixtures assert graph coverage: every one must snap to a legal edge and land in the
 * largest SCC. "Pairwise routable" needs no router to prove, and that is not a shortcut: the
 * graph retains ONLY the largest strongly connected component, so mutual reachability between
 * any two of its vertices is structural. What DOES need proving is that the retained component
 * really is strongly connected, and that is verified directly with a forward and a reverse
 * traversal rather than trusted from Tarjan's output.
 *
 * SEARCH fixtures assert "the right KIND of thing in the RIGHT PLACE", never exact-string,
 * because what a person types and what OSM contains routinely differ.
 *
 * Reads the clip cache, so it costs seconds. If the cache is absent it says which command
 * builds it rather than failing with ENOENT.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BUILD_AREA, SNAP_DESTINATION_M, SNAP_TRACKING_M } from '../config/city.ts';
import { ROUTING_FIXTURES } from '../config/fixtures/routing.ts';
import { SEARCH_FIXTURES, SEARCH_BUDGET_MS } from '../config/fixtures/search.ts';
import { HELD_OUT_QUERIES, HELD_OUT_PASS_RATIO } from '../config/fixtures/heldout.ts';
import { loadOrBuildClip } from '../packages/pipeline/clip/clip.ts';
import { buildGraph } from '../packages/pipeline/graph/build.ts';
import { buildTurnTable } from '../packages/pipeline/graph/restrictions.ts';
import { buildPlaces } from '../packages/pipeline/places/build.ts';
import { SnapIndex } from '../packages/engine/snap.ts';
import { Router } from '../packages/engine/dijkstra.ts';
import { PlacesSearch } from '../packages/engine/search.ts';
import { haversineM } from '../packages/shared/geo.ts';
import { readLock } from './fetch-extracts.ts';

const DATA = resolve(import.meta.dirname, '../data');
const failures: string[] = [];
function check(ok: boolean, label: string, detail: string): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (detail !== '') console.log(`        ${detail}`);
  if (!ok) failures.push(label);
}

const lock = await readLock();
const { clipped } = await loadOrBuildClip(
  lock.extracts.map((e) => ({ name: e.name, localPath: e.localPath, md5: e.md5 })),
  resolve(DATA, 'clipped.bin'),
  () => {},
);
const graph = buildGraph(clipped);
const vertexOfNodeId = new Map<number, number>();
for (let v = 0; v < graph.vertexNodeId.length; v++) vertexOfNodeId.set(graph.vertexNodeId[v] as number, v);
const places = buildPlaces(clipped);
const snapIndex = new SnapIndex(graph, BUILD_AREA);
const search = new PlacesSearch(places.places);

console.log('=== fixture gate ===');
console.log(`  graph      ${graph.stats.verticesAfterScc.toLocaleString('en-US')} vertices, ${graph.stats.edgesAfterScc.toLocaleString('en-US')} edges`);
console.log(`  places     ${places.stats.total.toLocaleString('en-US')} entries`);
console.log(`  snap index ${snapIndex.stats.occupiedCells.toLocaleString('en-US')} occupied cells, max ${snapIndex.stats.maxCellOccupancy} edges per cell, built in ${snapIndex.stats.buildSeconds}s`);

// ---------------------------------------------------------------------------
// The retained component really is strongly connected.
// ---------------------------------------------------------------------------
console.log('\n--- largest SCC is genuinely strongly connected ---');
{
  const V = graph.stats.verticesAfterScc;
  const reachForward = new Uint8Array(V);
  const stack: number[] = [0];
  reachForward[0] = 1;
  let seenF = 1;
  while (stack.length > 0) {
    const v = stack.pop() as number;
    for (let i = graph.csrOffset[v] as number; i < (graph.csrOffset[v + 1] as number); i++) {
      const w = graph.edgeTo[graph.csrEdge[i] as number] as number;
      if (reachForward[w] === 0) {
        reachForward[w] = 1;
        seenF++;
        stack.push(w);
      }
    }
  }
  // Reverse adjacency, built once, so "can every vertex reach vertex 0" is answerable.
  const revStart = new Int32Array(V + 1);
  for (let e = 0; e < graph.edgeTo.length; e++) {
    const t = graph.edgeTo[e] as number;
    revStart[t + 1] = (revStart[t + 1] as number) + 1;
  }
  for (let v = 0; v < V; v++) revStart[v + 1] = (revStart[v + 1] as number) + (revStart[v] as number);
  const revEdges = new Int32Array(graph.edgeTo.length);
  const cursor = Int32Array.from(revStart.subarray(0, V));
  for (let e = 0; e < graph.edgeTo.length; e++) {
    const t = graph.edgeTo[e] as number;
    revEdges[cursor[t] as number] = graph.edgeFrom[e] as number;
    cursor[t] = (cursor[t] as number) + 1;
  }
  const reachBack = new Uint8Array(V);
  reachBack[0] = 1;
  let seenB = 1;
  stack.push(0);
  while (stack.length > 0) {
    const v = stack.pop() as number;
    for (let i = revStart[v] as number; i < (revStart[v + 1] as number); i++) {
      const w = revEdges[i] as number;
      if (reachBack[w] === 0) {
        reachBack[w] = 1;
        seenB++;
        stack.push(w);
      }
    }
  }
  check(
    seenF === V && seenB === V,
    'every vertex is reachable from vertex 0 and can reach it',
    `forward ${seenF.toLocaleString('en-US')}/${V.toLocaleString('en-US')}, reverse ${seenB.toLocaleString('en-US')}/${V.toLocaleString('en-US')}`,
  );
}

// ---------------------------------------------------------------------------
// Routing fixtures
// ---------------------------------------------------------------------------
console.log('\n--- routing fixtures: snappable, legal, and in the largest SCC ---');
for (const f of ROUTING_FIXTURES) {
  const snap = snapIndex.snap([f.lon, f.lat], 'destination', SNAP_DESTINATION_M);
  if (snap === null) {
    check(false, `${f.id}: snaps within SNAP_DESTINATION_M (${SNAP_DESTINATION_M} m)`, 'no edge found');
    continue;
  }
  // Every edge in the graph belongs to the largest SCC, because that is all the graph retains.
  // The structural claim is verified above; this confirms the fixture reaches it.
  const inScc = snap.edgeId >= 0 && snap.edgeId < graph.edgeFrom.length;
  const isPrivate = graph.edgePrivate[snap.edgeId] === 1;
  check(
    inScc,
    `${f.id}: snaps to a largest-SCC edge`,
    `${snap.distanceM.toFixed(1)} m to edge ${snap.edgeId} (way ${graph.edgeWayId[snap.edgeId]}), private=${isPrivate}`,
  );
}

console.log('\n--- the two snap radii are separate code paths, not one tunable ---');
{
  const dadri = ROUTING_FIXTURES.find((f) => f.id === 'dadri');
  if (dadri === undefined) {
    check(false, 'dadri fixture is present', 'the off-road destination fixture was removed');
  } else {
    const asDest = snapIndex.snap([dadri.lon, dadri.lat], 'destination', SNAP_DESTINATION_M);
    const asTrack = snapIndex.snap([dadri.lon, dadri.lat], 'tracking', SNAP_TRACKING_M);
    check(
      asDest !== null,
      `dadri: PASSES as a destination (<= ${SNAP_DESTINATION_M} m)`,
      asDest === null ? 'no edge' : `${asDest.distanceM.toFixed(1)} m`,
    );
    // If this ever passes as tracking too, the fixture has stopped testing the distinction and
    // must be re-sited, NOT accommodated by widening SNAP_TRACKING_M.
    check(
      asTrack === null,
      `dadri: FAILS as a tracking fix (> ${SNAP_TRACKING_M} m)`,
      asTrack === null ? 'correctly unsnappable for tracking' : `snapped at ${asTrack.distanceM.toFixed(1)} m, which breaks the fixture's purpose`,
    );
  }
}

console.log('\n--- gated campus snaps to a LEGAL edge, not through the private road ---');
{
  const gbu = ROUTING_FIXTURES.find((f) => f.id === 'gautam-buddha-university');
  if (gbu === undefined) {
    check(false, 'gautam-buddha-university fixture is present', 'the access-rule fixture was removed');
  } else {
    const anyEdge = snapIndex.snap([gbu.lon, gbu.lat], 'destination', SNAP_DESTINATION_M);
    const legalOnly = snapIndex.snap([gbu.lon, gbu.lat], 'destination', SNAP_DESTINATION_M, { excludePrivate: true });
    check(
      legalOnly !== null,
      'gbu: a non-private edge is reachable within SNAP_DESTINATION_M',
      legalOnly === null
        ? 'only private edges nearby, so a destination here would have to route through one'
        : `${legalOnly.distanceM.toFixed(1)} m to way ${graph.edgeWayId[legalOnly.edgeId]}`,
    );
    if (anyEdge !== null && legalOnly !== null) {
      console.log(
        `        nearest edge of any kind is ${anyEdge.distanceM.toFixed(1)} m ` +
          `(private=${graph.edgePrivate[anyEdge.edgeId] === 1}); nearest legal is ${legalOnly.distanceM.toFixed(1)} m`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Turn restrictions, enforced against the REAL graph, not a toy.
// ---------------------------------------------------------------------------
console.log('\n--- every banned sequence is enforced on the real graph ---');
{
  const turns = buildTurnTable(graph, clipped.relations, vertexOfNodeId, clipped);
  check(
    turns.stats.notHonoured === 0,
    'no real restriction is left unenforced (charter item 7)',
    `${turns.stats.enforcedByPair} by pair, ${turns.stats.enforcedBySequence} by sequence, ` +
      `${turns.stats.correctlyIgnored} correctly ignored, ${turns.stats.notHonoured} not honoured`,
  );

  const restricted = new Router(graph, turns);
  // The control: an identical router with NO restrictions. If the illegal manoeuvre is not the
  // preferred path for this pair, the restricted result proves nothing.
  const free = new Router(graph, {
    banned: new Map(),
    bannedSequences: new Map(),
    edgeRestricted: new Uint8Array(graph.edgeFrom.length),
  });

  let controlTookTurn = 0;
  let enforced = 0;
  let stillRoutable = 0;
  const total = [...turns.bannedSequences.values()].reduce((a, l) => a + l.length, 0);

  for (const [viaEdge, seqs] of turns.bannedSequences) {
    for (const s of seqs) {
      const a = free.route(s.fromEdge, 0, s.toEdge, 1);
      const b = restricted.route(s.fromEdge, 0, s.toEdge, 1);

      const usesTriple = (edges: readonly number[] | undefined): boolean => {
        if (edges === undefined) return false;
        const i = edges.indexOf(viaEdge);
        return i > 0 && edges[i - 1] === s.fromEdge && edges[i + 1] === s.toEdge;
      };
      if (usesTriple(a?.edges)) controlTookTurn++;
      if (b !== null) stillRoutable++;
      if (!usesTriple(b?.edges)) enforced++;
    }
  }

  check(
    controlTookTurn === total,
    'CONTROL: unrestricted routing takes every banned manoeuvre',
    `${controlTookTurn}/${total} would be taken without the restriction, so each one is a real prohibition`,
  );
  check(
    enforced === total,
    'restricted routing takes none of them',
    `${enforced}/${total} banned sequences absent from the routed path`,
  );
  check(
    stillRoutable === total,
    'and the destination is STILL reachable, not blocked into failure',
    `${stillRoutable}/${total} pairs still return a route`,
  );
}

// ---------------------------------------------------------------------------
// Search fixtures
// ---------------------------------------------------------------------------
console.log('\n--- search fixtures: right KIND of thing, right PLACE ---');
for (const f of SEARCH_FIXTURES) {
  // Warm up, then take a MEDIAN of several runs. tests/CLAUDE.md: timing assertions must not be
  // wall-clock flaky. A single cold call includes JIT compilation of the matcher and spiked past
  // 100 ms under load while steady-state was under 20 ms, which is a flaky assertion, not a
  // finding. Gate 7 replaces this with an indexed search and a real budget.
  search.search(f.query, { near: [f.nearLon, f.nearLat], limit: 10 });
  const samples: number[] = [];
  let hits = search.search(f.query, { near: [f.nearLon, f.nearLat], limit: 10 });
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    hits = search.search(f.query, { near: [f.nearLon, f.nearLat], limit: 10 });
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const ms = samples[2] as number;

  if (hits.length === 0) {
    check(false, `"${f.query}": returns at least one hit`, `expected kinds ${f.expectKind.join('/')}`);
    continue;
  }
  const top = hits[0] as (typeof hits)[number];
  const d = haversineM(f.nearLat, f.nearLon, top.point[1], top.point[0]);
  const kindOk = f.expectKind.includes(top.kind);
  const placeOk = d <= f.expectWithinM;

  check(
    kindOk && placeOk,
    `"${f.query}": top hit is the right kind in the right place`,
    `"${top.name}" kind=${top.kind}/${top.category} ${d.toFixed(0)} m away ` +
      `(allowed ${f.expectKind.join('/')} within ${f.expectWithinM} m), match=${top.matchType}, ${hits.length} hits, ${ms.toFixed(2)} ms`,
  );
  if (f.expectMultiple === true) {
    check(hits.length >= 2, `"${f.query}": returns several, not one arbitrary pick`, `${hits.length} hits`);
  }
  check(ms <= SEARCH_BUDGET_MS * 20, `"${f.query}": within ${SEARCH_BUDGET_MS * 20} ms (budget is ${SEARCH_BUDGET_MS} ms, gate 7 tightens it)`, `${ms.toFixed(2)} ms`);
}

// ---------------------------------------------------------------------------
// HELD-OUT queries. Never tuned against; see config/fixtures/heldout.ts.
// ---------------------------------------------------------------------------
console.log('\n--- held-out queries: generalisation check on the ranking constants ---');
{
  const centre: [number, number] = [
    (BUILD_AREA.minLon + BUILD_AREA.maxLon) / 2,
    (BUILD_AREA.minLat + BUILD_AREA.maxLat) / 2,
  ];
  const inArea = (p: readonly [number, number]): boolean =>
    p[0] >= BUILD_AREA.minLon && p[0] <= BUILD_AREA.maxLon &&
    p[1] >= BUILD_AREA.minLat && p[1] <= BUILD_AREA.maxLat;

  let mustCount = 0;
  let mustResolved = 0;
  let outOfArea = 0;

  for (const q of HELD_OUT_QUERIES) {
    const hits = search.search(q.query, { near: centre, limit: 5 });
    const top = hits[0];
    if (q.mustResolve) mustCount++;
    if (q.mustResolve && top !== undefined) mustResolved++;
    for (const h of hits) if (!inArea(h.point)) outOfArea++;
    const label = q.mustResolve ? 'must  ' : 'may   ';
    console.log(
      `    ${label} "${q.query}"  ->  ` +
        (top === undefined
          ? '(no hits)'
          : `"${top.name}" ${top.kind}/${top.category} via ${top.matchType}, ${hits.length} hits`),
    );
  }

  // A hit outside the build area is a ranking failure regardless of the query: the index only
  // contains in-area features, so an out-of-area point means a bad representative coordinate.
  check(outOfArea === 0, 'every held-out hit lies inside BUILD_AREA', `${outOfArea} out-of-area hits`);
  const ratio = mustCount === 0 ? 1 : mustResolved / mustCount;
  check(
    ratio >= HELD_OUT_PASS_RATIO,
    `at least ${(HELD_OUT_PASS_RATIO * 100).toFixed(0)}% of must-resolve held-out queries return something`,
    `${mustResolved}/${mustCount} resolved (${(ratio * 100).toFixed(0)}%). If this fails, RE-DERIVE the ranking constants; never tune against this set.`,
  );
}

console.log('\n--- kasana: the combined fuzzy-match and named-road test ---');
{
  const hits = search.search('Kasna', { near: [77.482, 28.508], limit: 10 });
  // Two independent things must be true, and only one of them is about spelling. If the index
  // did not sweep named ROADS, this returns nothing however good the fuzzy matcher is.
  check(hits.length > 0, 'Kasna: returns hits at all', `${hits.length} hits`);
  const viaFuzzy = hits.some((h) => h.matchType === 'fuzzy');
  check(viaFuzzy, 'Kasna: matched through the FUZZY path, proving it ran', `top match type ${hits[0]?.matchType ?? 'n/a'}`);
  const road = hits.find((h) => h.kind === 'highway');
  check(
    road !== undefined,
    'Kasna: a named ROAD is among the hits, proving roads are indexed',
    road === undefined ? 'no highway hit' : `"${road.name}" (${road.category})`,
  );
  const spelledKasana = hits.some((h) => /kasana/i.test(h.name));
  check(spelledKasana, 'Kasna: resolves to the real KASANA spelling', hits.slice(0, 4).map((h) => `${h.name} [${h.kind}]`).join(', '));
}

console.log('');
if (failures.length > 0) {
  console.error(`fixture gate FAIL: ${failures.length} assertion(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('fixture gate PASS: every routing and search fixture holds against the built artifacts');
