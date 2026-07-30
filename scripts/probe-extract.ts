/**
 * Gate 1 measurement pass 0. Streams both extracts and reports raw counts, throughput,
 * wall time and peak RSS, without building anything.
 *
 * Exists because every downstream decision (CH or no CH, matcher budget, tile strategy)
 * is supposed to come from measured numbers, and this is the cheapest honest measurement
 * available: it proves the decoder handles the real files and establishes the memory floor
 * before any index is allocated.
 */
import { BUILD_AREA } from '../config/city.ts';
import { readOsmPbf, readOsmPbfHeader } from '../packages/pipeline/pbf/osmpbf.ts';
import { readLock } from './fetch-extracts.ts';

let peakRss = 0;
function sampleRss(): void {
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
}

function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(0)} MB`;
}

function inArea(lat: number, lon: number): boolean {
  return (
    lat >= BUILD_AREA.minLat &&
    lat <= BUILD_AREA.maxLat &&
    lon >= BUILD_AREA.minLon &&
    lon <= BUILD_AREA.maxLon
  );
}

interface Counts {
  nodes: number;
  nodesInArea: number;
  taggedNodesInArea: number;
  ways: number;
  waysWithHighway: number;
  relations: number;
  restrictionRelations: number;
}

async function probe(name: string, path: string): Promise<Counts> {
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

  const c: Counts = {
    nodes: 0,
    nodesInArea: 0,
    taggedNodesInArea: 0,
    ways: 0,
    waysWithHighway: 0,
    relations: 0,
    restrictionRelations: 0,
  };

  const t0 = performance.now();
  let sinceSample = 0;

  for await (const el of readOsmPbf(path)) {
    if (el.kind === 'node') {
      c.nodes++;
      if (inArea(el.lat, el.lon)) {
        c.nodesInArea++;
        if (el.tags.size > 0) c.taggedNodesInArea++;
      }
    } else if (el.kind === 'way') {
      c.ways++;
      if (el.tags.has('highway')) c.waysWithHighway++;
    } else {
      c.relations++;
      if (el.tags.get('type') === 'restriction') c.restrictionRelations++;
    }

    if (++sinceSample >= 500_000) {
      sinceSample = 0;
      sampleRss();
      const secs = (performance.now() - t0) / 1000;
      const total = c.nodes + c.ways + c.relations;
      process.stdout.write(
        `  ${(total / 1e6).toFixed(1)}M elements  ${(total / secs / 1e6).toFixed(2)}M/s  rss ${mb(process.memoryUsage().rss)}\n`,
      );
    }
  }

  sampleRss();
  const secs = (performance.now() - t0) / 1000;
  const total = c.nodes + c.ways + c.relations;
  console.log(`  ---`);
  console.log(`  nodes             ${c.nodes.toLocaleString('en-US')}`);
  console.log(`  nodes in area     ${c.nodesInArea.toLocaleString('en-US')}`);
  console.log(`  tagged in area    ${c.taggedNodesInArea.toLocaleString('en-US')}`);
  console.log(`  ways              ${c.ways.toLocaleString('en-US')}`);
  console.log(`  ways w/ highway   ${c.waysWithHighway.toLocaleString('en-US')}`);
  console.log(`  relations         ${c.relations.toLocaleString('en-US')}`);
  console.log(`  type=restriction  ${c.restrictionRelations.toLocaleString('en-US')}`);
  console.log(`  wall time         ${secs.toFixed(1)} s`);
  console.log(`  throughput        ${(total / secs / 1e6).toFixed(2)}M elements/s`);
  return c;
}

const lock = await readLock();
const t0 = performance.now();
const results: Array<[string, Counts]> = [];
for (const e of lock.extracts) {
  results.push([e.name, await probe(e.name, e.localPath)]);
}
const secs = (performance.now() - t0) / 1000;

console.log('\n=== TOTAL ===');
const sum = results.reduce<Counts>(
  (a, [, c]) => ({
    nodes: a.nodes + c.nodes,
    nodesInArea: a.nodesInArea + c.nodesInArea,
    taggedNodesInArea: a.taggedNodesInArea + c.taggedNodesInArea,
    ways: a.ways + c.ways,
    waysWithHighway: a.waysWithHighway + c.waysWithHighway,
    relations: a.relations + c.relations,
    restrictionRelations: a.restrictionRelations + c.restrictionRelations,
  }),
  {
    nodes: 0,
    nodesInArea: 0,
    taggedNodesInArea: 0,
    ways: 0,
    waysWithHighway: 0,
    relations: 0,
    restrictionRelations: 0,
  },
);
console.log(`  nodes            ${sum.nodes.toLocaleString('en-US')}`);
console.log(`  nodes IN AREA    ${sum.nodesInArea.toLocaleString('en-US')}   <- the memory driver`);
console.log(`  ways             ${sum.ways.toLocaleString('en-US')}`);
console.log(`  ways w/ highway  ${sum.waysWithHighway.toLocaleString('en-US')}`);
console.log(`  relations        ${sum.relations.toLocaleString('en-US')}`);
console.log(`  type=restriction ${sum.restrictionRelations.toLocaleString('en-US')}`);
console.log(`  wall time        ${secs.toFixed(1)} s`);
console.log(`  PEAK RSS         ${mb(peakRss)}   (machine has 7.7 GB)`);
