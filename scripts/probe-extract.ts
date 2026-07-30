/**
 * Gate 1 measurement pass 0. Streams both extracts and reports raw counts, throughput,
 * wall time and peak RSS, without building anything.
 *
 * Exists because every downstream decision (CH or no CH, matcher budget, tile strategy)
 * is supposed to come from measured numbers, and this is the cheapest honest measurement
 * available: it proves the decoder handles the real files and establishes the memory floor
 * before any index is allocated.
 *
 * THROUGHPUT IS REPORTED PER ELEMENT TYPE, and windowed rather than cumulative. A PBF file
 * is written nodes, then ways, then relations, and ways and relations are far heavier per
 * element (unbounded ref arrays, string table lookups) than a dense node. So a falling
 * CUMULATIVE aggregate rate is the expected consequence of mix shift and says nothing about
 * decoder health. Only a node rate that falls across the node phase is evidence of a leak,
 * and a cumulative average cannot show that because it averages away the curve.
 *
 * Output doubles as the input to the cross-validation against libosmium, so counts are
 * written as JSON alongside the human-readable table.
 */
import { writeFile } from 'node:fs/promises';
import { readOsmPbf, readOsmPbfHeader } from '../packages/pipeline/pbf/osmpbf.ts';
import { inBuildAreaScaled, toScaled } from '../packages/pipeline/clip/area.ts';
import { readLock } from './fetch-extracts.ts';

let peakRss = 0;
function sampleRss(): void {
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
}

