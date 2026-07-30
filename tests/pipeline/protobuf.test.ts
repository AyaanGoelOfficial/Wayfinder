import { describe, it, expect } from 'vitest';
import { Reader, WireType, readPackedVarint, readPackedSVarint } from '@wayfinder/pipeline/pbf/protobuf.ts';

/** Test-only encoder. Exists so the decoder is checked against the spec, not against itself. */
function encodeVarint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 128) + 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

function encodeZigzag(n: number): number[] {
  return encodeVarint(n < 0 ? -n * 2 - 1 : n * 2);
}

function bytes(...arrs: number[][]): Uint8Array {
  return Uint8Array.from(arrs.flat());
}

describe('varint decoding stays exact past 32 bits', () => {
  // The classic hand-rolled-decoder bug: a shift-based varint loop uses `<<`, which JS
  // performs in 32 bits, so everything above 2^31 silently wraps. OSM node ids are around
  // 1.3e10 and scaled coordinates around 1e9, so this range is used constantly.
  const cases = [
    0, 1, 127, 128, 129, 255, 256, 16_383, 16_384, 2_097_151, 2_097_152,
    268_435_455, 268_435_456,
    2 ** 31 - 1, 2 ** 31, 2 ** 32, 2 ** 32 + 1,
    2 ** 40, 13_000_000_000, 900_000_000_000, 2 ** 53 - 1,
  ];

  for (const n of cases) {
    it(`round-trips ${n}`, () => {
      const r = new Reader(bytes(encodeVarint(n)));
      expect(r.readVarint()).toBe(n);
    });
  }

  it('consumes exactly the right number of bytes', () => {
    const buf = bytes(encodeVarint(300), encodeVarint(7));
    const r = new Reader(buf);
    expect(r.readVarint()).toBe(300);
    expect(r.readVarint()).toBe(7);
    expect(r.hasMore).toBe(false);
  });

  it('throws rather than silently truncating a malformed varint', () => {
    // 0x80 with the continuation bit set and no terminator.
    const r = new Reader(Uint8Array.from([0x80, 0x80, 0x80]));
    expect(() => r.readVarint()).toThrow(/ran past end/);
  });
});

describe('zigzag decoding handles negatives past 32 bits', () => {
  const cases = [
    0, -1, 1, -2, 2, -64, 64, -8192, 8192,
    2 ** 31 - 1, -(2 ** 31), 2 ** 32, -(2 ** 32),
    -1_300_000_000, 1_300_000_000, -(2 ** 45), 2 ** 45,
  ];

  for (const n of cases) {
    it(`round-trips ${n}`, () => {
      const r = new Reader(bytes(encodeZigzag(n)));
      expect(r.readSVarint()).toBe(n);
    });
  }

  it('maps the canonical zigzag pairs from the protobuf spec', () => {
    // spec: 0->0, -1->1, 1->2, -2->3, 2->4
    const pairs: [number, number][] = [
      [0, 0],
      [1, -1],
      [2, 1],
      [3, -2],
      [4, 2],
    ];
    for (const [encoded, decoded] of pairs) {
      const r = new Reader(bytes(encodeVarint(encoded)));
      expect(r.readSVarint()).toBe(decoded);
    }
  });
});

describe('tags and fields', () => {
  it('splits a key into field number and wire type', () => {
    // field 8, wire 2 -> key = 8<<3 | 2 = 66
    const r = new Reader(bytes(encodeVarint(66)));
    const { field, wire } = r.readTag();
    expect(field).toBe(8);
    expect(wire).toBe(WireType.Bytes);
  });

  it('reads a length-delimited byte field', () => {
    const payload = [1, 2, 3, 4];
    const r = new Reader(bytes(encodeVarint(payload.length), payload));
    expect(Array.from(r.readBytes())).toEqual(payload);
  });

  it('decodes UTF-8 strings, including Devanagari', () => {
    // Local names need this, and the Windows default codec mangles it.
    const s = 'कासना';
    const enc = Array.from(new TextEncoder().encode(s));
    const r = new Reader(bytes(encodeVarint(enc.length), enc));
    expect(r.readString()).toBe(s);
  });

  it('skips every wire type without losing alignment', () => {
    const buf = bytes(
      encodeVarint((1 << 3) | WireType.Varint),
      encodeVarint(999),
      encodeVarint((2 << 3) | WireType.Bytes),
      encodeVarint(3),
      [7, 7, 7],
      encodeVarint((3 << 3) | WireType.Fixed32),
      [0, 0, 0, 0],
      encodeVarint((4 << 3) | WireType.Fixed64),
      [0, 0, 0, 0, 0, 0, 0, 0],
      encodeVarint((5 << 3) | WireType.Varint),
      encodeVarint(42),
    );
    const r = new Reader(buf);
    for (let i = 0; i < 4; i++) {
      const { wire } = r.readTag();
      r.skip(wire);
    }
    const { field } = r.readTag();
    expect(field).toBe(5);
    expect(r.readVarint()).toBe(42);
  });
});

describe('packed repeated fields', () => {
  it('reads a packed varint array', () => {
    const vals = [1, 300, 70_000, 2 ** 33];
    const payload = vals.flatMap(encodeVarint);
    const r = new Reader(bytes(encodeVarint(payload.length), payload));
    const out: number[] = [];
    expect(readPackedVarint(r, out)).toBe(4);
    expect(out).toEqual(vals);
  });

  it('reads a packed zigzag array, which is how deltas arrive', () => {
    const vals = [10, -5, 1_000_000, -1_000_000, 0];
    const payload = vals.flatMap(encodeZigzag);
    const r = new Reader(bytes(encodeVarint(payload.length), payload));
    const out: number[] = [];
    expect(readPackedSVarint(r, out)).toBe(5);
    expect(out).toEqual(vals);
  });

  it('reconstructs a delta-encoded id run the way DenseNodes does', () => {
    const ids = [1_000_000_000, 1_000_000_005, 1_000_000_002, 13_000_000_000];
    const deltas = ids.map((v, i) => (i === 0 ? v : v - (ids[i - 1] as number)));
    const payload = deltas.flatMap(encodeZigzag);
    const r = new Reader(bytes(encodeVarint(payload.length), payload));
    const out: number[] = [];
    readPackedSVarint(r, out);
    let acc = 0;
    const rebuilt = out.map((d) => (acc += d));
    expect(rebuilt).toEqual(ids);
  });
});
