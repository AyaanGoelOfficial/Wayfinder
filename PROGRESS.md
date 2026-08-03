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
| 4 OSRM validation | **CLOSED** as a documented modelling difference, thresholds untouched. Distance median **3.33%** against 3% and p95 **25.26%** against 7%, both fail as raw numbers. 0 router bugs, 0 graph defects; 39 cost model, 16 OSRM leaving the area, 1 too close to call, every pair named in `VALIDATION.md`. The residual is three stated preferences OSRM does not have: a locally calibrated speed table, a distance-and-quality preference, and a toll priced from the published tariff. Acceptance paragraph and reasoning in `DESIGN.md` |
| 5 A\* and bidirectional | Tooling built, baseline measured, both budgets **missed**. Re-route p95 359.50 ms against 30 ms; initial p95 386.24 ms against 150 ms. See `BENCHMARKS.md`. Algorithms NOT started |
| 6 legality pass | NOT started. The U-turn penalty is specified in `DESIGN.md` and lands here |
| 7 search and turn-by-turn | NOT started. Places index and fuzzy search exist; instructions do not |
| 8 tracking | NOT started. Must not start before the U-turn penalty lands |
| 9 phone verification | NOT started. Carries two on-the-ground checks nothing at a desk can do: read the POSTED car toll at the plaza against the 2.65 rupees/km in `config/city.ts`, and judge whether class is standing in acceptably for road surface |

## Known weaknesses

- **The places index EXISTS and is cross-validated: 7,675 entries.** `npm run gate:oracle` checks
  it against pyosmium, by set difference over ids and names rather than by counts. That gate found
  35 entries lying outside `BUILD_AREA`, including a fort in Delhi, because the clip carries
  out-of-area nodes for way completeness and those nodes arrive with their tags. Fixed. Search
  ranking itself is still gate 7.
- **The oracle's `--full` layer HAS been run to completion and passes.** 100,532,247 objects in
  993 s on an idle machine. Clip selection from the raw extracts agrees exactly: 1,893,860 in-area
  nodes, 334,496 kept ways, 2,354 kept relations, and seam duplicates of 74,519 nodes and 8,560
  ways. That last one is the check nothing else can make, and it is the independent proof that the
  Central/Northern dedupe runs and is correct. The clip stage is no longer an unvalidated step.
- **Graph scale is MEASURED and small: 213,144 vertices, 532,951 directed edges** after
  largest-SCC filtering, from 1,893,860 deduped in-area nodes. That is an order of magnitude
  below the ~10^6 feared. CH still gets decided at gate 5 on measured p95 route compute under
  30 ms, not on this count, but nothing about this scale suggests it will be needed.
- **Both routing budgets are missed, measured properly.** Re-route p95 **359.50 ms** against 30 ms;
  initial-route p95 **386.24 ms** against 150 ms. Re-route p50 is 43.72 ms, so the distribution is
  easier on average and its p95 is set by early-trip long re-routes, which are in the sample on
  purpose. `npm run bench`, `BENCHMARKS.md`.
- **Gate 4 divergence is the SPEED TABLE, and nothing else.** Investigated pair by pair with
  `npm run diagnose:route -- --all`: 40 of 56 pairs are cost model, 16 are OSRM leaving
  `BUILD_AREA`, and **0 are router bugs, 0 are graph defects**. The search was cleared by routing
  our own engine between OSRM's OWN endpoints, the only comparison that can accuse it; the graph
  was cleared by two independent coverage measures that agree. Swapping only the class defaults
  moves `gautam-buddha-university to jewar` from +37.49% to -0.72%, which proves the table is the
  whole cause. It does not prove OSRM's table is right: against our own 1,773 tagged `maxspeed`
  values its defaults sit ABOVE the local posted limit exactly where it helps (trunk 85 against
  70, secondary 55 against 45). The locally-defensible correction makes agreement WORSE. Full
  reasoning in `DESIGN.md`; per-pair table in `DIVERGENCE.md`.
- **The objective is no longer time alone.** A distance preference of 24 s/km DERIVED from the stated
  exchange rate of one minute per 2 to 3 extra km, a per-class road QUALITY weight on top of it, and
  a toll price DERIVED from the published tariff. Reasoning and the full sweep in `DESIGN.md`.
