/**
 * Copy gate. Enforces the punctuation ban in .claude/rules/copy.md mechanically, because
 * these characters are near-invisible in review and this is the check that fails most
 * often after a copy edit.
 *
 * Banned in user-facing strings: em dash (U+2014), en dash standing in for one (U+2013),
 * interpunct (U+00B7).
 *
 * Exempt per copy.md: code comments, identifiers, log output, commit messages, and repo
 * docs such as CLAUDE.md and the files in .claude/. This script scans source files only,
 * and strips comments before scanning so a comment cannot fail the build.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, relative, extname } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
// Written as code points on purpose: spelling the characters literally would make this
// file fail its own gate, which is how a check ends up with an exclusion carved into it.
const BANNED = new RegExp("[\u2014\u2013\u00B7]");
const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.html', '.css']);
const SKIP_DIR = new Set(['node_modules', '.git', 'data', 'tools', 'dist', 'build', 'coverage', '.claude']);

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Removes line comments, block comments and their contents so an exempt comment cannot
 * trip the gate. Deliberately simple: it does not parse strings containing "//", which
 * would at worst under-report inside a URL literal. Erring toward fewer false positives is
 * right here because a false positive trains people to bypass the gate.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1: string) => p1);
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.') {
      if (SKIP_DIR.has(e.name)) continue;
    }
    if (SKIP_DIR.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (SCAN_EXT.has(extname(e.name))) out.push(p);
  }
  return out;
}

export async function runCopyGate(): Promise<Hit[]> {
  const files = await walk(ROOT);
  const hits: Hit[] = [];
  for (const f of files) {
    const src = stripComments(await readFile(f, 'utf8'));
    src.split('\n').forEach((line, i) => {
      if (BANNED.test(line)) hits.push({ file: relative(ROOT, f), line: i + 1, text: line.trim() });
    });
  }
  return hits;
}

if (import.meta.filename === process.argv[1]) {
  const hits = await runCopyGate();
  if (hits.length === 0) {
    console.log('copy gate PASS: no em dash, en dash, or interpunct in user-facing strings');
    process.exit(0);
  }
  console.error(`copy gate FAIL: ${hits.length} hit(s)`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.text.slice(0, 100)}`);
  console.error('\nUse a comma, a colon, parentheses, or two sentences. For lists use / or |.');
  process.exit(1);
}
