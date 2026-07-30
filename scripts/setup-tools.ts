/**
 * Vendors the native tools the pipeline shells out to, into ./tools (git-ignored).
 *
 * WHY v2.4.0 AND NOT LATEST, in order of elimination, all verified rather than assumed:
 *  - v3.1.0 (2026-03-18) publishes ZERO release assets. Nothing to download.
 *  - v3.0.0 (2024-01-15) ships assets, and its Windows binary CRASHES on this machine with
 *    0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) before reading a single byte of input. Reproduced
 *    on a pristine Geofabrik extract, on our own clip, with tilemaker's OWN bundled config and
 *    Lua, from a path containing no spaces, and under every combination of --threads 1, --store,
 *    --shard-stores, --materialize-geometries, --fast and --no-compress-nodes. It always dies
 *    immediately after printing the bounding box, never reaching "Reading .pbf". The vendored
 *    tree was confirmed complete against the release zip: 12 files, no DLLs, statically linked.
 *  - v2.4.0 (2023-03-31) runs correctly and produced a full tileset from our clip.
 *
 * COST OF THE DOWNGRADE: v2 predates PMTiles output, so it writes a directory of tiles and
 * packages/pipeline/tiles/pmtiles.ts packs them into the archive. v2 also uses the method-style
 * Lua API (`way:Find`) rather than v3's globals (`Find`), which process.lua is written against.
 * Building v3 from source needs Boost, Lua, protobuf and shapelib, exactly the toolchain burden
 * this project exists to avoid.
 *
 * Before ever bumping this: check the release actually has assets, then check the binary runs.
 * An existing asset is not evidence that it works.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rm, readdir, stat, chmod } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const TILEMAKER_VERSION = 'v2.4.0';

const ASSETS: Record<string, string> = {
  win32: 'tilemaker-windows.zip',
  darwin: 'tilemaker-macos-latest.zip',
  linux: 'tilemaker-ubuntu-22.04.zip',
};

const ROOT = resolve(import.meta.dirname, '..');
const TOOLS = join(ROOT, 'tools');

function assetUrl(asset: string): string {
  return `https://github.com/systemed/tilemaker/releases/download/${TILEMAKER_VERSION}/${asset}`;
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`download failed ${res.status} for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest));
}

async function unzip(zip: string, into: string): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -Path "${zip}" -DestinationPath "${into}" -Force`,
    ]);
    return;
  }
  await execFileAsync('unzip', ['-o', '-q', zip, '-d', into]);
}

async function findBinary(dir: string, name: string): Promise<string | null> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = await findBinary(p, name);
      if (hit) return hit;
    } else if (entry.name === name || entry.name === `${name}.exe`) {
      return p;
    }
  }
  return null;
}

export async function setupTools(): Promise<string> {
  const asset = ASSETS[process.platform];
  if (!asset) {
    throw new Error(
      `No prebuilt tilemaker for platform "${process.platform}". ` +
        `Build from source per docs/INSTALL.md and put the binary in tools/.`,
    );
  }

  await mkdir(TOOLS, { recursive: true });
  const existing = await findBinary(TOOLS, 'tilemaker');
  if (existing) {
    console.log(`tilemaker already vendored: ${existing}`);
    return existing;
  }

  const zip = join(TOOLS, asset);
  const url = assetUrl(asset);
  console.log(`fetching ${url}`);
  await download(url, zip);
  const size = (await stat(zip)).size;
  // Pinned to en-US. The machine locale groups Indian-style (2,33,60,135), which reads as a
  // different order of magnitude at a glance and has already caused one misread build report.
  console.log(`downloaded ${size.toLocaleString('en-US')} bytes`);

  await unzip(zip, TOOLS);
  await rm(zip, { force: true });

  const bin = await findBinary(TOOLS, 'tilemaker');
  if (!bin) throw new Error(`tilemaker binary not found under ${TOOLS} after extraction`);
  if (process.platform !== 'win32') await chmod(bin, 0o755);

  console.log(`tilemaker vendored: ${bin}`);
  return bin;
}

/** Resolves the vendored binary, or throws with the command that would fix it. */
export async function requireTilemaker(): Promise<string> {
  if (!existsSync(TOOLS)) {
    throw new Error('tools/ is missing. Run: npm run setup:tools');
  }
  const bin = await findBinary(TOOLS, 'tilemaker');
  if (!bin) throw new Error('tilemaker is not vendored. Run: npm run setup:tools');
  return bin;
}

if (import.meta.filename === process.argv[1]) {
  const bin = await setupTools();
  const { stdout, stderr } = await execFileAsync(bin, ['--help']).catch((e: unknown) => ({
    stdout: '',
    stderr: String(e),
  }));
  const head = (stdout || stderr).split('\n').slice(0, 4).join('\n');
  console.log(`--- ${bin} --help ---\n${head}`);
}
