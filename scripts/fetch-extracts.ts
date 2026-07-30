/**
 * Downloads both zone extracts, verifies them, and writes data/extracts.lock.json.
 *
 * CHECKSUM POLICY: Geofabrik republishes daily, so a checksum pinned in config would break
 * every build within 24 hours. Instead the live `<url>.md5` is fetched at build time and
 * the download is verified against THAT, hard-failing on mismatch. What gets recorded for
 * reproducibility is the lock file.
 *
 * REPRODUCIBILITY: `-latest` is a moving target, so the lock file records two pinned URLs
 * per extract. Verified 2026-07-29 against the Geofabrik directory listing:
 *   snapshotUrl  the dated daily file, e.g. central-zone-260728.osm.pbf. EXPIRES in about
 *                a week (260721 already returns 404), so it is precise but short-lived.
 *   archiveUrl   the nearest first-of-month file, e.g. central-zone-260701.osm.pbf. These
 *                persist for years; 220101 through 260701 were all still listed.
 * Months later, archiveUrl is what actually still resolves.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join, resolve } from 'node:path';
import { EXTRACTS } from '../config/city.ts';

const ROOT = resolve(import.meta.dirname, '..');
export const DATA = join(ROOT, 'data');
export const LOCK_PATH = join(DATA, 'extracts.lock.json');

export interface LockEntry {
  readonly name: string;
  readonly fetchedAt: string;
  readonly sourceUrl: string;
  readonly snapshotUrl: string;
  readonly snapshotResolves: boolean;
  readonly archiveUrl: string;
  readonly archiveResolves: boolean;
  readonly md5: string;
  readonly bytes: number;
  readonly lastModified: string;
  readonly localPath: string;
  readonly polyPath: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** central-zone-latest.osm.pbf + a Date -> central-zone-260728.osm.pbf */
function datedUrl(sourceUrl: string, d: Date, dayOfMonth?: number): string {
  const yy = pad(d.getUTCFullYear() % 100);
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(dayOfMonth ?? d.getUTCDate());
  return sourceUrl.replace(/-latest\.osm\.pbf$/, `-${yy}${mm}${dd}.osm.pbf`);
}

async function resolves(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return r.ok;
  } catch {
    return false;
  }
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`fetch failed ${r.status} for ${url}`);
  return r.text();
}

async function md5File(path: string): Promise<string> {
  const h = createHash('md5');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

async function downloadWithProgress(url: string, dest: string, label: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let seen = 0;
  let lastPct = -1;

  const src = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  src.on('data', (c: Buffer) => {
    seen += c.length;
    const pct = total ? Math.floor((seen / total) * 100) : -1;
    if (pct >= 0 && pct !== lastPct && pct % 5 === 0) {
      lastPct = pct;
      process.stdout.write(`  ${label}: ${pct}% (${seen.toLocaleString('en-US')} / ${total.toLocaleString('en-US')} bytes)\n`);
    }
  });
  await pipeline(src, createWriteStream(dest));
}

export async function fetchExtracts(): Promise<LockEntry[]> {
  await mkdir(DATA, { recursive: true });
  const entries: LockEntry[] = [];

  for (const ex of EXTRACTS) {
    console.log(`\n=== ${ex.name} ===`);
    const pbfPath = join(DATA, `${ex.name}.osm.pbf`);
    const polyPath = join(DATA, `${ex.name}.poly`);

    // Live checksum and metadata first, so a bad download is detectable.
    const md5Line = await fetchText(`${ex.url}.md5`);
    const expectedMd5 = md5Line.trim().split(/\s+/)[0] ?? '';
    if (!/^[0-9a-f]{32}$/.test(expectedMd5)) {
      throw new Error(`${ex.name}: published md5 is malformed: "${md5Line.trim()}"`);
    }

    const head = await fetch(ex.url, { method: 'HEAD', redirect: 'follow' });
    if (!head.ok) throw new Error(`${ex.name}: HEAD failed ${head.status}`);
    const lastModified = head.headers.get('last-modified') ?? '';
    const expectedBytes = Number(head.headers.get('content-length') ?? 0);
    console.log(`  published md5 : ${expectedMd5}`);
    console.log(`  last-modified : ${lastModified}`);
    console.log(`  size          : ${expectedBytes.toLocaleString('en-US')} bytes`);

    let needDownload = true;
    if (existsSync(pbfPath)) {
      const have = await stat(pbfPath);
      if (have.size === expectedBytes) {
        const actual = await md5File(pbfPath);
        if (actual === expectedMd5) {
          console.log('  already present and checksum matches, skipping download');
          needDownload = false;
        } else {
          console.log('  present but checksum differs, re-downloading');
        }
      } else {
        console.log(`  present but size differs (${have.size.toLocaleString('en-US')}), re-downloading`);
      }
    }

    if (needDownload) {
      await downloadWithProgress(ex.url, pbfPath, ex.name);
      const got = await stat(pbfPath);
      const actual = await md5File(pbfPath);
      if (actual !== expectedMd5) {
        throw new Error(
          `${ex.name}: CHECKSUM MISMATCH. expected ${expectedMd5}, got ${actual}. ` +
            `The download is corrupt or the file changed mid-fetch. Delete ${pbfPath} and retry.`,
        );
      }
      if (expectedBytes && got.size !== expectedBytes) {
        throw new Error(`${ex.name}: size mismatch, expected ${expectedBytes}, got ${got.size}`);
      }
      console.log(`  checksum verified: ${actual}`);
    }

    if (!existsSync(polyPath)) {
      await writeFile(polyPath, await fetchText(ex.polyUrl), 'utf8');
      console.log('  poly fetched');
    }

    const lm = lastModified ? new Date(lastModified) : new Date();
    const snapshotUrl = datedUrl(ex.url, lm);
    const archiveUrl = datedUrl(ex.url, lm, 1);
    const [snapOk, archOk] = await Promise.all([resolves(snapshotUrl), resolves(archiveUrl)]);
    console.log(`  snapshot: ${snapshotUrl} -> ${snapOk ? 'resolves' : 'ABSENT'}`);
    console.log(`  archive : ${archiveUrl} -> ${archOk ? 'resolves' : 'ABSENT'}`);

    const finalStat = await stat(pbfPath);
    entries.push({
      name: ex.name,
      fetchedAt: new Date().toISOString(),
      sourceUrl: ex.url,
      snapshotUrl,
      snapshotResolves: snapOk,
      archiveUrl,
      archiveResolves: archOk,
      md5: expectedMd5,
      bytes: finalStat.size,
      lastModified,
      localPath: pbfPath,
      polyPath,
    });
  }

  await writeFile(LOCK_PATH, `${JSON.stringify({ extracts: entries }, null, 2)}\n`, 'utf8');
  console.log(`\nlock written: ${LOCK_PATH}`);
  return entries;
}

export async function readLock(): Promise<{ extracts: LockEntry[] }> {
  if (!existsSync(LOCK_PATH)) {
    throw new Error(`${LOCK_PATH} is missing. Run: npm run fetch:extracts`);
  }
  return JSON.parse(await readFile(LOCK_PATH, 'utf8')) as { extracts: LockEntry[] };
}

if (import.meta.filename === process.argv[1]) {
  const entries = await fetchExtracts();
  const total = entries.reduce((a, e) => a + e.bytes, 0);
  console.log(`\n${entries.length} extracts, ${total.toLocaleString('en-US')} bytes total`);
}
