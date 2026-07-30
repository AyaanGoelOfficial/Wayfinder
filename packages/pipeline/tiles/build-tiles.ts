/**
 * Runs tilemaker, then packs its output into a PMTiles archive, and measures both.
 *
 * WHY TWO STEPS INSTEAD OF tilemaker's own `.pmtiles` output:
 *  - tilemaker v3.0.0 is the newest release with Windows assets, and its Windows binary CRASHES
 *    on this machine (`0xC0000409`, stack buffer overrun) before reading a single byte of input.
 *    Reproduced on a pristine Geofabrik extract, on our own clip, with its own bundled config
 *    and Lua, from a path containing no spaces, and under every combination of `--threads 1`,
 *    `--store`, `--shard-stores`, `--materialize-geometries` and `--fast`. It always dies
 *    immediately after printing the bounding box and never reaches "Reading .pbf".
 *  - tilemaker v3.1.0 publishes ZERO release assets, so there is nothing newer to take.
 *  - tilemaker v2.4.0 runs correctly here, but predates PMTiles and can only write `.mbtiles`
 *    or a directory of tiles. A directory avoids an SQLite dependency entirely.
 * So: v2.4.0 writes a tile directory, and `pmtiles.ts` packs it. Building v3 from source needs
 * Boost, Lua, protobuf and shapelib, which is exactly the toolchain burden this project exists
 * to avoid.
 *
 * Peak RSS is read from the OS, not estimated: tilemaker is a native process, so Node's
 * `process.memoryUsage()` says nothing about it. Windows keeps a monotonic `PeakWorkingSet64`
 * per process, polled while it runs.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tilemakerConfig, MAX_ZOOM } from './schema.ts';
import { packPmtiles } from './pmtiles.ts';
import type { PmtilesStats } from './pmtiles.ts';
import { BUILD_AREA } from '../../../config/city.ts';

export interface TileBuildResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly tilemakerSeconds: number;
  readonly tilemakerPeakRssBytes: number;
  readonly packSeconds: number;
  readonly pmtilesBytes: number;
  readonly pmtiles: PmtilesStats | null;
  readonly command: string;
  readonly stderrTail: string;
}

function tilemakerPath(): string {
  return resolve(import.meta.dirname, '../../../tools/build/RelWithDebInfo/tilemaker.exe');
}

/** Monotonic peak working set of one pid, via PowerShell. Returns 0 once the process is gone. */
async function peakWorkingSet(pid: number): Promise<number> {
  return new Promise((done) => {
    const ps = spawn(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).PeakWorkingSet64`],
      { windowsHide: true },
    );
    let out = '';
    ps.stdout.on('data', (d: Buffer) => {
      const chunk = d.toString('utf8');
      out += chunk;
    });
    ps.on('close', () => done(Number(out.trim()) || 0));
    ps.on('error', () => done(0));
  });
}

export async function buildTiles(
  inputPbf: string,
  outputPmtiles: string,
  dataDir: string,
  log: (m: string) => void = () => {},
): Promise<TileBuildResult> {
  const configPath = resolve(dataDir, 'tilemaker-config.json');
  await writeFile(configPath, `${JSON.stringify(tilemakerConfig(), null, 2)}\n`, 'utf8');

  const processLua = resolve(import.meta.dirname, 'process.lua');
  const tileDir = resolve(dataDir, 'tiles');
  const storeDir = resolve(dataDir, 'tilemaker-store');
  // A stale tile tree would be silently packed alongside the new one, producing an archive that
  // mixes two builds. Cheaper to delete than to reason about.
  await rm(tileDir, { recursive: true, force: true });
  await mkdir(storeDir, { recursive: true });

  const args = [
    '--input', inputPbf,
    '--output', tileDir,
    '--config', configPath,
    '--process', processLua,
    '--store', storeDir,
  ];
  const command = `tilemaker ${args.join(' ')}`;
  log(`  ${command}`);

  const t0 = performance.now();
  const child = spawn(tilemakerPath(), args, { windowsHide: true });

  let peakRss = 0;
  let stderrBuf = '';
  let lastLine = '';
  child.stdout.on('data', (d: Buffer) => {
    const chunk = d.toString('utf8');
    const line = chunk.trim().split('\n').pop()?.trim() ?? '';
    // tilemaker rewrites one progress line with carriage returns. Only log when it changes
    // materially, or the build log becomes thousands of near-identical lines.
    if (line !== '' && line !== lastLine && !line.startsWith('Block ')) {
      lastLine = line;
      log(`  [tilemaker] ${line.slice(0, 120)}`);
    }
  });
  child.stderr.on('data', (d: Buffer) => {
    const chunk = d.toString('utf8');
    stderrBuf += chunk;
    if (stderrBuf.length > 20_000) stderrBuf = stderrBuf.slice(-20_000);
  });

  const poll = setInterval(() => {
    if (child.pid === undefined) return;
    void peakWorkingSet(child.pid).then((v) => {
      if (v > peakRss) peakRss = v;
    });
  }, 700);

  const exitCode = await new Promise<number | null>((done) => {
    child.on('close', (code) => done(code));
    child.on('error', () => done(null));
  });
  clearInterval(poll);
  const tilemakerSeconds = Number(((performance.now() - t0) / 1000).toFixed(1));

  const fail = (stderrTail: string): TileBuildResult => ({
    ok: false,
    exitCode,
    tilemakerSeconds,
    tilemakerPeakRssBytes: peakRss,
    packSeconds: 0,
    pmtilesBytes: 0,
    pmtiles: null,
    command,
    stderrTail,
  });

  if (exitCode !== 0) return fail(stderrBuf.split('\n').slice(-25).join('\n').trim());

  // tilemaker writes metadata.json beside the tile tree, carrying vector_layers. MapLibre needs
  // it to know the schema, so it goes into the archive rather than being regenerated.
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(await readFile(resolve(tileDir, 'metadata.json'), 'utf8')) as Record<string, unknown>;
  } catch (err) {
    return fail(`tilemaker produced no metadata.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  const centre: readonly [number, number] = [
    (BUILD_AREA.minLon + BUILD_AREA.maxLon) / 2,
    (BUILD_AREA.minLat + BUILD_AREA.maxLat) / 2,
  ];

  log('  packing tiles into a PMTiles archive');
  const pmtiles = await packPmtiles({
    tileDir,
    outputPath: outputPmtiles,
    metadata,
    // Bounds come from BUILD_AREA, not from tilemaker's metadata: the metadata reports the input
    // file's header bbox, which is wider because the clip deliberately keeps nodes just outside
    // the area so boundary-crossing roads are not severed.
    bounds: [BUILD_AREA.minLon, BUILD_AREA.minLat, BUILD_AREA.maxLon, BUILD_AREA.maxLat],
    center: centre,
    centerZoom: Math.min(11, MAX_ZOOM),
    tilesAreGzipped: true,
  });

  let pmtilesBytes = 0;
  try {
    pmtilesBytes = (await stat(outputPmtiles)).size;
  } catch {
    pmtilesBytes = 0;
  }

  return {
    ok: pmtilesBytes > 0,
    exitCode,
    tilemakerSeconds,
    tilemakerPeakRssBytes: peakRss,
    packSeconds: pmtiles.seconds,
    pmtilesBytes,
    pmtiles,
    command,
    stderrTail: stderrBuf.split('\n').slice(-10).join('\n').trim(),
  };
}
