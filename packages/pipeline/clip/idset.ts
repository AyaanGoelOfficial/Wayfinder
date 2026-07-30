/**
 * Open-addressed hash containers keyed by OSM element id, backed by typed arrays.
 *
 * Why not a plain `Set<number>` / `Map<number, number>`: the in-area node set reaches a few
 * million entries, and V8 spends roughly 50 to 80 bytes per entry on those. That is hundreds
 * of MB of overhead for what is genuinely 8 bytes of key. These use a Float64Array of keys
 * with linear probing, which is 12 bytes per slot including the value and stays flat.
 *
 * Float64Array, not BigInt64Array or two Int32Arrays: OSM ids run to about 1.3e10 today,
 * far past 2^32 but far inside 2^53, so a double holds them exactly. Root CLAUDE.md records
 * the same reasoning for the decoder.
 *
 * Id 0 is the empty sentinel. OSM element ids start at 1, and `add(0)` throws rather than
 * silently occupying a slot that reads back as empty.
 */

const EMPTY = 0;

/** Mixes a 53-bit integer id into 32 bits. Splitting at 2^26 keeps both halves exact. */
function hashId(id: number, mask: number): number {
  const lo = id % 67_108_864; // 2^26
  const hi = (id - lo) / 67_108_864;
  let h = Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h & mask;
}

function capacityFor(expected: number): number {
  // Load factor stays under 0.5. Linear probing degrades badly past about 0.7, and the
  // memory saved by running hot is not worth the probe-length cliff during a build.
  let cap = 1024;
  while (cap * 0.5 < expected) cap *= 2;
  return cap;
}

export class IdSet {
  private keys: Float64Array;
  private mask: number;
  private count = 0;

  constructor(expected = 1024) {
    const cap = capacityFor(expected);
    this.keys = new Float64Array(cap);
    this.mask = cap - 1;
  }

  get size(): number {
    return this.count;
  }

  /** Slots allocated, not entries used. Reported in the build report as a memory figure. */
  get capacity(): number {
    return this.keys.length;
  }

  has(id: number): boolean {
    const keys = this.keys;
    let i = hashId(id, this.mask);
    for (;;) {
      const k = keys[i] as number;
      if (k === id) return true;
      if (k === EMPTY) return false;
      i = (i + 1) & this.mask;
    }
  }

  /** Returns true when the id was newly inserted, false when it was already present. */
  add(id: number): boolean {
    if (id === EMPTY) throw new Error('id 0 is the empty sentinel and cannot be stored');
    const keys = this.keys;
    let i = hashId(id, this.mask);
    for (;;) {
      const k = keys[i] as number;
      if (k === id) return false;
      if (k === EMPTY) {
        keys[i] = id;
        this.count++;
        if (this.count * 2 > keys.length) this.grow();
        return true;
      }
      i = (i + 1) & this.mask;
    }
  }

  private grow(): void {
    const old = this.keys;
    const cap = old.length * 2;
    this.keys = new Float64Array(cap);
    this.mask = cap - 1;
    for (let j = 0; j < old.length; j++) {
      const id = old[j] as number;
      if (id === EMPTY) continue;
      let i = hashId(id, this.mask);
      while ((this.keys[i] as number) !== EMPTY) i = (i + 1) & this.mask;
      this.keys[i] = id;
    }
  }
}

/** Same layout as IdSet with a parallel Int32Array of values. Used for id to dense index. */
export class IdMap {
  private keys: Float64Array;
  private vals: Int32Array;
  private mask: number;
  private count = 0;

  constructor(expected = 1024) {
    const cap = capacityFor(expected);
    this.keys = new Float64Array(cap);
    this.vals = new Int32Array(cap);
    this.mask = cap - 1;
  }

  get size(): number {
    return this.count;
  }

  get capacity(): number {
    return this.keys.length;
  }

  /** Returns -1 when absent. Callers must not store -1 as a legitimate value. */
  get(id: number): number {
    const keys = this.keys;
    let i = hashId(id, this.mask);
    for (;;) {
      const k = keys[i] as number;
      if (k === id) return this.vals[i] as number;
      if (k === EMPTY) return -1;
      i = (i + 1) & this.mask;
    }
  }

  has(id: number): boolean {
    return this.get(id) !== -1;
  }

  /**
   * First-write-wins, which is the dedupe policy the whole merge depends on: the two
   * Geofabrik extracts overlap along the Central/Northern seam, so the same element arrives
   * twice and the second copy must be dropped, not blended. Returns false when the id was
   * already present and the existing value was kept.
   */
  set(id: number, value: number): boolean {
    if (id === EMPTY) throw new Error('id 0 is the empty sentinel and cannot be stored');
    if (value < 0) throw new Error(`value ${value} is negative; -1 is reserved for absent`);
    const keys = this.keys;
    let i = hashId(id, this.mask);
    for (;;) {
      const k = keys[i] as number;
      if (k === id) return false;
      if (k === EMPTY) {
        keys[i] = id;
        this.vals[i] = value;
        this.count++;
        if (this.count * 2 > keys.length) this.grow();
        return true;
      }
      i = (i + 1) & this.mask;
    }
  }

  private grow(): void {
    const oldKeys = this.keys;
    const oldVals = this.vals;
    const cap = oldKeys.length * 2;
    this.keys = new Float64Array(cap);
    this.vals = new Int32Array(cap);
    this.mask = cap - 1;
    for (let j = 0; j < oldKeys.length; j++) {
      const id = oldKeys[j] as number;
      if (id === EMPTY) continue;
      let i = hashId(id, this.mask);
      while ((this.keys[i] as number) !== EMPTY) i = (i + 1) & this.mask;
      this.keys[i] = id;
      this.vals[i] = oldVals[j] as number;
    }
  }
}
