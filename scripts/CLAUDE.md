# scripts — one-shot operator commands, not library code

Everything here is invoked by an `npm run` script and is allowed to touch the network, the
filesystem, and `tools/`. Nothing in `packages/` may import from here.

- **NEVER pin tilemaker to `latest`, and NEVER treat "the release has assets" as "the binary
  works".** v3.1.0 publishes zero assets. v3.0.0 publishes assets whose Windows binary crashes
  with `0xC0000409` before reading any input, reproduced on a pristine Geofabrik extract with
  tilemaker's own bundled config and Lua, from a path containing no spaces, under every
  combination of `--threads 1`, `--store`, `--shard-stores`, `--materialize-geometries` and
  `--fast`. v2.4.0 is pinned because it actually runs. Building from source needs Boost, Lua,
  protobuf and shapelib, the toolchain burden this project exists to avoid. Before bumping:
  check assets exist, then run the binary on real input.
- **`tools/` and `data/` are git-ignored and disposable.** Any script here must be able to
  recreate its outputs from nothing. If a script needs a file it did not fetch, it must say
  which command produces it, not fail with ENOENT.
- **Every script that fetches from the network verifies what it got.** Size, checksum, or a
  parse. A silent truncated download becomes a silently truncated city, and that failure
  surfaces thousands of lines later as "no route found".
- **`derive-bbox.ts` DOES NOT EXIST, though `npm run derive:bbox` and three instruction files
  referenced it.** Nothing here writes `BUILD_AREA` into `config/city.ts`. The constant is still
  guarded, by `tests/config/fixtures.test.ts`, which recomputes it from `RELATION_BBOX` and goes
  red on a hand edit. If this script gets built it becomes the only writer; until then the test is
  the whole enforcement.
- **Long-running scripts print progress with counts, not spinners.** These run for minutes
  over a 546 MB input, and a number that stops moving is the only usable failure signal.