- **The flat distance rate compressed the class hierarchy, and that was the same number as the
  exchange rate, not a side effect of it.** Motorway to tertiary fell 2.571 to 1.982 and the
  tertiary-and-below share of route distance rose 26.80% to 34.42%. 1.982 IS 24 s/km seen as a
  maximum detour multiplier: at that boundary the extra distance buys exactly 2.50 km per minute
  saved. Asserting the ratio must not compress is asserting the exchange rate is infinite.
  `npm run diagnose:flattening` holds the measurement.
- **Road QUALITY weights fixed it, and the sign is the whole point:** a rough kilometre costs more,
  not a long trip. Ratio now **2.688, expanded**; slow-road share back to 30.43%. Weights are a
  stated judgement, NOT from OSM tags, because `npm run calibrate:quality` shows `surface` coverage
  is inversely correlated with need: 50 to 59% of motorway through secondary km against **6.27% of
  unclassified**. `tests/engine/quality.test.ts` asserts the no-compression invariant over every
  class pair, and it overrode two of the first-cut weights.
- **The toll was under-priced by three and a half times, and the distance term had been covering for
  it.** The old 12 s/km was justified only as "half the distance rate", which implies a value of time
  of about 795 rupees an hour. Derived properly it is `2.65 / 225 * 3600` = **42.4 s/km**, from a
  tariff verified against three sources and cross-checked arithmetically (438 rupees over 165.5 km is
  2.647 per km). The landmark answer is -2.23% across the WHOLE value-of-time band, 150 to 300
  rupees an hour, so it does not depend on the midpoint.
- **BOTH distance thresholds now fail and neither was moved.** Median 3.33% against 3%, p95 25.26%
  against 7%. The median had been passing at 2.20%, so this is a real behaviour change: pricing the
  expressway properly takes us off it, 548 tolled km to 310, against a reference that prices no toll
  at all. The `toll at 300 rupees/hour` candidate would pass the median at 2.47% with the best
  overlap in the sweep and the identical landmark answer; it is refused because picking a driver's
  value of time from a divergence table is parity chasing wearing a third hat.
- **Every comparison against an external reference must be re-derived when the objective gains a
  term.** Adding the distance preference made the divergence tool report three router bugs that did
  not exist, because it compared drive time while the router had started minimising drive plus
  distance plus toll. Fourth instance of model-against-measurement in this project. Final partition
  with the objective in force: 33 cost model, 16 outside area, 7 too close to call, **0 router bugs,
  0 graph defects**.
- **Road QUALITY and comfort are not modelled at all.** On the worst residuals our routes run 60 to
  79% tertiary and unclassified. Every such trade is good by the stated exchange rate, but a driver
  may pay a minute for 25 km of highway over 57 km of village road, and nothing in the objective
  represents that. Nearest thing to a remaining gap.
- **Toll data is in the graph, toll PRICE is in the objective.** 920 drivable ways carry `toll=yes`,
  the only toll spelling present. Artifact v3. `avoidTolls` leaves 0 of 56 pairs unrouted.
- **Turn costs now EXIST, and closing that gap moved the shape as well as the number.** Distance
  median 3.39% to **2.73%**, inside its 3% threshold for the first time, and route shape overlap
  with OSRM 70.50% to 75.10%. Both moved together, so the routes genuinely improved rather than the
  metric drifting. Four terms, each isolated in the sweep: severity, crossing oncoming traffic
  (a RIGHT turn here), dropping road class, and the U-turn. `npm run experiment:turns`, reasoning
  in `DESIGN.md`.
- **The U-turn penalty ships UNCALIBRATED, and that is a measurement, not an omission.** Across all
  56 validation pairs the router takes zero U-turns, so the total U-turn penalty charged is 0.0
  minutes and `uturn-only` reproduces `off` to every digit. The validation set carries no signal
  about the number. The mechanism is proved by unit test instead; the value gets calibrated at gate
  8, where re-routing from a matched mid-road position first exercises it.
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
