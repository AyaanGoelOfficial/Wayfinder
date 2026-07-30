# tests/pipeline — decoder correctness, provable without the extracts

These run on every `npm test`, need no `data/`, and must stay instant. The pipeline's
correctness floor is here: if the wire reader is wrong, every count, every coordinate and
every route downstream is wrong in a way that still looks plausible.

- **The encoder in `protobuf.test.ts` is test-only and deliberately independent.** It exists
  so the decoder is checked against the protobuf spec rather than against itself. Never
  import the production encoder here, and never "simplify" by round-tripping through the
  reader alone: a reader tested only against its own writer agrees with its own bugs.
- **Boundary values are the whole point.** 2^31, 2^32, 2^40, 2^53-1 and their negatives are
  in the case list because shift-based varint decoding passes every small value and wraps
  silently past 2^31. Do not prune these for being repetitive.
- **The skip-alignment test caught a real desync bug** (`this.pos += this.readVarint()`).
  Keep a test that skips every wire type in sequence and then asserts the NEXT field number,
  because that is the only shape that detects an off-by-N cursor.
- **Keep the Devanagari string case.** Local names need UTF-8, and the Windows default codec
  mangles it. This has already bitten once outside the test suite.
- **Imports:** the pipeline package and Node built-ins. Never the network, never `data/`.
