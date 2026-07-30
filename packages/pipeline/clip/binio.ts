/**
 * Growable byte writer and matching reader for the clip cache.
 *
 * Deliberately small and boring. The clip cache is an internal, disposable artifact keyed by
 * a provenance hash, so it needs speed and exactness, not forward compatibility: when the
 * format changes the hash changes, the cache misses, and it is rebuilt. That is why there is
 * no field tagging and no schema evolution here, unlike the OSM PBF reader in ../pbf.
 *
 * Varints use multiplication rather than bit shifts, for the same reason the PBF reader does:
 * `<<` and `>>>` are 32-bit in JavaScript, and OSM ids run to about 1.3e10. Anything past
 * 2^31 wraps silently, which produces plausible wrong numbers instead of an error.
 */

const MAX_EXACT = 2 ** 53 - 1;

export class ByteWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(initial = 1 << 16) {
    this.buf = new Uint8Array(initial);
  }

  get length(): number {
    return this.len;
  }

  private need(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): void {
    this.need(1);
    this.buf[this.len++] = v;
  }

  /** Unsigned LEB128. Rejects negatives and anything past 2^53-1 rather than truncating. */
  varint(v: number): void {
    if (!Number.isInteger(v) || v < 0) throw new Error(`varint needs a non-negative integer, got ${v}`);
    if (v > MAX_EXACT) throw new Error(`${v} exceeds 2^53-1 and cannot round-trip exactly`);
    this.need(8);
    let x = v;
    while (x >= 128) {
      this.buf[this.len++] = (x % 128) + 128;
      x = Math.floor(x / 128);
      this.need(8);
    }
    this.buf[this.len++] = x;
  }

  /** Zigzag then varint, so small negative deltas stay one byte. */
  svarint(v: number): void {
    this.varint(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  i32(v: number): void {
    this.need(4);
    // Little-endian by hand so the reader does not depend on platform byte order.
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 24) & 0xff;
  }

  bytes(b: Uint8Array): void {
    this.varint(b.length);
    this.need(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  string(s: string): void {
    this.bytes(new TextEncoder().encode(s));
  }

  /** The written bytes. A view, not a copy: do not keep writing after taking it. */
  view(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

export class ByteReader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  get offset(): number {
    return this.pos;
  }

  get hasMore(): boolean {
    return this.pos < this.buf.length;
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw new Error('read past end of clip cache');
    return this.buf[this.pos++] as number;
  }

  varint(): number {
    let value = 0;
    let shift = 1;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error('varint runs past end of clip cache');
      const b = this.buf[this.pos++] as number;
      value += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) return value;
      shift *= 128;
      if (shift > 2 ** 56) throw new Error('varint exceeds 56 bits, refusing to lose precision');
    }
  }

  svarint(): number {
    const n = this.varint();
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  }

  i32(): number {
    const b = this.buf;
    const p = this.pos;
    if (p + 4 > b.length) throw new Error('i32 runs past end of clip cache');
    this.pos = p + 4;
    return ((b[p] as number) | ((b[p + 1] as number) << 8) | ((b[p + 2] as number) << 16) | ((b[p + 3] as number) << 24));
  }

  bytes(): Uint8Array {
    // Length into a local first. `this.pos += this.varint()` would evaluate this.pos before
    // the call and discard the length varint's own bytes. See packages/pipeline/pbf.
    const n = this.varint();
    if (this.pos + n > this.buf.length) throw new Error('byte run passes end of clip cache');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  string(): string {
    return new TextDecoder('utf-8').decode(this.bytes());
  }
}