function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(0)} MB`;
}

/**
 * Containment in integer space, matching the build. An earlier float compare on degrees
 * disagreed with libosmium by exactly one node on central-zone; see
 * packages/pipeline/clip/area.ts for why, and scripts/diagnose-boundary.ts for the evidence.
 */
function inArea(lat: number, lon: number): boolean {
  return inBuildAreaScaled(toScaled(lat), toScaled(lon));
}

export interface Counts {
  nodes: number;
  nodesInArea: number;
  taggedNodesInArea: number;
  ways: number;
  waysWithHighway: number;
  relations: number;
  restrictionRelations: number;
}

function zeroCounts(): Counts {
  return {
    nodes: 0,
    nodesInArea: 0,
    taggedNodesInArea: 0,
    ways: 0,
    waysWithHighway: 0,
    relations: 0,
    restrictionRelations: 0,
  };
}

type Phase = 'node' | 'way' | 'relation';

interface PhaseStat {
  count: number;
  startMs: number;
  endMs: number;
  /** Instantaneous rate per window, in millions of elements per second. */
  windowRates: number[];
}

interface Probed {
  readonly name: string;
  readonly counts: Counts;
  readonly seconds: number;
  readonly phases: Record<Phase, PhaseStat>;
  /** Non-zero means the nodes-then-ways-then-relations assumption is false for this file. */
  readonly outOfOrder: number;
}

const WINDOW = 1_000_000;

async function probe(name: string, path: string): Promise<Probed> {
  console.log(`\n=== ${name} ===`);
  const header = await readOsmPbfHeader(path);
  if (header.bbox) {
    const b = header.bbox;
    console.log(
      `  header bbox : lat ${b.minLat.toFixed(4)}..${b.maxLat.toFixed(4)} ` +
        `lon ${b.minLon.toFixed(4)}..${b.maxLon.toFixed(4)}`,
    );
  } else {
    console.log('  header bbox : absent');
  }
  console.log(`  features    : ${header.features.join(', ') || 'none declared'}`);

  const c = zeroCounts();
  const phases: Record<Phase, PhaseStat> = {
    node: { count: 0, startMs: 0, endMs: 0, windowRates: [] },
    way: { count: 0, startMs: 0, endMs: 0, windowRates: [] },
    relation: { count: 0, startMs: 0, endMs: 0, windowRates: [] },
  };

  const t0 = performance.now();
  let current: Phase | null = null;
  const seen = new Set<Phase>();
  let outOfOrder = 0;
  let windowStartMs = t0;
  let windowCount = 0;

  for await (const el of readOsmPbf(path)) {
    const kind = el.kind;

    if (kind !== current) {
      const now = performance.now();
      if (current) {
        phases[current].endMs = now;
        // Flush the partial window so the last stretch of a phase is not dropped.
        if (windowCount > 0) {
          phases[current].windowRates.push(windowCount / ((now - windowStartMs) / 1000) / 1e6);
        }
      }
      if (seen.has(kind)) {
        // A type reappearing after another type began means the file is not type-sorted,
        // which invalidates phase attribution. Counted, reported, never silently ignored.
        outOfOrder++;
      } else {
        seen.add(kind);
        phases[kind].startMs = now;
      }
      current = kind;
      windowStartMs = now;
      windowCount = 0;
    }

    if (kind === 'node') {
      c.nodes++;
      if (inArea(el.lat, el.lon)) {
        c.nodesInArea++;
        if (el.tags.size > 0) c.taggedNodesInArea++;
      }
    } else if (kind === 'way') {
      c.ways++;
      if (el.tags.has('highway')) c.waysWithHighway++;
    } else {
      c.relations++;
      if (el.tags.get('type') === 'restriction') c.restrictionRelations++;
    }
    phases[kind].count++;

    if (++windowCount >= WINDOW) {
      const now = performance.now();
      const rate = windowCount / ((now - windowStartMs) / 1000) / 1e6;
      phases[kind].windowRates.push(rate);
      sampleRss();
      process.stdout.write(
        `  ${kind.padEnd(8)} ${(phases[kind].count / 1e6).toFixed(0)}M  ` +
          `window ${rate.toFixed(2)}M/s  rss ${mb(process.memoryUsage().rss)}\n`,
      );
      windowStartMs = now;
      windowCount = 0;
    }
  }

  const end = performance.now();
  if (current) {
    phases[current].endMs = end;
    if (windowCount > 0) {
      phases[current].windowRates.push(windowCount / ((end - windowStartMs) / 1000) / 1e6);
    }
  }
  sampleRss();
  const seconds = (end - t0) / 1000;

  console.log('  ---');
  console.log(`  nodes             ${c.nodes.toLocaleString('en-US')}`);
  console.log(`  nodes in area     ${c.nodesInArea.toLocaleString('en-US')}`);
  console.log(`  tagged in area    ${c.taggedNodesInArea.toLocaleString('en-US')}`);
  console.log(`  ways              ${c.ways.toLocaleString('en-US')}`);
  console.log(`  ways w/ highway   ${c.waysWithHighway.toLocaleString('en-US')}`);
  console.log(`  relations         ${c.relations.toLocaleString('en-US')}`);
  console.log(`  type=restriction  ${c.restrictionRelations.toLocaleString('en-US')}`);
  console.log(`  wall time         ${seconds.toFixed(1)} s`);
  console.log(`  out-of-order      ${outOfOrder}${outOfOrder === 0 ? ' (file is type-sorted, phase split is valid)' : ' <- PHASE SPLIT INVALID'}`);

  console.log('\n  per-phase throughput');
  console.log('  phase      elements        secs    M/s   first window   last window');
  for (const p of ['node', 'way', 'relation'] as const) {
    const s = phases[p];
    if (s.count === 0) continue;
    const secs = (s.endMs - s.startMs) / 1000;
    const first = s.windowRates[0];
    const last = s.windowRates[s.windowRates.length - 1];
    console.log(
      `  ${p.padEnd(9)} ${s.count.toLocaleString('en-US').padStart(12)} ${secs.toFixed(1).padStart(8)} ` +
        `${(s.count / secs / 1e6).toFixed(2).padStart(7)} ` +
        `${(first === undefined ? 'n/a' : first.toFixed(2)).padStart(14)} ` +
        `${(last === undefined ? 'n/a' : last.toFixed(2)).padStart(13)}`,
    );
  }

  return { name, counts: c, seconds, phases, outOfOrder };
}

const lock = await readLock();
const t0 = performance.now();
const results: Probed[] = [];
for (const e of lock.extracts) {
  results.push(await probe(e.name, e.localPath));
}
const secs = (performance.now() - t0) / 1000;

console.log('\n=== TOTAL ===');
const sum = results.reduce<Counts>((a, r) => {
  const c = r.counts;
  return {
    nodes: a.nodes + c.nodes,
    nodesInArea: a.nodesInArea + c.nodesInArea,
    taggedNodesInArea: a.taggedNodesInArea + c.taggedNodesInArea,
    ways: a.ways + c.ways,
    waysWithHighway: a.waysWithHighway + c.waysWithHighway,
    relations: a.relations + c.relations,
    restrictionRelations: a.restrictionRelations + c.restrictionRelations,
  };
}, zeroCounts());

console.log(`  nodes            ${sum.nodes.toLocaleString('en-US')}`);
console.log(
  `  nodes IN AREA    ${sum.nodesInArea.toLocaleString('en-US')}   <- SUM across overlapping extracts, not a deduped union`,
);
console.log(`  ways             ${sum.ways.toLocaleString('en-US')}`);
console.log(`  ways w/ highway  ${sum.waysWithHighway.toLocaleString('en-US')}`);
console.log(`  relations        ${sum.relations.toLocaleString('en-US')}`);
console.log(`  type=restriction ${sum.restrictionRelations.toLocaleString('en-US')}`);
console.log(`  wall time        ${secs.toFixed(1)} s`);
console.log(`  PEAK RSS         ${mb(peakRss)}   (machine has 7.7 GB)`);

const jsonPath = new URL('../data/probe.json', import.meta.url);
await writeFile(
  jsonPath,
  JSON.stringify(
    {
      perFile: results.map((r) => ({
        name: r.name,
        ...r.counts,
        seconds: Number(r.seconds.toFixed(1)),
        outOfOrder: r.outOfOrder,
        phases: Object.fromEntries(
          (['node', 'way', 'relation'] as const).map((p) => [
            p,
            {
              count: r.phases[p].count,
              seconds: Number(((r.phases[p].endMs - r.phases[p].startMs) / 1000).toFixed(1)),
              windowRates: r.phases[p].windowRates.map((x) => Number(x.toFixed(3))),
            },
          ]),
        ),
      })),
      sum,
      peakRssBytes: peakRss,
      decoder: 'packages/pipeline/pbf',
    },
    null,
    2,
  ),
  'utf8',
);
console.log(`\n  counts written to data/probe.json for cross-validation`);
