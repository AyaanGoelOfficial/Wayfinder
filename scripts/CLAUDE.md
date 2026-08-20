# scripts — one-shot operator commands, not library code

## The catalogue

Moved here from the root `CLAUDE.md` when that file hit the 250-line cap. Every entry is a
script in this folder, so this file is already loaded whenever one is touched.

```bash
npm run validate         # 6 landmark + 50 random pairs vs OSRM. Median <3%, p95 <7%
npm run diagnose:route   # WHY a pair diverges, grouped by cause -> DIVERGENCE.md. Add --all
npm run calibrate:speeds # tagged maxspeed per class vs our defaults. Read the sample counts
npm run calibrate:quality # surface/smoothness/lanes coverage per class. Controls printed first
npm run calibrate:epe    # fits EPE chainage to the Gazette plazas. REFUSES on a drifting residual
npm run diagnose:flattening # class ratio, slow-road share, and the straight-line-excess proof
npm run experiment:speeds # A/B a speed table over the same 56 pairs. No rebuild needed
npm run experiment:turns  # A/B the turn cost model. Reports SHAPE overlap, not just the delta
npm run experiment:objective # distance and toll preferences. Route sanity BEFORE divergence
npm run audit:tolls      # every tolled way by name/ref with km. Read-only
npm run audit:epe        # EPE booths, junctions, and which pairs use the road. Read-only
npm run report:tolls     # what the toll model charges, per road and per pair, with the cost A/B
npm run bench            # p50/p95/p99 for route, snap, search -> BENCHMARKS.md
npm run verify:browser   # NOT BUILT until gate 8. Console, visual, network, GPS, throttled
npm run acceptance       # NOT BUILT until gate 9. One pass/fail table, every charter item
```

- **An audit or a report script CHANGES NOTHING and says so in its own output.** `audit:tolls`,
  `audit:epe` and `report:tolls` end by printing that no constant and no model was changed.
  A measurement command that quietly writes a constant is how a fitted number enters the repo
  without anyone deciding to put it there.
- **`calibrate:epe` exits non-zero rather than adopting a mapping it cannot justify.** It fits one
  unknown against eleven published chainages and holds out three independently identified plazas as
  its test. A drifting residual means our carriageway is not the Gazette reference line, and the
  answer to that is a refusal, not an average.

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
- **`npm run diagnose:pair -- <a> <b>`** prices ONE pair term by term under the full objective, both
  our line and OSRM's, with the same estimator on both and the instrument's self-error printed
  beside every verdict. `diagnose:route` sorts all 56 pairs into causes; this argues one of them.
- **`npm run isolate:tolls`** turns each of the three toll changes off from the current state, one
  at a time, over one graph in one process, and re-composes them to check whether they interact.
  They do: the Yamuna interaction term is larger than any single effect.
- **`npm run audit:yamuna`** locates the toll-tag boundary on the Yamuna Expressway: the shared
  node ids and coordinates, the bounding box of the untagged stretch, what meets each end, and the
  toll booths near it. Built because gate 6 closed with that boundary as an open question and a
  latitude is not somewhere a person can stand.
- **`npm run calibrate:epe`** fits the EPE chainage anchor and REFUSES on a drifting residual. It is
  the only thing that may set `EPE_CHAINAGE_AT_CLIP_SOUTH_END_KM`.
  over a 546 MB input, and a number that stops moving is the only usable failure signal.
