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
| 4 OSRM validation | **CLOSED** as a documented modelling difference, thresholds untouched. Distance median **2.15%** against 3% and p95 **16.46%** against 7% as of the gate 6 toll model, so the median now PASSES and the p95 does not. It read 3.33% / 25.26% at closure and 3.70% / 30.19% after the gate 5 correctness fixes; the statutory toll model is what brought both down. 0 router bugs, 0 graph defects. 0 router bugs, 0 graph defects; 39 cost model, 16 OSRM leaving the area, 1 too close to call, every pair named in `VALIDATION.md`. The residual is three stated preferences OSRM does not have: a locally calibrated speed table, a distance-and-quality preference, and a toll priced from the published tariff. Acceptance paragraph and reasoning in `DESIGN.md` |
| 5 A\* and bidirectional | **A\* built and proved equal to Dijkstra**; `npm run gate:equality` routes all 39 via-node pair sites and all 12 via-way sites plus landmarks and breadth, 190 pairs, **0 mismatches on path AND cost**. Settled states cut 34.5% on re-routes, 53.3% on landmarks, 0.2% on initial routes. **CLOSED**: bidirectional built, proved equal on all four rungs, and SHIPPED as the served algorithm. The initial-route budget is accepted UNMET and documented as unmeasured on a quiet machine. **Wall time on this machine stays an upper bound**, see below |
| 6 legality pass | NOT started. The U-turn penalty is specified in `DESIGN.md` and lands here |
| 7 search and turn-by-turn | NOT started. Places index and fuzzy search exist; instructions do not |
| 8 tracking | NOT started. Must not start before the U-turn penalty lands |
| 9 phone verification | NOT started. Carries two on-the-ground checks nothing at a desk can do: read the POSTED car toll at the plaza against `TOLL_ROADS` in `config/city.ts` (the Jewar mainline fee, and a Yamuna RAMP board, which is the one rate still resting on a single observation), and judge whether class is standing in acceptably for road surface |

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
- **`npm run bench` now REFUSES to run on an unsteady machine, and the diagnosis behind that is
  measured rather than guessed.** Three consecutive runs of UNMODIFIED Dijkstra reported
  initial-route p95 of 284, 1829 and 1674 ms, with the derived "time saved by A\*" column reading
  +37.2%, then -4.3%, then -278.6% for identical code. Settled counts were identical to the digit
  across all three. Third instance of this class here, after the server boot time and the tilemaker
  wall time. Ruled out BY MEASUREMENT, so nobody repeats the hunt: **dev servers** (nothing
  listening on 8080 or 5173, no node process alive during a contaminated window), **OneDrive** (not
  running at all, despite the synced path), **turbo or thermal decay** (a fixed CPU kernel run 40
  times drifted -14.3%, that is FASTER over the run), **core contention** (14.6% of an 8 core
  machine busy, mostly Chrome, far too little on its own) and **cache contention** (a 32 MB
  pointer-chase kernel measured 1.28x spread against the CPU kernel's 1.39x at the same moment).
  What remains is that the machine is simply not equally fast at all times. So `scripts/lib/machine.ts`
  times a fixed kernel immediately before the benchmark and `bench` exits non-zero above 1.8x spread
  with a checklist of what to close, rather than printing numbers with a caveat nobody reads.
  `timeIt` also takes the MINIMUM of its repeats, since interference is one-sided.
- **BENCHMARKING ONE RUNG AT A TIME IS A BUG, and the preflight does not catch it.** A sequential
  schedule attributes machine drift to whichever rung was running. Measured in a run whose preflight
  PASSED at 1.54x: `dijkstra-h-discarded` does strictly more work than `dijkstra` and settles an
  identical 531,999 states, yet came out **53% faster** on initial routes and **93% slower** on
  re-routes in that same run. Both impossible. `bench` now times every rung back to back on the same
  query and rotates the order by query index, so no rung permanently occupies the cache-cold first
  slot. A preflight bounds the machine at one instant; interleaving is what survives drift across
  the run.
- **THE BIGGEST SINGLE CONTAMINATOR FOUND WAS THIS PROJECT'S OWN GATES.** Running `bench` straight
  after `gate:equality`, which routes 190 pairs across three rungs over a 533k-edge graph, put the
  preflight kernel at 235 to 838 ms against the 24 to 34 ms it measures when settled, a **10x**
  baseline shift with -44.6% drift as it recovered. Leave the machine alone between a heavy gate and
  a benchmark; the preflight now enforces it.
- **A\* settles 34.5% fewer states on re-routes and 0.2% fewer on initial routes.** The initial-route
  figure is not a disappointment, it is the geometry: the p95 of that sample is set by the four
  pinned corner-to-corner queries, where the destination is at the far corner of the build area and
  almost the whole graph genuinely lies between. A heuristic cannot prune what is on the way.
  Landmarks, which are real city-scale trips, cut 53.3%.
- **The A\* heuristic must be memoised per vertex, and this was found by measurement.** Evaluating it
  on every push means a haversine per relaxation; on the long queries where A\* prunes nothing that is
  pure overhead. It is now cached per vertex behind the same generation counter as the search state,
  turning O(relaxations) haversines into O(vertices touched). **The benefit is UNVERIFIED by timing**,
  because of the contamination above; the argument for it is structural.
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
  the only toll spelling present. Artifact v5. `avoidTolls` leaves 0 of 56 pairs unrouted.
- **SUPERSEDED AT GATE 6, and the two bullets above about the 2.65 rupees/km tariff are history.**
  Neither road that carries our tolled network charges per kilometre. The Yamuna Expressway bills at
  barriers plus ramp plazas; the Eastern Peripheral is a closed system billing a statutory matrix
  from Gazette S.O. 613(E). The cost of an hour of driving was restated at 550 rupees under a name
  that says what it is. Distance median 3.70% to **2.15%**, p95 30.19% to **16.46%**, the largest
  single improvement recorded here. Reasoning in `DESIGN.md`; numbers reproducible by
  `npm run report:tolls`.
- **What the toll model still does NOT know.** NE3 collects only for exit from EPE, so the real
  matrix is asymmetric at one plaza and we model it as symmetric; no validation pair reaches NE3.
  Table 1 of the notification is not in our excerpt, so the per-kilometre rate is fitted to two rate
  boards rather than read from the statute. Yamuna ramp fees rest on ONE photographed board and are
  therefore not encoded at all, the road's reported per-km basis standing in. Each is deferred with
  a revisit condition in `DESIGN.md`.
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
