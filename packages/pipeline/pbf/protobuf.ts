/**
 * Minimal protobuf wire-format reader. Enough for the OSM PBF schema, nothing more.
 *
 * WHY BY HAND: the pipeline needs to dedupe by element id, clip to BUILD_AREA, and merge
 * two files while streaming, all in one pass. That wants direct control of the decode loop.
 * The alternative, osm-pbf-parser, was last published 2022-11-08 and predates Node 24.
 *
 * NUMBERS, NOT BIGINT. Every id and coordinate in OSM fits comfortably inside 2^53: the
 * largest node id is around 1.3e10 and scaled coordinates are around 1e9. BigInt would cost
 * roughly an order of magnitude in the hot loop for range we do not use. The varint and
 * zigzag helpers below are written to stay exact to 53 bits, which is why they use
 * multiplication rather than the usual bit shifts. A shift-based varint silently corrupts
 * anything past 32 bits, which is the single easiest way to get this wrong.
 */

/**
 * A plain object, NOT a `const enum`, because `const enum` is incompatible with
 * `isolatedModules` (on repo-wide) and its cross-module behaviour under esbuild is a trap
 * worth not standing near.
 */
export const WireType = {
  Varint: 0,
  Fixed64: 1,
  Bytes: 2,
  Fixed32: 5,
} as const;

export type WireType = (typeof WireType)[keyof typeof WireType];

export class Reader {
  public pos = 0;

  constructor(
    public readonly buf: Uint8Array,
    public readonly end: number = buf.length,
  ) {}

  get hasMore(): boolean {
    return this.pos < this.end;
  }

  /**
   * Reads a base-128 varint as a Number, exact to 2^53.
   * Uses multiplication past the 28-bit mark because `<<` in JS is a 32-bit operation.
   */
  readVarint(): number {
    let value = 0;
    let shift = 1;
    for (;;) {
      if (this.pos >= this.end) throw new Error('varint ran past end of buffer');
      const b = this.buf[this.pos++] as number;
      value += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) return value;
      shift *= 128;
      if (shift > 2 ** 56) throw new Error('varint exceeds 56 bits, refusing to lose precision');
    }
  }

  /**
   * Zigzag-decoded signed varint. Written with % and / rather than `>>> 1 ^ -(n & 1)`
   * because the bitwise form truncates to 32 bits and OSM deltas exceed that.
   */
  readSVarint(): number {
    const n = this.readVarint();
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  }

  readTag(): { field: number; wire: WireType } {
    const key = this.readVarint();
    return { field: key >>> 3, wire: (key & 7) as WireType };
  }

  readBytes(): Uint8Array {
    const len = this.readVarint();
    const start = this.pos;
    this.pos += len;
    if (this.pos > this.end) throw new Error('length-delimited field ran past end of buffer');
    return this.buf.subarray(start, this.pos);
  }

  readString(): string {
    return new TextDecoder('utf-8').decode(this.readBytes());
  }

  /** Skips a field of the given wire type. Unknown fields must be skipped, not guessed. */
  skip(wire: WireType): void {
    switch (wire) {
      case WireType.Varint:
        this.readVarint();
        return;
      case WireType.Fixed64:
        this.pos += 8;
        return;
      case WireType.Bytes: {
        // MUST read the length into a local first. `this.pos += this.readVarint()`
        // evaluates `this.pos` BEFORE the call, so the bytes consumed by the length varint
        // itself are lost and the stream desyncs by exactly that many bytes. OSM PBF skips
        // length-delimited fields constantly (DenseInfo, Info, unknown fields), so this
        // corrupts almost every real parse while looking correct on trivial input.
        const len = this.readVarint();
        this.pos += len;
        return;
      }
      case WireType.Fixed32:
        this.pos += 4;
        return;
      default:
        throw new Error(`unknown wire type ${String(wire)}`);
    }
  }

  /** Returns a Reader scoped to a length-delimited submessage. */
  readMessage(): Reader {
    const bytes = this.readBytes();
    return new Reader(bytes);
  }
}

/** Reads a packed repeated varint field into `out`, returning the count appended. */
export function readPackedVarint(r: Reader, out: number[]): number {
  const bytes = r.readBytes();
  const sub = new Reader(bytes);
  let n = 0;
  while (sub.hasMore) {
    out.push(sub.readVarint());
    n++;
  }
  return n;
}

/** Reads a packed repeated sint64 (zigzag) field into `out`. */
export function readPackedSVarint(r: Reader, out: number[]): number {
  const bytes = r.readBytes();
  const sub = new Reader(bytes);
  let n = 0;
  while (sub.hasMore) {
    out.push(sub.readSVarint());
    n++;
  }
  return n;
}
