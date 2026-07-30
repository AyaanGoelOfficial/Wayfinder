/**
 * Generates MapLibre SDF glyph ranges from vendored fonts, offline.
 *
 * WHY WE GENERATE THEM: MapLibre cannot draw a single label without signed-distance-field glyph
 * ranges, and this project fetches nothing from a public endpoint at runtime. `fontnik`, the
 * purpose-built generator, needs a native build and fails to install on Node 24, so the SDF is
 * computed here in plain TypeScript over `opentype.js`. That is more code than a dependency,
 * but it is the same trade this project makes everywhere else, and it is about 200 lines.
 *
 * WHY A COMPOSITE STACK: Noto Sans contains no Devanagari (क resolves to .notdef) and Noto Sans
 * Devanagari contains no Latin. Local names here are both, often in the same label, so one
 * fontstack is assembled from both faces, per codepoint, with the first face that actually has
 * a glyph winning.
 *
 * SDF, exactly: the distance is computed to the FLATTENED OUTLINE and signed by winding number,
 * rather than by rasterising and running a distance transform over pixels. A pixel-grid
 * transform quantises the distance to whole pixels, and at 24 px per em that is visible as
 * wobble on the halo of every label. Exact distance to the outline costs more arithmetic and
 * produces a clean field.
 *
 * Constants match Mapbox's, because the shader on the other side assumes them: 24 px em, 3 px
 * buffer, 8 px spread, 0.25 cutoff. Changing any of these without changing the client is how
 * labels come out blurry or clipped.
 */
import { readFile } from 'node:fs/promises';
import { ByteWriter } from '../clip/binio.ts';

// opentype.js ships CommonJS. Under Node's ESM interop a namespace import yields
// { default, "module.exports" } and `parse` is NOT on it, so the DEFAULT import is the working
// form. Getting this wrong fails at runtime, not at typecheck.
import opentype from 'opentype.js';

const FONT_SIZE = 24;
const BUFFER = 3;
const RADIUS = 8;
const CUTOFF = 0.25;
/** Codepoints per range file, fixed by the MapLibre URL convention `{range}` = `0-255`. */
export const RANGE_SIZE = 256;

const VARINT = 0;
const BYTES = 2;
function tag(w: ByteWriter, field: number, wire: number): void {
  w.varint(field * 8 + wire);
}

interface Pt {
  readonly x: number;
  readonly y: number;
}

export interface GlyphBitmap {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly advance: number;
  readonly bitmap: Uint8Array;
}

/** Flattens a path's curves into closed polylines. Curve subdivision is by chord length. */
function flatten(path: opentype.Path): Pt[][] {
  const contours: Pt[][] = [];
  let cur: Pt[] = [];
  let x = 0;
  let y = 0;

  const steps = (a: Pt, b: Pt): number => {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    return Math.max(3, Math.min(24, Math.ceil(d * 1.5)));
  };

  for (const cmd of path.commands) {
    if (cmd.type === 'M') {
      if (cur.length > 1) contours.push(cur);
      cur = [{ x: cmd.x, y: cmd.y }];
      x = cmd.x;
      y = cmd.y;
    } else if (cmd.type === 'L') {
      cur.push({ x: cmd.x, y: cmd.y });
      x = cmd.x;
      y = cmd.y;
    } else if (cmd.type === 'Q') {
      const n = steps({ x, y }, { x: cmd.x, y: cmd.y });
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const mt = 1 - t;
        cur.push({
          x: mt * mt * x + 2 * mt * t * cmd.x1 + t * t * cmd.x,
          y: mt * mt * y + 2 * mt * t * cmd.y1 + t * t * cmd.y,
        });
      }
      x = cmd.x;
      y = cmd.y;
    } else if (cmd.type === 'C') {
      const n = steps({ x, y }, { x: cmd.x, y: cmd.y });
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const mt = 1 - t;
        cur.push({
          x: mt * mt * mt * x + 3 * mt * mt * t * cmd.x1 + 3 * mt * t * t * cmd.x2 + t * t * t * cmd.x,
          y: mt * mt * mt * y + 3 * mt * mt * t * cmd.y1 + 3 * mt * t * t * cmd.y2 + t * t * t * cmd.y,
        });
      }
      x = cmd.x;
      y = cmd.y;
    } else if (cmd.type === 'Z') {
      if (cur.length > 1) contours.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) contours.push(cur);
  return contours;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Nonzero winding. Even-odd would hollow out the counters of glyphs like 8 and क incorrectly. */
