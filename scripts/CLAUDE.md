# scripts — one-shot operator commands, not library code

Everything here is invoked by an `npm run` script and is allowed to touch the network, the
filesystem, and `tools/`. Nothing in `packages/` may import from here.

- **NEVER pin tilemaker to `latest`.** v3.1.0 publishes zero release assets (verified
  2026-07-29 against the GitHub releases API); v3.0.0 is the newest tag with prebuilt
  binaries. Building from source needs Boost, Lua, protobuf and shapelib, which is the
  toolchain burden this project exists to avoid. Check assets exist before bumping.
- **`tools/` and `data/` are git-ignored and disposable.** Any script here must be able to
  recreate its outputs from nothing. If a script needs a file it did not fetch, it must say
  which command produces it, not fail with ENOENT.
- **Every script that fetches from the network verifies what it got.** Size, checksum, or a
  parse. A silent truncated download becomes a silently truncated city, and that failure
  surfaces thousands of lines later as "no route found".
- **`derive-bbox.ts` is the only thing allowed to write `BUILD_AREA` into `config/city.ts`.**
  Hand-editing that constant is a defect; `tests/config/fixtures.test.ts` recomputes it from
  `RELATION_BBOX` and will go red.
- **Long-running scripts print progress with counts, not spinners.** These run for minutes
  over a 546 MB input, and a number that stops moving is the only usable failure signal.
