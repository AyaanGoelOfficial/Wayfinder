# tests/pipeline/fixtures — real bytes, committed on purpose

Holds `real-slice.osm.pbf`: one OSMHeader blob plus the first dense-node, first way and first
relation block, copied verbatim out of the northern-zone extract with their framing intact.

- **This is the ONE exception to the ban on committing a `.osm.pbf`**, carved narrowly into
  `.gitignore`. `hard-rules.md` bans committing an extract because extracts are hundreds of MB
  and reproducible from `config/city.ts`; a 1.23 MB slice is neither. It exists because 48
  synthetic protobuf tests all passed against a decoder that desynced on nearly every real
  parse: the test encoder and the decoder shared one wrong assumption. Synthetic fixtures test
  BRANCHES, real bytes test ASSUMPTIONS.
- **Size is asserted by the test suite (under 2 MB)** so a careless re-slice cannot smuggle a
  real extract in behind the gitignore exception.
- **EXPECTED VALUES MUST COME FROM AN INDEPENDENT READER**, never from our own decoder.
  `real-bytes.test.ts` uses pyosmium (libosmium), pointed at this same file. A value copied out
  of our output would only prove the decoder is self-consistent, which it was while broken.
- **Regenerate with `npm run make:fixture`.** Provenance, including the source extract md5 and
  the byte offsets each blob was taken from, is in `real-slice.provenance.json`.
- **The blocks are unrelated to each other**, so its ways reference nodes the file does not
  contain. That is fine for decoder tests and makes it a PATHOLOGICAL input for anything that
  builds geometry. Do not use it to test tilemaker or the graph builder.
