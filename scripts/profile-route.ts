/**
 * Routing hot-loop profile. `npm run profile:route`.
 *
 * Reports SETTLED AND RELAXED COUNTS ALONGSIDE WALL TIME, because the two failure modes look
 * identical from a millisecond figure alone:
 *
 *   expanding too many states   -> settled is a large fraction of the graph. Fixed by a
 *                                  heuristic (A*) or by searching from both ends.
 *   each expansion too expensive -> settled is small but nanoseconds per settle is high. Fixed
 *                                  by removing work from the loop. A heuristic on top of a slow
 *                                  loop just hides this.
 *
 * The search is EDGE based, so the denominator is 532,951 directed edges rather than 213,144
 * vertices. Quoting the vertex count next to an edge-based settle count overstates how much of
 * the graph was searched by more than a factor of two.
 *
 * Timing is a median of repeated runs after a warm-up. A single timed run on this machine varies
 * by more than the differences being measured, and `tests/CLAUDE.md` forbids wall-clock
 * assertions that flake.
 */
import { resolve } from 'node:path';
import { BUILD_AREA, SNAP_DESTINATION_M } from '../config/city.ts';
import { loadOrBuildClip } from '../packages/pipeline/clip/clip.ts';
import { buildGraph } from '../packages/pipeline/graph/build.ts';
import { buildTurnTable } from '../packages/pipeline/graph/restrictions.ts';
import { SnapIndex } from '../packages/engine/snap.ts';
import { Router } from '../packages/engine/dijkstra.ts';
import { readLock } from './fetch-extracts.ts';

const DATA = resolve(import.meta.dirname, '../data');
const REPEATS = 7;

const PAIRS: readonly (readonly [string, [number, number], [number, number]])[] = [
  ['short, Pari Chowk to Knowledge Park', [77.5031, 28.4712], [77.4906, 28.4633]],
  ['medium, Pari Chowk to GBU', [77.5031, 28.4712], [77.52464, 28.42268]],
  ['medium, Surajpur to Knowledge Park', [77.4917, 28.5175], [77.4906, 28.4633]],
  ['long, Dadri to Pari Chowk', [77.5527, 28.5556], [77.5031, 28.4712]],
  ['cross-city, Gaur City to Jewar', [77.43, 28.6], [77.55, 28.13]],
];

const lock = await readLock();
const { clipped } = await loadOrBuildClip(
  lock.extracts.map((e) => ({ name: e.name, localPath: e.localPath, md5: e.md5 })),
  resolve(DATA, 'clipped.bin'),
  () => {},
);
const graph = buildGraph(clipped);
const vertexOfNodeId = new Map<number, number>();
for (let v = 0; v < graph.vertexNodeId.length; v++) vertexOfNodeId.set(graph.vertexNodeId[v] as number, v);
const turns = buildTurnTable(graph, clipped.relations, vertexOfNodeId, clipped);
const snap = new SnapIndex(graph, BUILD_AREA);
const router = new Router(graph, turns);

const totalEdges = graph.edgeFrom.length;
console.log('=== routing hot-loop profile ===');
console.log(
  `  graph  ${graph.stats.verticesAfterScc.toLocaleString('en-US')} vertices, ${totalEdges.toLocaleString('en-US')} directed edges`,
);
console.log(`  timing median of ${REPEATS} runs after a warm-up\n`);

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
};

// Warm the JIT across ALL pairs before timing ANY of them. Warming up only within each pair
// makes the first pair pay for compiling `route`, which showed up as 2,915 ns/settle on the
// shortest route: five times the cost of the longest one, which is not a property of the route.
{
  for (let pass = 0; pass < 2; pass++) {
    for (const [, a, b] of PAIRS) {
      const sa = snap.snap(a, 'destination', SNAP_DESTINATION_M);
      const sb = snap.snap(b, 'destination', SNAP_DESTINATION_M);
      if (sa !== null && sb !== null) router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction);
    }
  }
}

console.log(
  '  route                                  km    ms   settled  %graph   relaxed   ns/settle  ns/relax',
);
for (const [label, a, b] of PAIRS) {
  const sa = snap.snap(a, 'destination', SNAP_DESTINATION_M);
  const sb = snap.snap(b, 'destination', SNAP_DESTINATION_M);
  if (sa === null || sb === null) {
    console.log(`  ${label.padEnd(38)} SNAP FAILED`);
    continue;
  }
  router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction);
  const times: number[] = [];
  let last = router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction);
  for (let i = 0; i < REPEATS; i++) {
    const t = performance.now();
    last = router.route(sa.edgeId, sa.fraction, sb.edgeId, sb.fraction);
    times.push(performance.now() - t);
  }
  if (last === null) {
    console.log(`  ${label.padEnd(38)} NO ROUTE`);
    continue;
  }
  const ms = median(times);
  const pct = ((last.settled / totalEdges) * 100).toFixed(1);
  const nsPerSettle = ((ms * 1e6) / Math.max(1, last.settled)).toFixed(0);
  const nsPerRelax = ((ms * 1e6) / Math.max(1, last.relaxed)).toFixed(0);
  console.log(
    `  ${label.padEnd(38)}${(last.metres / 1000).toFixed(1).padStart(5)}${ms.toFixed(1).padStart(6)}${last.settled.toLocaleString('en-US').padStart(10)}${(pct + '%').padStart(8)}${last.relaxed.toLocaleString('en-US').padStart(10)}${nsPerSettle.padStart(12)}${nsPerRelax.padStart(10)}`,
  );
}

console.log(`
  Reading this table:
    %graph near 100 means the search is exploring nearly everything, which is what a heuristic
    fixes. A high ns/settle with a low %graph means the loop itself is expensive, which no
    heuristic fixes. The gate 5 target is p95 under 30 ms.`);
