# Progress and known weaknesses

Split out of the root `CLAUDE.md` when that file hit the 250-line cap in `hard-rules.md`. Nothing
was deleted in the move. This holds project STATUS, which rots; `CLAUDE.md` holds the facts that
must be true for every task, and `DESIGN.md` holds decisions and the evidence behind them.

Update this in the same change that invalidates a line in it, never as a follow-up.

## Gate status

| Gate | State |
|---|---|
| 1 city build | closed. Graph, places and tiles from one merged, deduped source |
| 2 map on screen | closed. Own PMTiles, own style, own SDF glyphs, Devanagari confirmed rendering |
| 3 Dijkstra routing | closed. Route endpoint, client rendering, charter items 1 and 2 measured |
| 4 OSRM validation | Tooling built, baseline measured, **FAILS**. Distance median 3.39% against 3%, p95 17.90% against 7%. See `VALIDATION.md` |
| 5 A\* and bidirectional | Tooling built, baseline measured, both budgets **missed**. Re-route p95 359.50 ms against 30 ms; initial p95 386.24 ms against 150 ms. See `BENCHMARKS.md`. Algorithms NOT started |
| 6 legality pass | NOT started. The U-turn penalty is specified in `DESIGN.md` and lands here |
| 7 search and turn-by-turn | NOT started. Places index and fuzzy search exist; instructions do not |
| 8 tracking | NOT started. Must not start before the U-turn penalty lands |
| 9 phone verification | NOT started |

## Known weaknesses

- **The places index EXISTS and is cross-validated: 7,675 entries.** `npm run gate:oracle` checks
  it against pyosmium, by set difference over ids and names rather than by counts. That gate found
  35 entries lying outside `BUILD_AREA`, including a fort in Delhi, because the clip carries
  out-of-area nodes for way completeness and those nodes arrive with their tags. Fixed. Search
  ranking itself is still gate 7.
- **The oracle's `--full` layer has NEVER been run to completion.** The default layer reads our own
  written PBF, so it cannot see an element the clip wrongly DROPPED. Closing that gap needs 91.5M
  Python callbacks at roughly 6,200 objects per second, about four hours.
- **Graph scale is MEASURED and small: 213,144 vertices, 532,951 directed edges** after
  largest-SCC filtering, from 1,893,860 deduped in-area nodes. That is an order of magnitude
  below the ~10^6 feared. CH still gets decided at gate 5 on measured p95 route compute under
  30 ms, not on this count, but nothing about this scale suggests it will be needed.
- **Both routing budgets are missed, measured properly.** Re-route p95 **359.50 ms** against 30 ms;
  initial-route p95 **386.24 ms** against 150 ms. Re-route p50 is 43.72 ms, so the distribution is
  easier on average and its p95 is set by early-trip long re-routes, which are in the sample on
  purpose. `npm run bench`, `BENCHMARKS.md`.
- **Gate 4 divergence from OSRM exceeds the threshold, in BOTH directions.** Worst cases run from
  +37.5% (we are 12 km longer) to -37.5% (we are 24 km shorter). Longer suggests a missing road or
  over-restriction; shorter suggests we permit something OSRM does not, which is the more serious
  reading. One landmark pair, `gautam-buddha-university to jewar`, is +37.49% and sits well inside
  the area, so it carries no near-boundary excuse. Not yet investigated.
- **tilemaker wall time in the build report is contaminated by concurrent load.** Isolated it takes
  about **18 s**, measured twice (18.4 s to `%TEMP%`, 17.96 s into `data/`), so output location and
  OneDrive are ruled out. One recorded build said 2,425.4 s for byte-identical output, 132x. The
  contaminating factor was never identified. Never quote a build-report wall time without saying
  what else was running.
- **There is no U-turn prohibition.** Measured at 0 occurrences across 92 km of real routes, with
  controls proving the U-turn was offered and lost on cost. The fix is a PENALTY, specified in
  `DESIGN.md`, and it must land before gate 8.
- **Speeds are ESTIMATES, not measurements.** Only 1,773 of 121,084 drivable ways carry a
  parseable `maxspeed`; the other 98.5% use the class-default table. Gate 6 divergence from OSRM
  will come mostly from here and from highway classification, not from turn restrictions.
- **Turn restrictions are sparse: 55 in the build area.** 52 are enforced, 40 by via-node pair and
  12 by via-way sequence; 3 are malformed and correctly ignored; 0 are unenforced.
- **`osm-pbf-parser` is 3.5 years stale** and predates Node 24. Verified to exist, not
  verified to run. Fallback is hand-rolled protobuf decode over `pbf` plus zlib.
- **Kasna is not a mapped place.** Verified against raw OSM: zero `place=*` under any
  spelling; only `Old Kasana Road` and `Kasana Nursing Home`, both spelled Kasana. It is
  kept as a search fixture on purpose, to test fuzzy matching and road indexing.
- **MapLibre does not shape Indic text.** Devanagari labels render with correct glyphs in logical
  order, but conjuncts and half-forms do not form, so explicit viramas are visible. Confirmed on
  screen at gate 2 and recorded in `packages/pipeline/glyphs/CLAUDE.md`.
