# packages/pipeline/pbf — hand-written OSM PBF decoder

Streams `.osm.pbf` without holding the file in memory. Written by hand rather than using
`osm-pbf-parser` (last published 2022-11-08, predates Node 24) because the pipeline needs
to dedupe by element id, clip to `BUILD_AREA`, and merge two files in a single pass.

Two bugs already found here by the unit suite. Both are silent, both look correct on small
input, and both are the reason this folder has tests before it has features.

- **NEVER write `this.pos += this.readVarint()`.** JavaScript evaluates the left-hand
  `this.pos` BEFORE the call, so the bytes consumed by the length varint are lost and the
  stream desyncs by exactly that many bytes. Read the length into a local first. This
  corrupts almost every real parse, because OSM PBF skips length-delimited fields constantly
  (`DenseInfo`, `Info`, unknown fields), while passing on trivial input.
- **NEVER decode varints with bit shifts.** `<<` and `>>>` are 32-bit operations in JS, so
  anything past 2^31 silently wraps. OSM node ids run to about 1.3e10 and scaled coordinates
  to about 1e9. Use multiplication, and zigzag with `%` and `/`, not `>>> 1 ^ -(n & 1)`.
- **No `const enum` here.** `isolatedModules` is on repo-wide and the cross-module erasure
  behaviour under esbuild is a trap. Plain object plus a type alias.
- **Numbers, not BigInt.** Every OSM id and scaled coordinate fits inside 2^53. BigInt costs
  roughly an order of magnitude in the hot loop for range that is never used. The helpers are
  written to stay exact to 53 bits and throw rather than lose precision past that.
- **Granularity and offsets are PER BLOCK and must be read, never assumed.** Hardcoding
  `1e-7` works on most files and silently misplaces every coordinate in the ones that set a
  granularity. Coordinates are `1e-9 * (offset + granularity * delta)`.
- **`keys_vals` in DenseNodes is one flat 0-terminated run for the whole block**, not per
  node. Losing the cursor between nodes shifts every subsequent node's tags onto the wrong
  node, which produces a plausible-looking map full of mislabelled places.
- **Unknown fields are SKIPPED, never guessed.** New OSM PBF fields appear over time.
- **Unsupported compression fails loudly.** lzma, bzip2 and zstd blobs throw with the
  encoding named. Geofabrik publishes zlib; a silent skip would yield a partial map.
- **Imports:** Node built-ins only. Never `config/`, never another package.