function isInside(px: number, py: number, contours: readonly Pt[][]): boolean {
  let w = 0;
  for (const c of contours) {
    for (let i = 0; i < c.length; i++) {
      const a = c[i] as Pt;
      const b = c[(i + 1) % c.length] as Pt;
      if (a.y <= py) {
        if (b.y > py && (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y) > 0) w++;
      } else if (b.y <= py && (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y) < 0) w--;
    }
  }
  return w !== 0;
}

export function renderGlyph(font: opentype.Font, codepoint: number): GlyphBitmap | null {
  const glyph = font.charToGlyph(String.fromCodePoint(codepoint));
  if (glyph === undefined || glyph.index === 0) return null;

  const advance = Math.round(((glyph.advanceWidth ?? 0) * FONT_SIZE) / font.unitsPerEm);
  const path = glyph.getPath(0, 0, FONT_SIZE);
  const contours = flatten(path);

  if (contours.length === 0) {
    // A blank glyph such as a space. It still needs an entry, or the shaper has no advance for
    // it and every label containing a space collapses.
    return { id: codepoint, width: 0, height: 0, left: 0, top: 0, advance, bitmap: new Uint8Array(0) };
  }

  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const c of contours) {
    for (const p of c) {
      if (p.x < x1) x1 = p.x;
      if (p.x > x2) x2 = p.x;
      if (p.y < y1) y1 = p.y;
      if (p.y > y2) y2 = p.y;
    }
  }
  const ox = Math.floor(x1);
  const oy = Math.floor(y1);
  const width = Math.ceil(x2) - ox;
  const height = Math.ceil(y2) - oy;
  const bw = width + 2 * BUFFER;
  const bh = height + 2 * BUFFER;
  const bitmap = new Uint8Array(bw * bh);

  for (let py = 0; py < bh; py++) {
    const sy = oy - BUFFER + py + 0.5;
    for (let px = 0; px < bw; px++) {
      const sx = ox - BUFFER + px + 0.5;
      let d = Infinity;
      for (const c of contours) {
        for (let i = 0; i < c.length; i++) {
          const a = c[i] as Pt;
          const b = c[(i + 1) % c.length] as Pt;
          const dd = distToSegment(sx, sy, a.x, a.y, b.x, b.y);
          if (dd < d) d = dd;
        }
      }
      const signed = isInside(sx, sy, contours) ? -d : d;
      let alpha = Math.round(255 - 255 * (signed / RADIUS + CUTOFF));
      if (alpha < 0) alpha = 0;
      else if (alpha > 255) alpha = 255;
      bitmap[py * bw + px] = alpha;
    }
  }

  // `top` is measured UP from the baseline, while opentype's path space has y increasing down.
  return { id: codepoint, width, height, left: ox, top: -oy, advance, bitmap };
}

/** Encodes one range as a `glyphs` message: glyphs { stacks: [ fontstack { glyphs } ] }. */
export function encodeRange(stackName: string, rangeLabel: string, glyphs: readonly GlyphBitmap[]): Uint8Array {
  const stack = new ByteWriter(1 << 16);
  tag(stack, 1, BYTES);
  stack.string(stackName);
  tag(stack, 2, BYTES);
  stack.string(rangeLabel);

  for (const g of glyphs) {
    const gw = new ByteWriter(1 << 12);
    tag(gw, 1, VARINT); gw.varint(g.id);
    if (g.bitmap.length > 0) {
      tag(gw, 2, BYTES);
      gw.bytes(g.bitmap);
    }
    tag(gw, 3, VARINT); gw.varint(g.width);
    tag(gw, 4, VARINT); gw.varint(g.height);
    // left and top are sint32, so they are zigzag encoded. Writing them as plain varints makes
    // every glyph with a negative bearing jump to a huge positive offset.
    tag(gw, 5, VARINT); gw.svarint(g.left);
    tag(gw, 6, VARINT); gw.svarint(g.top);
    tag(gw, 7, VARINT); gw.varint(g.advance);

    tag(stack, 3, BYTES);
    stack.bytes(gw.view());
  }

  const out = new ByteWriter(stack.length + 16);
  tag(out, 1, BYTES);
  out.bytes(stack.view());
  return Uint8Array.prototype.slice.call(out.view());
}

