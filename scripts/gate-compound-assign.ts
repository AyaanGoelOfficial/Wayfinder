/**
 * Compound-assignment gate. Sweeps the bug class behind the decoder desync rather than
 * the single instance that was fixed.
 *
 * The bug: `this.pos += this.readVarint()`. JavaScript evaluates the assignment target's
 * reference BEFORE evaluating the right-hand side, then writes `oldValue + rhs` back. So
 * any mutation the callee performs on that same target is read too early and then
 * overwritten. `readVarint` advances `this.pos` past the varint's own bytes; that advance
 * is silently discarded and the stream desyncs by exactly that many bytes.
 *
 * The hazard needs two things at once: the assignment target must be reachable by the
 * callee, and the right-hand side must call something. So this gate flags a compound
 * assignment when the target is member access (`this.x`, `obj.x`, `arr[i]`) or a captured
 * variable, AND the right-hand side contains a call anywhere in its subtree.
 *
 * A plain local is safe and is NOT flagged: `let sum = 0; sum += f(x)` cannot be reached
 * by `f` unless `f` closes over it, and the capture case is detected separately below.
 *
 * WHY THIS IS NOT AN ESLINT RULE: there is no lint step in this repo by design (root
 * CLAUDE.md § Commands), no built-in ESLint rule covers this pattern, and a custom one
 * would mean a plugin plus about ten packages. This is 100 lines against the TypeScript
 * compiler that is already a devDependency, and it matches the gate-copy.ts shape.
 *
 * The fix at every hit is the same: hoist the right-hand side into a local first.
 *   const len = this.readVarint();
 *   this.pos += len;
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, relative, extname } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');
const SCAN_EXT = new Set(['.ts', '.tsx']);
const SKIP_DIR = new Set([
  'node_modules', '.git', 'data', 'tools', 'dist', 'build', 'coverage', '.claude',
]);

const COMPOUND = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
]);

export interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly why: string;
}

function containsCall(node: ts.Node): boolean {
  if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) {
    return true;
  }
  return ts.forEachChild(node, containsCall) ?? false;
}

function isFunctionLike(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessor(n) ||
    ts.isSetAccessor(n)
  );
}

/**
 * True when `name` is NOT bound inside the function that immediately encloses `from`,
 * meaning the assignment mutates state declared in an outer scope. A callee can reach that
 * state, so the evaluation-order hazard applies. Purely syntactic on purpose: it needs to
 * run against in-memory text for the self-test, with no Program and no type checker.
 */
function isCaptured(from: ts.Node, name: string): boolean {
  let fn: ts.Node | undefined = from;
  while (fn && !isFunctionLike(fn)) fn = fn.parent;
  if (!fn) return true; // module top level: any function in the file can reach it

  for (const p of (fn as ts.SignatureDeclaration).parameters ?? []) {
    if (ts.isIdentifier(p.name) && p.name.text === name) return false;
  }

  let bound = false;
  const visit = (n: ts.Node): void => {
    if (bound) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      bound = true;
      return;
    }
    if (n !== fn && isFunctionLike(n)) return; // a nested function's locals are not ours
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  return !bound;
}

export function analyze(fileName: string, src: string): Hit[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.ESNext, true);
  const hits: Hit[] = [];

  const visit = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && COMPOUND.has(n.operatorToken.kind)) {
      const lhs = n.left;
      if (containsCall(n.right)) {
        let why = '';
        if (ts.isPropertyAccessExpression(lhs) || ts.isElementAccessExpression(lhs)) {
          why = 'target is member access, so the callee can reach it';
        } else if (ts.isIdentifier(lhs) && isCaptured(n, lhs.text)) {
          why = `"${lhs.text}" is declared in an outer scope, so the callee can reach it`;
        }
        if (why) {
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
          hits.push({
            file: fileName,
            line: line + 1,
            text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 120),
            why,
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return hits;
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (SCAN_EXT.has(extname(e.name))) out.push(p);
  }
  return out;
}

/**
 * Positive control, per hard-rules.md § Evidence: a scan that reports zero and a scan that
 * is broken produce identical output. The gate refuses to report PASS unless it has just
 * re-detected the original bug and correctly ignored the safe shapes.
 */
const CONTROL_BAD = `
class R {
  pos = 0;
  readVarint(): number { this.pos += 1; return 7; }
  skip(): void { this.pos += this.readVarint(); }
  shift(): void { this.pos <<= this.readVarint(); }
}
let cursor = 0;
function read(): number { cursor += 1; return 2; }
function step(): void { cursor += read(); }
`;

const CONTROL_GOOD = `
class R {
  pos = 0;
  readVarint(): number { return 7; }
  skip(): void { const len = this.readVarint(); this.pos += len; }
  fixed(): void { this.pos += 8; }
}
function sum(xs: number[]): number {
  let total = 0;
  for (const x of xs) total += Math.abs(x);
  return total;
}
`;

export function selfTest(): { ok: boolean; detail: string } {
  const bad = analyze('control-bad.ts', CONTROL_BAD);
  const good = analyze('control-good.ts', CONTROL_GOOD);
  const wantBad = 3; // this.pos +=, this.pos <<=, captured cursor +=
  if (bad.length !== wantBad) {
    return { ok: false, detail: `control expected ${wantBad} hits, analyzer found ${bad.length}` };
  }
  if (good.length !== 0) {
    return { ok: false, detail: `safe control expected 0 hits, analyzer found ${good.length}: ${good.map((h) => h.text).join(' | ')}` };
  }
  return {
    ok: true,
    detail: `detected ${bad.length}/${wantBad} known-bad, 0 false positives on hoisted, literal and plain-local shapes`,
  };
}

export async function runCompoundAssignGate(): Promise<Hit[]> {
  const files = await walk(ROOT);
  const hits: Hit[] = [];
  for (const f of files) {
    hits.push(
      ...analyze(relative(ROOT, f).replace(/\\/g, '/'), await readFile(f, 'utf8')),
    );
  }
  return hits;
}

if (import.meta.filename === process.argv[1]) {
  const control = selfTest();
  if (!control.ok) {
    console.error(`compound-assign gate BROKEN: ${control.detail}`);
    console.error('The scan is not trustworthy. Fix the analyzer before reading its result.');
    process.exit(1);
  }
  console.log(`compound-assign control OK: ${control.detail}`);

  const hits = await runCompoundAssignGate();
  if (hits.length === 0) {
    console.log('compound-assign gate PASS: no compound assignment has a call on its right-hand side that could reach its target');
    process.exit(0);
  }
  console.error(`compound-assign gate FAIL: ${hits.length} hit(s)`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.text}\n      ${h.why}`);
  console.error('\nHoist the right-hand side into a local first, then assign.');
  process.exit(1);
}