/**
 * The scripts this project commits to rendering, and the faces that cover them.
 *
 * WHY A COMMITTED LIST RATHER THAN "whatever is in the data": the places index contains a
 * handful of names in scripts that have nothing to do with this city, including CJK, an Egyptian
 * hieroglyph and a heart symbol. Covering CJK alone means vendoring roughly 20 MB for about nine
 * characters across three features. That is a bad trade, and pretending otherwise by silently
 * passing the coverage check would be worse.
 *
 * So the line is drawn explicitly: a codepoint in a SUPPORTED script with no glyph is a build
 * FAILURE, because it means a face is missing or wrong. A codepoint outside them is reported
 * with its exact characters and does not fail, because it is a deliberate scope decision rather
 * than an oversight. Urdu is included because it is an additional official language of Uttar
 * Pradesh, so Arabic script here is local, not foreign.
 */
export const SUPPORTED_SCRIPTS: ReadonlyArray<{ name: string; test: (cp: number) => boolean }> = [
  { name: 'Latin and common', test: (cp) => cp <= 0x024f || (cp >= 0x2000 && cp <= 0x206f) },
  { name: 'Devanagari', test: (cp) => cp >= 0x0900 && cp <= 0x097f },
  { name: 'Arabic (Urdu)', test: (cp) => (cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) },
];

export function isSupportedScript(cp: number): boolean {
  return SUPPORTED_SCRIPTS.some((s) => s.test(cp));
}

export interface GlyphBuildStats {
  readonly stackName: string;
  readonly faces: readonly string[];
  readonly rangesWritten: number;
  readonly glyphsRendered: number;
  readonly codepointsRequested: number;
  readonly codepointsMissing: readonly number[];
  readonly totalBytes: number;
  readonly seconds: number;
}

export async function loadFace(path: string): Promise<opentype.Font> {
  const buf = await readFile(path);
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/**
 * Renders every requested codepoint, taking each from the first face that has it.
 *
 * Returns the ranges as bytes plus the codepoints NO face could supply. Those are reported, not
 * swallowed: a missing codepoint means a label somewhere renders as a blank box, and the build
 * asserts against this list.
 */
export function buildRanges(
  stackName: string,
  faces: readonly { name: string; font: opentype.Font }[],
  codepoints: Iterable<number>,
): { ranges: Map<string, Uint8Array>; stats: GlyphBuildStats } {
  const t0 = performance.now();
  const wanted = [...new Set(codepoints)].sort((a, b) => a - b);
  const byRange = new Map<number, GlyphBitmap[]>();
  const missing: number[] = [];
  let rendered = 0;

  for (const cp of wanted) {
    let glyph: GlyphBitmap | null = null;
    for (const f of faces) {
      glyph = renderGlyph(f.font, cp);
      if (glyph !== null) break;
    }
    if (glyph === null) {
      missing.push(cp);
      continue;
    }
    const start = Math.floor(cp / RANGE_SIZE) * RANGE_SIZE;
    const list = byRange.get(start) ?? [];
    list.push(glyph);
    byRange.set(start, list);
    rendered++;
  }

  const ranges = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (const [start, glyphs] of byRange) {
    const label = `${start}-${start + RANGE_SIZE - 1}`;
    const bytes = encodeRange(stackName, label, glyphs);
    ranges.set(label, bytes);
    totalBytes += bytes.length;
  }

  return {
    ranges,
    stats: {
      stackName,
      faces: faces.map((f) => f.name),
      rangesWritten: ranges.size,
      glyphsRendered: rendered,
      codepointsRequested: wanted.length,
      codepointsMissing: missing,
      totalBytes,
      seconds: Number(((performance.now() - t0) / 1000).toFixed(1)),
    },
  };
}
