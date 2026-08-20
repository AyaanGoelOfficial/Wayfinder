# Design decisions

Decisions that were made once, from measured evidence, and should not be re-litigated without
new numbers. Each records what was decided, the evidence, and what would reopen it.

---

## The precision charter: sloppiness that is explicitly banned

Items 1 to 10 are reproduced verbatim from the project specification. They were referenced by item
number in eight `CLAUDE.md` files and by `gate-fixtures.ts` while living only in an untracked file
outside the repo, so a reader following `charter item 7` had nothing to follow. They are here now.
Item 11 was added at gate 5, from a defect this project actually shipped.

Each item is a common hobby-navigator defect. Each must be prevented and, where marked, tested:

1. **Corner-cutting routes.** The rendered route uses full edge shape geometry, never straight lines
   between graph vertices. A route around a curved sector road must trace the curve. *(Golden test:
   max deviation between route geometry and raw OSM shape approximately 0.)*
2. **Route line off the road.** Tiles and graph come from the same extract; route geometry is never
   simplified beyond sub-pixel tolerance at max zoom. At zoom 18 the blue line sits on the drawn
   road, pixel-perfect.
3. **Wrong-side snapping.** Snapping and matching respect direction of travel and heading, with no
   snapping to the opposite carriageway of a divided road or to an overpass/underpass neighbour.
   *(Test with synthetic fixes on a known divided road.)*
4. **Teleporting dot.** Display position is continuous; corrections are eased, never jumped.
   *(Simulator test: max display-position step per frame bounded.)*
5. **ETA flapping.** ETA derives from smoothed progress, updated at most once per second, with
   hysteresis on re-route so numbers do not thrash.
6. **Stale-response races.** Route responses carry ids; anything but the latest is discarded;
   in-flight requests aborted on supersession.
7. **Illegal maneuvers.** One-ways and restrictions enforced in the graph itself, so no computed
   route can ever contain them. *(Toy-graph tests per rule.)*
8. **Float sloppiness.** Haversine implemented once, tested against known distances;
   distance-along-route computed from edge offsets, not accumulated per-frame floats;
   cross-algorithm cost equality within 1e-6.
9. **Dead ends and voids.** SCC filtering makes "no route found" between two snappable points
   impossible; camera bounds make the tile void unreachable.
10. **Silent failure.** Every error state (GPS denied, GPS poor, off-network, unsnappable point) has
    designed UI with a stated remedy.
11. **Direction-dependent optimality.** ADDED AT GATE 5. Route optimality must not depend on which
    search direction found the path. A forward search, a backward search and a bidirectional search
    over the same graph and objective must return the same route, and if they do not, the search
    STATE is wrong rather than one of the searches. *(Tested by `gate:equality`, which compares edge
    sequences rather than costs across every rung and routes deliberately through every restriction
    site.)*

    The defect this names, in the form it actually shipped here: the search state was one directed
    edge, and the edge it arrived from was recovered by reading the parent array, which holds the
    CHEAPEST predecessor. A via-way restriction is a statement about an ordered triple, so it was
    being judged against one arrival out of several. The forward search lost legal routes that
    approached a via way from a costlier direction; the backward search lost the mirror image. Each
    was self-consistent and both were wrong, and nothing that compared a search against itself could
    have found it. See "Exact state at via-way restrictions" below.

---

## Contraction hierarchies: NO. Decided at gate 1.

**Decision: do not build contraction hierarchies.** Ship bidirectional Dijkstra.

**Evidence, measured at gate 1 on the full district extent:**

| | |
|---|---:|
| Vertices after largest-SCC filtering | **213,144** |
| Directed edges after filtering | **532,951** |
| Largest SCC coverage | 99.40% of 214,432 pre-filter vertices |
| Clipped nodes the graph was built from | 1,893,860 |

The original concern was that a 3,432 km2 build area including part of Delhi NCR would reach
~10^6 vertices, where bidirectional Dijkstra costs tens of milliseconds and CH starts to earn
its complexity. The measured count is **an order of magnitude below that**, because vertices
exist only at way endpoints and intersections: 1.89M clipped nodes collapse to 213K vertices,
with the other 1.68M living in packed edge geometry as shape points.

**What CH would cost:** a node-ordering pass, shortcut edges roughly doubling edge count, a
second query algorithm to keep in agreement with Dijkstra to within 1e-6 on every pair, and a
rebuild step on every graph change. That is a large permanent complexity bill.

**Gate 5 is now confirmation-only.** It measures p95 server route compute against the 30 ms
budget. If bidirectional Dijkstra clears it, nothing further is built. If it does not, the
order of attack is: tighter A\* heuristic, then memory layout, then goal-directed pruning, and
only then CH.

**What would reopen this:** a p95 above 30 ms at gate 5 that survives those three cheaper
fixes, or a `BUILD_AREA` change that moves the vertex count toward 10^6. Note that shrinking
`BUILD_AREA` to avoid CH is explicitly banned by `hard-rules.md`: that is loosening the spec
to fit the implementation.

---

## Turn restrictions: via-node table, not edge-based expansion. Decided at gate 1.

**Decision: a via-node turn table with incoming-edge tracking in the search.**

**Evidence:** 55 turn restrictions touch the build area, against 213,144 vertices. Full
edge-based expansion makes every turn a vertex and multiplies the graph by average degree, to
express a constraint that exists at 55 places. The table costs memory only where a restriction
exists.

**The cost, accepted knowingly:** the search must carry which edge it arrived on. That is a
real constraint on every routing algorithm in this project, and it is why `Route` search state
is per-edge rather than per-vertex.

**Gate 1 left a gap; it is CLOSED.** 12 restrictions were unenforced, all `no_u_turn` with a
via-*way*, which OSM uses to model U-turn bans on divided carriageways through the connector
between them. A via-node table cannot express a two-hop constraint, so each was a potentially
permitted illegal turn: charter item 7.

The forensics ruled out the alternatives: **zero** failed because a member fell outside
`BUILD_AREA`, **zero** because a member was not drivable, **zero** because SCC filtering
dropped a member. It was a missing capability, not missing data.

**Resolved by generalising the table from turn PAIRS to short SEQUENCES.** A via-way
restriction bans the ordered triple (from edge, via edge, to edge), stored in
`bannedSequences` keyed by the via edge, beside the existing `banned` pair map. The search
already carried its predecessor edge, so the triple costs one extra comparison and only on
edges that carry a restriction at all: `edgeRestricted` is a `Uint8Array` flag set on 51 of
532,951 directed edges, so 99.99% of expansions never touch either map.

Via-way resolution keeps only the ONE directed via edge whose direction links a from-arrival
to a to-departure. Banning both would forbid the legal traversal in the opposite direction.

**Measured after the change:** 55 restrictions in the build area, 52 enforced (40 by pair, 12
by sequence), 3 correctly ignored as malformed relations naming no turn, **0 not honoured**.
Verified on the real graph, not only on toy graphs: 12/12 banned sequences are taken by a
control router built with an empty restriction table, absent from all 12 restricted routes, and
12/12 pairs still return a route rather than being blocked into failure.

**Still unsupported and named rather than dropped:** via-way *chains*, where a restriction
routes through more than one via way. `via-way-chain-unsupported` counts them. There are none
in this build area, and the toy suite covers the case so the counter is proven to fire.

---

## Snapping: two radii, two code paths. Decided at gate 0, held at gate 1.

`SNAP_TRACKING_M` = 40 m and `SNAP_DESTINATION_M` = 500 m are **not one tunable**. A GPS fix
more than 40 m from any road means the matcher is wrong; a tapped destination may legitimately
sit 400 m off-road inside a campus.

**Measured at gate 1:** the `dadri` fixture snaps at **43.9 m**, so it passes as a destination
and correctly fails as a tracking fix. That margin is only 3.9 m. If the road network near
Dadri is ever remapped, this fixture can silently stop testing the distinction. Re-site the
fixture if that happens; **never widen `SNAP_TRACKING_M`**.

---

## Tiles: tilemaker v2.4.0 plus our own PMTiles writer. Forced at gate 2.

**Decision: pin tilemaker to v2.4.0 and pack the PMTiles archive ourselves.**

**Evidence:**
- v3.1.0 publishes zero release assets.
- v3.0.0's Windows binary crashes with `0xC0000409` (stack buffer overrun) before reading any
  input. Reproduced on a pristine Geofabrik extract, on our own clip, with tilemaker's own
  bundled config and Lua, from a path containing no spaces, and under every combination of
  `--threads 1`, `--store`, `--shard-stores`, `--materialize-geometries`, `--fast` and
  `--no-compress-nodes`. It always dies immediately after printing the bounding box and never
  reaches "Reading .pbf". The vendored tree was confirmed complete against the release zip.
- v2.4.0 runs correctly and produced a full tileset.

**The cost:** v2 predates PMTiles output, so it writes a directory of tiles and
`packages/pipeline/tiles/pmtiles.ts` packs the archive, and v2's method-style Lua API applies.

**What would reopen this:** a tilemaker release with Windows assets whose binary actually runs.
Check both, in that order. An existing asset is not evidence that it works.

---

## Tiles are built from the clipped PBF, never the raw extracts. Decided at gate 2.

Feeding tilemaker the two raw extracts would process 91.5M nodes to draw a district of 1.9M,
re-introduce the Central/Northern seam that the clip removes, and mean the tiles came from
different bytes than the graph. The last of those breaks the governing principle: one source,
three derivatives. Feeding a pre-deduped single file makes doubled seam labels **structurally
impossible** rather than something to inspect the output for.

---

## Search ranking: locality decays at neighbourhood scale. Decided at gate 1.

**Decision:** proximity to the map centre is a first-class ranking signal with exponential
decay at 2.5 km, not a small linear tiebreak; and intrinsic prominence is compressed to 0.35
weight on the fuzzy path.

**Evidence, both from the frozen fixtures:**
- With proximity capped at 8 points, "Kasna" returned a village called **Kapna 35 km away**
  ahead of **Old Kasana Road 245 m away**, both one edit from the query. Prominence beat
  presence, which is backwards for navigation.
- With an 8 km decay, "Knowledge Park" typed at the Knowledge Park II station returned
  **Knowledge Park III, 3026 m away**, ahead of **Knowledge Park II, 14 m away**. In a city,
  3 km is several sectors, not "nearby".

**The risk, stated:** these constants were tuned while looking at fixture results, so they
carry a real over-fitting risk. The principle they encode is defensible independently (in a
69 x 50 km single-district app, presence should beat moderate prominence gaps).

**De-risked with a held-out set, not deferred to gate 7.** `config/fixtures/heldout.ts` holds
10 queries written from prior knowledge of the city before the index was inspected, and never
consulted while choosing a constant. The file states the rule: never tune against it. It
immediately earned its place by exposing two confidently wrong answers, "Beta 1" returning
Delta 1 and "Alpha 2" returning Alpha 1. Both are within two edits and both are the wrong
sector kilometres away, which is worse than returning nothing, because nothing prompts a
retype and a confident wrong answer does not.

The fix was to re-derive the fuzzy path on principle rather than to loosen the assertions:

- **Edit budget is RELATIVE to length**, `FUZZY_RELATIVE_BUDGET` 0.25, floored at 1. One edit
  in a four-letter word is a different word; one in a ten-letter word is a slip. Rejects
  beta to delta while keeping kasna to kasana.
- **Digits are identity, not spelling.** Greater Noida is laid out as Alpha 1, Alpha 2,
  Beta 1, Sector 62, so a digit is the whole difference between two real destinations. Query
  and candidate must carry the same digit sequence or there is no fuzzy match at all.

Held-out result: 4/4 must-resolve queries resolve. Three Greek-letter sector queries return
nothing, and that is a fact about the DATA, verified with a positive control: 496 indexed names
contain a digit, so digit-bearing names are certainly findable. `mustResolve` on those was wrong
about OSM coverage and was corrected, not loosened.

---

## No U-turn prohibition yet. Measured at gate 3, decided at gate 6.

**The search does not forbid the reverse twin of the edge it arrived on.** `Route` expands
every outgoing edge at `edgeTo[e]`, and the twin is in that set, so only OSM-recorded
restrictions block anything. A mid-carriageway U-turn is therefore available everywhere.

**Measured rather than assumed, because the capability did not manifest.** Across four real
routes totalling about 92 km and 546 directed edges (Pari Chowk to GBU, Gaur City to Jewar,
Surajpur to Knowledge Park, Dadri to Pari Chowk) there are **0 reverse-twin U-turns**.

That zero needed controls, since a broken detector and a clean router look identical:

- The twin is findable at all: 250,473 shape ids carry two directed edges, 32,005 carry one
  (genuine one-ways), none carry more.
- The detector fires on a known twin pair.
- The U-turn was *offered*: on the 57-edge Pari Chowk route the twin is in the expansion set at
  26 of 57 steps, the other 31 being one-way with no twin to take. So it lost on cost.

A forced-U-turn control cannot be built, and that is itself the reason the capability stays
harmless in practice: `route` seeds BOTH directed edges of the snapped start shape, so the
search never needs to turn round at the start, and on a connected two-way graph it never needs
to elsewhere either.

**Deferred to gate 6, and the SHAPE OF THE FIX IS PINNED NOW so it is not re-litigated later:**

- **A PENALTY, not a ban.** An outright ban breaks dead ends and legitimate turnarounds, and an
  over-strict rule produces "no route" where a driver would simply turn around.
- **Explicit exemption where outgoing degree is 1.** At a dead end the reverse twin is the only
  move, so it must cost nothing extra.
- **Calibrated against OSRM divergences at gate 6**, not guessed. The penalty is a number, and
  the validation set is what fixes it.
- **It must land before gate 8.** Re-routing from a matched mid-road position is exactly where
  U-turn pricing bites: an unpriced U-turn there produces an instruction a driver cannot legally
  follow, which is worse than a slower route.

---

## Gate 4 divergence: not the graph, not the search, only the speed table. Measured at gate 4.

`npm run diagnose:route -- --all` sorts every validation pair into a cause instead of ranking it
by size. Ten worst cases with one shared cause is one bug, and the ranking makes it look like ten.

**Result over all 56 pairs: 40 cost model, 16 OSRM leaving `BUILD_AREA`, ZERO router bugs, ZERO
graph defects.**

**How a cause is decided.** Not "do the two lines differ" but "is OSRM's own path cheaper or more
expensive than ours, under OUR cost model, between the SAME endpoints". Cheaper means the search
missed something real. More expensive means the search did its job and the table chose the road.

Three confounds had to be removed first, and each one had invented a bug that was not there:

- **A way sharing ONE node with the route is not a way the route drove.** Every footway and field
  track crossing a road shares a junction node. Counting those reported 12 missing ways on
  GBU to Jewar, where nothing at all was missing. A way now counts only when it holds two nodes
  ADJACENT in OSRM's own node sequence.
- **A road outside `BUILD_AREA` has no clipped way, so a way-based count cannot see it.**
  `random 33` reported zero missing ways beside 32.53 km of uncovered geometry. Two measures
  contradicting each other means neither is usable. Counting OSRM nodes absent from the clip
  resolves it, and turns the near-edge sampling caveat from a hypothesis into a measured cause.
- **The two engines snap the request to different graphs.** Comparing our cost from OUR endpoints
  against OSRM's line from ITS endpoints charges the snapping difference to the search. On
  `random 50` that alone read as a 1.1 min router bug; routing between OSRM's own endpoints gives
  39.8 min against its line priced at 39.8 min, an exact match. The instrument is also measured
  against itself: our line priced by the same method reproduces the router's exact cost, 0.00 min
  error on every pair checked.

**The 86 SCC drops on `random 42` are correct behaviour, not a defect.** They are the
`Delhi Eastern Peripheral Expressway` where it leaves the area: the in-clip stub connects to the
rest only through roads outside, so it is genuinely its own component. That is what the 3 km
buffer bounds, and what the buffer cannot reach is meant to be dropped.

**The table is the whole remaining cause, proved by swapping it.** `npm run experiment:speeds`
re-derives `edgeSpeedKmh` under candidate tables over the SAME graph and re-runs every pair.
`Router` reads speeds once in its constructor, so this is exact rather than an approximation, and
it costs seconds instead of a `build-city` per candidate. Tagged `maxspeed` is never overridden;
only defaults move.

| table | dist median | dist p95 | dur median | dur p95 |
|---|---|---|---|---|
| current | 3.39% | 17.90% | 7.76% | 21.78% |
| osrm-car | **1.04%** | 15.08% | 5.34% | 14.95% |
| posted-x0.8 | 3.82% | 17.69% | 21.82% | 42.25% |
| local-fix | 3.25% | 20.89% | 11.90% | 29.24% |
| flatter | 2.21% | 21.07% | 5.58% | 14.14% |

Under `osrm-car`, GBU to Jewar goes from +37.49% to **-0.72%** and `random 26` from -37.46% to
+0.98%, with nothing else changed. So the table explains the entire cost-model group.

**We are NOT adopting it, and the reason is in our own data.** `npm run calibrate:speeds` reads
the 1,773 parseable `maxspeed` tags in our clip. Against the local posted medians, OSRM's defaults
sit ABOVE the limit on exactly the classes that fix the divergence: trunk **85 against a posted 70**
(n=319), secondary **55 against a posted 45** (n=52). car.lua is tuned for a different road
network. Matching it would buy agreement by modelling this city less accurately, which is the
definition of chasing parity.

**And the locally-grounded correction makes agreement worse, which is the finding that settles
it.** Only two of our numbers are contradicted by local posted limits: trunk kept 100% of its
limit while every other class took a 10 to 25% discount, and residential sat at 125% of its own
limit. `local-fix` corrects exactly those two and moves p95 from 17.90% to 20.89% and duration
median from 7.76% to 11.90%. There is no table that is both more locally accurate AND closer to
OSRM. The two objectives point in opposite directions.

**Excluding the 16 boundary pairs does not rescue the gate either**, so it is not proposed:
median improves to 2.44% but p95 worsens to 28.27%, because the remaining 40 still contain
GBU to Jewar. Both columns are printed by the experiment; neither replaces the other.

**Still untested, and named rather than implied:** we apply **no turn penalty at all**, while
OSRM's car profile does. A router that prices turns at zero prefers many-turn paths through
smaller streets. That is not what drove GBU to Jewar, where we took the expressway, so it is not
the cause here, but it is the one modelling gap this investigation did not close. It belongs with
the U-turn penalty at gate 6, and both are calibrated against this same validation set.

---

## The objective: distance and toll preferences. Built at gate 4, DERIVED not fitted.

Until this the router minimised time and NOTHING ELSE. That sounds principled and is not: with no
tiebreaker, two routes near-tied in time can differ 37% in distance and the search returns whichever
wins by a second. Measured case, `gautam-buddha-university to jewar`: **12.0 extra km, on a TOLL
road, to save 2.7 minutes.** Nothing in the model objected because nothing in the model had an
opinion about distance or tolls. A driver offered that trade declines it.

**The constant is derived from a stated exchange rate, and the derivation is the point.** The
driver-plausible boundary is about one minute saved per 2 to 3 extra km. At the 2.5 km/min midpoint
one km is worth 60 / 2.5 = **24 seconds**. The BAND matters more than the midpoint: the landmark
detour is penalised 4.0 min at 3 km/min, 4.8 at 2.5, and 6.0 at 2, so it loses everywhere in the
band. `npm run experiment:objective` confirms that empirically, with 20, 24 and 30 s/km all landing
GBU to Jewar on **-4.07%**. A number whose conclusion survives its own uncertainty is a preference;
one that needs a specific value is a fit.

| candidate | overlap | slow % | tolled km | unrouted | dist med | dist p95 | GBU to Jewar |
|---|---|---|---|---|---|---|---|
| none, time only | 75.10% | 26.80% | 738.2 | 0 | 2.73% | 16.98% | +37.49% |
| dist-12, below band | 70.71% | 32.92% | 657.1 | 0 | 3.33% | 25.72% | +37.49% |
| dist-20, flat | 75.29% | 33.82% | 635.5 | 0 | 2.77% | 21.33% | -4.07% |
| dist-30, flat | 72.94% | 36.18% | 615.4 | 0 | 2.77% | 26.14% | -4.07% |
| flat 24 + toll 12 | 75.27% | 34.42% | 548.2 | 0 | **2.20%** | 21.33% | -4.07% |
| qual-24, no toll term | 75.26% | 27.05% | 750.1 | 0 | 2.88% | 16.98% | +37.49% |
| toll at 300 rupees/hour | 76.41% | 32.81% | 501.6 | 0 | 2.47% | 21.24% | -2.23% |
| **SHIPPED, 24 + quality + 42.4** | 67.03% | 33.02% | 310.1 | 0 | 3.33% | 25.26% | **-2.23%** |
| toll at 150 rupees/hour | 59.91% | 36.70% | 134.7 | 0 | 4.35% | 25.77% | -2.23% |
| avoid-tolls | 56.87% | 37.02% | 0.0 | 0 | 5.24% | 30.19% | -2.23% |

**`dist-12`, deliberately below the band, is worse than doing nothing** on every column. A weak
distance preference perturbs routes without resolving the trades it exists for. That is evidence the
band is the right region rather than a comfortable one.

**Tolls are a FLAG, not a fudge.** `toll=yes` is parsed into per-edge graph data (artifact v3),
because whether a road charges a toll is a fact about the road; what it is WORTH is a preference and
lives in the objective. That split is what lets one artifact serve both modes. `avoidTolls` per
request excludes them outright, as a HARD filter rather than a large penalty: "avoid tolls" means the
route must not use one, and a high price would still return a tolled route when no free one exists.
It leaves **0 of 56 pairs unrouted**, so the mode never strands a destination.

---

## The toll model: two mechanisms, a statutory source, and one named pattern. Rebuilt at gate 6.

Supersedes the gate 4 and gate 5 toll sections below, which are kept because the reasoning that got
us here is what stops it being redone. Read this one first.

### The search proxy and the billed truth

**One pattern, stated once, covering every toll road here.** Each road has two prices: a smooth
per-kilometre `searchRatePerKm` the SEARCH pays, and an exact `mechanism` that `priceTolls` applies
once over the chosen path to produce the reported `tollCost`.

**This is forced, not a convenience.** A shortest path can only minimise a cost that is additive
over edges, and neither real mechanism is. A barrier fee is a step function of position; a closed
system's fare is a function of the whole run. The alternative was tried and measured: putting the
140 rupee Jewar barrier on the single edge containing the plaza IS additive, and it landed as a
**37 minute penalty on one 604 m edge**. The router did the rational thing and left the expressway
at an interchange to rejoin past the barrier, crossing 22.0 km of a tolled road for nothing. The
cost model was correct edge by edge and wrong as a route.

So the search sees a smooth rate close to each road's real average, and the exact rule runs once on
a known path where the whole run is visible. The two agree closely and are never required to agree
exactly. `seconds` therefore still equals the sum of its parts, which is what keeps the equality
gate's cost-against-path validator meaningful.

**The dodge is closed independently of the proxy**, and both fixes were needed. Every booth is now a
toll point, `edgeTollGate` distinguishing a mainline barrier from a ramp booth, so leaving the
carriageway to avoid a plaza now meets a ramp charge exactly as it does in reality.

### Eastern Peripheral: statutory distances, a fitted rate

**Gazette of India S.O. 613(E), 3 February 2025**, MoRTH, Part II Section 3(ii), amending S.O.
4153(E) of 5 September 2022. It gives all eleven plazas with chainages and, in Table 5, the tollable
distance between every pair. This outranks every other source this project holds.

**Table 5, not Table 2.** Table 2 is carriageway only; Table 5 is "the net effective length for
which fee shall be due and payable", carriageway plus the equivalent length of structures over 60 m,
and it is the one fees are declared payable on. They differ by 23.4 km end to end, about 45 rupees.

**The transcription is checked by an identity, not by re-reading it.** Structures sit on fixed spans,
so the ten adjacent-plaza allowances (Table 5 minus Table 2) must sum to the end-to-end allowance:
**23.434 against 23.433 km**, across 21 separately transcribed cells. A single wrong digit breaks it.
`tests/engine/objective.test.ts` asserts it permanently. Two cells are non-monotonic in chainage
separation and both are real: the main plazas bill to the section ends at km 1.000 and km 136.000,
and the Badagaon to Duhai span alone carries 3.020 km of structures.

**The rate is fitted, because Table 1 is not in the excerpt we hold.** For each cell of a rate board
the rate consistent with the posted fare is a half-open interval; a rate is admissible only if it
lies in all ten:

```
Pelak/Sihol board, current      admissible [1.9457, 1.9526)   1.95 lies inside   10 of 10 cells
Fatehpur Rampur board, 2025     admissible [1.8728, 1.8995)   1.89 lies inside   10 of 10 cells
```

The bands do not overlap, 3.3% apart, which is what proves two annual revisions rather than noise.
The shared Sihol to Fatehpur Rampur cell reads 95 rupees on both boards because both rates round to
it. **We bill from 1.95.** Recorded because it is the kind of near-miss that gets rounded into
"verified": **1.90 fits only 9 of 10**, the Mawikalan cell computing 142.54 and rounding to 145
against a posted 140.

### Chainage, not names: how an entry-exit pair is resolved

The fare needs to know which plaza a route entered and left at. OSM names three of eleven plazas,
and the villages it does carry sit up to 18 km off the road, so **position is measured and identity
is never inferred from a nearby name.** `npm run calibrate:epe` chains the mainline carriageway,
measures each interchange's distance from the southern end, and fits ONE unknown, the chainage of
that end, against the eleven published chainages.

| Feature | Residual |
|---|---|
| Pelak/Sihol | -0.177 km |
| Maujpur | -0.326 km |
| Fatehpur Rampur | -0.072 km |
| Bilakbarpur | +0.027 km |
| Main Plaza Chhajju Nagar | +0.547 km |

**The three plazas the earlier audit identified by hand were HELD OUT of the fit and used as its
test. All three are reproduced from position alone.** That includes the site at exit 10 the audit
had refused to name, which is **Fatehpur Rampur**: the Gazette places it in GB Nagar at km 83.005,
10.131 km from Bilakbarpur, matching the measured gap. The refusal was correct; the evidence simply
was not in OSM. The notification also settles the spelling: *Bil Akbarpur or Beel Akbarpur has the
same meaning.*

**Main plazas are not interchanges, and conflating them broke the first fit.** Nine of the eleven are
ramp plazas at interchanges; Jakhauli and Chhajju Nagar are barriers across the open carriageway.
Matching the Palwal terminus tie-in against Chhajju Nagar pulled the anchor 2.5 km and made one
anchor unable to explain the road. Matching each kind to its own feature removed it.

**A drifting residual is a refusal, not an average.** The script exits non-zero rather than adopting
a mapping it cannot justify.

`edgeTollSegment` stores the resulting inter-plaza span per edge, so a route occupying spans a..b
entered at plaza a and left at plaza b+1. That is the Table 5 lookup, and it means the engine prices
a closed system without knowing what a plaza is.

### Yamuna Expressway: hybrid, and why it is not statutory

Mainline barriers charge a flat fee; ramp plazas charge by distance; a run crossing no mapped booth
is charged by distance too, because OSM holds five booths where the operator runs at least ten and a
free ride on a toll road is the one error that actively steers drivers onto it.

**No statutory source is obtainable online.** UP publishes no online state gazette, only physical
publication via the Directorate of Printing and Stationery, Lucknow. An RTI to YEIDA is the open
path and would be one config edit if it lands.

### Confidence, and where it now shows a number

`verified` shows the rupees bare. `approximated` and `unpriced` show them behind an estimate label.
**The line moved at gate 6**: `approximated` used to show no figure at all. Once every road had a
defensible per-kilometre basis, withholding the number stopped protecting the reader and started
leaving them with less than we know. What must never happen is a hedged figure and a certain one
looking identical, so `Route.tollDisplay` is derived server-side by one shared function and the view
obeys it rather than deciding.

Measured over the 56 pairs: **15 verified, 6 approximated, 0 unpriced.** Before the ramp-attribution
fix it was 6 verified, 0 approximated, 12 unpriced, because 8.38 km of unnamed slip road dragged
every EPE route down. A road's own ramps are not a different road.

### The cost of an hour of driving: 225 to 550 rupees

`DRIVING_COST_RUPEES_PER_HOUR`, renamed from `VALUE_OF_TIME_RUPEES_PER_HOUR` because the old name
was the error. The constant decides how much detour is worth avoiding a fee, so it must carry
everything an extra hour of driving costs: fuel alone is over 300 rupees an hour at these speeds,
before wear, fatigue, and an hour of village road instead of expressway. 225 implied an hour was
worth less than a coffee.

**Measured A/B over the 56 pairs, same graph, same process:**

| | 225/hour | 550/hour |
|---|---|---|
| Routes changed | | 11 of 56 |
| Tolled km | 446.5 | 608.3 (+36.2%) |
| Total distance | 2605.3 km | 2666.6 km (+2.36%) |
| Total drive time | 3036.8 min | 2990.1 min (-1.54%) |
| Total billed tolls | Rs 1196 | Rs 1637 |

The direction is the intended one: every rupee buys less detour, so toll roads become relatively
more attractive. We now buy 2.36% more distance for 1.54% less driving.

### Deferred, with revisit conditions

- **NE3 collects only for exit from EPE**, stated in the notification, so the true fare matrix is
  asymmetric at that one plaza. Unmodelled. Revisit when a route actually uses NE3; none of the 56
  pairs reaches it, and it lies outside the clip's EPE mainline.
- **Table 1 base rates** are not in our excerpt, which begins at page 4. The rate is fitted rather
  than read. Revisit if the full notification is obtained.
- **Yamuna ramp fees.** One ramp board was photographed showing a flat 50 rupees for a car. One
  board is not a tariff: it does not establish whether every ramp charges the same, nor whether a
  ramp charge stacks with a mainline crossing. Revisit on a second board or an RTI response.
- **Exit refs are the correct interchange key if the matrix is ever keyed by identity rather than by
  span.** OSM carries exit numbers for six interchanges in our clip (6, 7, 8, 10, 15, 16) and booths
  for only three sites, so booth nodes are the weaker key. Not needed under the current model, which
  keys on measured chainage.

---

## Gate 6, CLOSED. Two mechanisms, both evidenced, and one road only half tagged.

**Decision: close gate 6. The toll model is complete for both roads that carry our tolled network,
each priced by its own mechanism from its own dated source, with the gaps named rather than filled
by inference.**

**What is settled.**

| Road | Structure, and its source | Amount, and its source | Confidence |
|---|---|---|---|
| Eastern Peripheral | Gazette S.O. 613(E), 03-02-2025, Table 5 | fitted from two rate boards against Table 5 | `verified` |
| Yamuna, mainline | plaza board photographed in person | the same board, 140 rupees for a car | `verified` |
| Yamuna, ramps | ramp booths marked from OSM | **not established, one board only** | `approximated` |
| Anything else `toll=yes` | tagged in OSM | the EPE per-km rate as a stand-in | `unpriced` |

Structure and amount carry separate sources and dates throughout, which is the YEIDA lesson: an
official source can be right about the mechanism and two revisions stale about the price.

**Validation, at the close.** Distance median **3.70% to 2.15%**, which passes its 3% threshold for
the first time since gate 4. p95 30.19% to 16.46%, still failing 7%. Duration median 8.97% to 7.38%,
p95 27.44% to 23.91%. **Thresholds untouched, and the p95 is two populations rather than a backlog:**
31 of 56 routes are SHORTER than OSRM and 22 are longer, so the tail is not one defect being
approached from one side. `VALIDATION.md` records the split.

### The three changes were not separable by their totals, and one of them did nothing at all

`npm run isolate:tolls` turns each change off from the current state, one at a time, over the same
graph in the same process. The reconstruction is validated by turning all three off together, which
reproduces the previous state exactly: 130.7 / 287.3 / 10.5 km against the figures recorded before
any of them landed.

```
tolled km across the 56 validation pairs
  configuration                                 yamuna-ex  eastern-p   unpriced      total
  current state, all three changes in                61.6      546.7        0.0      608.3
  A off: 225 rupees/hour instead of 550              51.1      395.3        0.0      446.5
  B off: ramps back to unpriced                      61.1      529.0       18.1      608.3
  C off: gate roads free between barriers            90.4      546.7        0.0      637.1
  all three off together                            130.7      287.3       10.5      428.4
```

- **A, the cost of driving, is worth +161.8 km and moves 11 of 56 routes.** It RAISES both roads,
  which is the predicted direction: a rupee buys less detour, so a toll road is relatively cheaper.
- **B, ramp attribution, is worth exactly 0.0 km and moves 0 of 56 routes.** All 56 routes are
  geometrically IDENTICAL with and without it. Every kilometre it appears to give EPE is a
  kilometre already being driven and previously labelled `unpriced`. It is a reclassification, and
  reporting it as a behavioural gain would have been false.
- **C, the search proxy, is worth -28.8 km, all of it Yamuna.** It is the only one of the three that
  pushes Yamuna DOWN; the other two push it up. That is the direct answer to whether Yamuna's fall
  is correct: the road was free between barriers in the search, so 12.55 km of expressway cost
  nothing, and it was being chosen because it was mispriced at zero.

**THE THREE DO NOT COMPOSE, and that is the finding the totals hid.** On Yamuna the three separate
effects sum to -17.9 km while turning all three off at once moves 69.1 km. The interaction term,
-51.2 km, is larger than any single effect: at 225 rupees/hour a tolled kilometre on EPE costs 31.2
seconds, so making Yamuna simultaneously free pushed traffic onto it far harder than either change
does alone. **No single-cause account of the 130.7 to 61.6 fall is available, and one should not be
written.**

C's isolated figure is an UPPER BOUND on its own effect. The old proxy had two halves, no per-km
cost between barriers and the whole barrier fee on the one edge carrying the booth, and only the
first is expressible through the objective. The missing half was a cost of ENTERING a tolled road,
so including it would push tolled kilometres further down.

### A landmark pair that is longer and slower, and what pays for it

`jewar to gaur-city` is 15.2% longer than OSRM and 6.7% slower by OSRM's own duration. Priced term
by term under our objective with the same estimator on both lines, `npm run diagnose:pair`:

```
  term                     ours       OSRM        OSRM minus ours
  drive                    68.55 min    70.90 min          2.35 min
  distance, neutral        29.26 min    25.44 min         -3.81 min
  distance, quality       -13.68 min   -10.07 min          3.61 min
  toll                      4.04 min     4.04 min          0.00 min
  turns                     0.94 min     1.59 min          0.65 min
  TOTAL                    89.10 min    91.89 min          2.79 min
```

**"Slower" was never a like-for-like comparison.** Our modelled duration was being read against
OSRM's modelled duration, which is a different speed table. Priced on OUR table, OSRM's shorter path
takes 70.90 minutes against our 68.55: our route is 9.5 km longer and 2.35 minutes FASTER.

**Quality carries it, it is decisive, and it is spent on one class.** Removing the quality weight
flips the verdict: OSRM wins by 0.82 minutes with a flat rate and loses by 2.79 with the weighted
one. The whole difference is trunk against secondary, 4.35 minutes of it:

```
  class          ours km   ours qual    OSRM km   OSRM qual     delta qual
  motorway        26.93      -7.54      27.60      -7.73          -0.19
  trunk           24.32      -5.35       4.55      -1.00           4.35
  secondary       13.20      -0.79      22.42      -1.35          -0.55
```

Both paths take the identical 25.61 km of Yamuna Expressway. They differ afterwards: ours takes
**21.10 km of the Noida-Greater Noida Expressway** and reaches it over about 10 km of named
secondary connectors; OSRM takes **21.24 km of unnamed secondary** running direct. That is a stated
preference doing exactly what it was built to do, and it is a judgement a local driver can overrule.
Instrument self-error on this pair is 0.01 minutes, so the 2.79 minute margin is real.

### OPEN: 13.07 km of the Yamuna Expressway carries no toll tag, and we cannot settle why

Measured on the mainline (`highway=motorway`, name `Yamuna Expressway`) inside our clip:

```
  31.51 km  125 ways  toll=yes      lat 28.05296 .. 28.33864
  13.07 km   42 ways  toll absent   lat 28.33860 .. 28.44798
  CONTROL: 920 ways in the clip carry toll=yes, so the lookup works
```

**It is one CONTIGUOUS northern stretch, not a scatter.** `npm run audit:yamuna` prints the whole
boundary; a latitude is not somewhere a person can stand, so the locatable form is recorded here.

The two groups meet at **two nodes, one per carriageway**, about 20 m apart:

| node | lat, lon | tagged way | untagged way |
|---|---|---|---|
| `1803899781` | 28.3385957, 77.5461706 | 169228550 | 87188879 |
| `1803899782` | 28.3386406, 77.5463743 | 169228546 | 169624173 |

The untagged stretch runs from there to node `1803900020` at **28.4479781, 77.4984506**, the
northern terminus of the mainline in our data and NOT a clip edge: `BUILD_AREA` reaches 25.6 km
further north. Bounding box **28.3385957, 77.4984306** to **28.4479781, 77.5463743**, 12.16 km
north to south by 4.69 km east to west, 13.03 km end to end straight against 13.07 km measured
along the carriageway.

**Neither end has a named interchange, and that is a finding rather than a gap in the report.** The
only ways meeting the mainline near either end are unnamed `motorway_link`s, and no named road
reaches them through a slip road within 12 km. The nearest toll infrastructure is the ramp booth
pair at 28.32113, 77.55136 and 28.31936, 77.55272, **2.01 and 2.23 km south of the boundary**; the
next toll point after those is 22.09 km away and the Jewar mainline barrier is 25.11 km away.

So the boundary sits just north of the last interchange that has booths on it. That is consistent
with a genuinely free northern approach into Greater Noida. It is also exactly what a contiguous
tagging gap would look like.

It is not a rounding matter: `jewar to gaur-city` drives 25.61 km of the expressway and is billed
for 12.55, and the 13.06 km difference is precisely this stretch.

**Not treated as a defect and not corrected**, because correcting it means asserting a toll the data
does not claim, and `hard-rules.md` forbids exactly that kind of inference. **One sentence from
someone who drives it settles it**, and if the stretch is tolled the fix is a way-id list in
`config/city.ts` and a rebuild.

---

## Gate 7: search, turn-by-turn, and the toll display. Built at gate 7.

**Three features, one screen, and the one thing they share is that a view never decides anything.**
All state and every decision live in `packages/client/src/store.ts`; components render and dispatch.
That is what makes a later visual pass a change to markup and CSS, and it only holds if the
decisions a view would be tempted to inline live somewhere else.

### The latency readout is a designed element, and the switch beside it is the point

The search index is the clearest place in the product where building everything ourselves pays, so
the cost of it is shown rather than claimed. `searchUnindexed` runs the identical ranking with no
precomputation, `/search?index=off` selects it, and the readout under the results reports the
server's own measured search time.

Warm, medians over five runs per query, through the same endpoint the UI uses, 7,675 places:

```
  query        indexed     no index
  kasna        33.1 ms      62.3 ms      the fuzzy path, edit distance over the whole corpus
  pari         10.4 ms      36.3 ms
  gaur          9.0 ms      41.1 ms
  alpha        14.2 ms      47.0 ms
```

**The two paths MUST rank identically or the demonstration is a lie**, trading answers for speed
while appearing to trade nothing. `tests/engine/search.test.ts` asserts name, match type and score
agree to six decimal places across ten queries with and without a map centre. The only permitted
difference between the two paths is when the work happens.

Cold, under keystroke contention, the readout was seen at 133 ms. That is real and it is what the
user waited, so nothing suppresses it; the warm figures above are what the index is worth once the
process has run.

### Turn-by-turn: suppression is the hard half

Instructions are derived in the engine from the same edge sequence and geometry that are returned,
so an instruction can never name a road the drawn line does not run along. The generator reads four
signals in order: roundabout, bearing change over a 30 m ground window, road-name change on BASE
names, then road class.

**Every rule below was written after a real route got it wrong**, and each is now pinned by a
toy-graph test. The first pass produced 22 instructions for a 7.7 km urban route and 11 for a 73 km
cross-district one, which is exactly backwards.

| What went wrong | On what | The rule now |
|---|---|---|
| `turn slight left onto Noida-Greater Noida Expressway` while already on it | jewar to gaur-city, 20 km in | A bend under a slight turn on one continuously named road is never a manoeuvre, whatever the out-degree |
| Nothing at all for joining the Yamuna Expressway | jewar to gaur-city, 12.9 km in | A merge is defined by the CLASS JUMP, with no name test: the slip road is unnamed and so is the road it leaves |
| `merge onto (unnamed)` once the merge fired | the same junction | A manoeuvre is named from AHEAD of the junction, preferring a structure-free name |
| `continue onto Vikas Marg` three times in 7 km | jewar to gaur-city | The decision and the label must use the SAME name; a repeat is dropped |
| Five `keep left` / `keep right` in 2.5 km | Faridabad to Sikandarabad | An exit needs the class jump AND a name change, because rural trunk roads flip class along one carriageway |
| Three right turns 20 to 40 m apart | alpha-1 to surajpur | Two turns the same way round within a corner's length are one corner |
| `Continue onto NH34;NH334C` | Faridabad to Sikandarabad | A semicolon is OSM's multi-value encoding, not a name. Fixed in the pipeline, at the intern step |

**A defect the toy graphs caught that no real route would have:** junction positions were located by
comparing a haversine running total against a polyline measured with a local flat approximation.
They agree to about half a percent, which is nothing over a route and everything at a corner. On a
square left the index landed one shape point PAST the corner, the bearing was read from after the
turn to further after it, delta came out 0, and a 90 degree turn was never announced. Junction
positions are now nearest-matched along the line.

Result on the two routes that drove the work, re-measured through the server after the last fix
rather than quoted from the run that motivated it: **73.14 km, 209 edges, 12 instructions**, and
**7.72 km, 64 edges, 17 instructions**.

**Not verified against local knowledge yet, and flagged rather than assumed.** Roundabout exit
counting is the weakest part: it counts circle vertices that offer any way out, which a divided
exit mapped as two ways would double. `alpha-1 to surajpur` reports exits 4, 2, 1 and 2 through
four roundabouts in 7.72 km. Those numbers need someone who drives them.

### Three toll tiers, and the difference is visible before the words are read

`Route.tollDisplay` is derived once by `tollDisplayOf` in `packages/shared/toll.ts`. The client
recomputes it from the fields that travelled with it and compares; a disagreement resolves DOWNWARD
to `estimated` and warns. An estimate shown as a fact is indistinguishable from a fact.

| Tier | Rendered | Seen on |
|---|---|---|
| `exact` | the figure alone, body size, full ink | Faridabad to Sikandarabad, 79.4 km, `Rs 125` |
| `estimated` | `Tolls` then `Estimated cost: Rs X`, caption size, quiet | Jewar to Gaur City, 73.7 km, `Rs 68`, Yamuna ramps |
| `none` | nothing at all | any toll-free route |

This is deliberately unlike the mainstream tools, which show one estimate for everything and never
say which figures they stand behind.

### Pre-ship checklist, measured

```
type sizes on the surface     3 (caption .75, body 1, display 1.25rem) + html 100%   cap 5
type weights                  2 (400, 600)                                           cap 3
px font sizes                 0
copy gate                     PASS
horizontal scroll at 320px    none. window.innerWidth asserted 320 under device emulation, not resize
200% text at 320px            no scroll, input 238px, rail right edge 296 of 320
collisions at 320px           status chip vs attribution and vs zoom controls, both resolved and
                              re-measured by getBoundingClientRect, not by eye
accent                        one, and the status chip lost its bar so the route panel owns it
pressed state                 inverts elevation to inset
reduced motion                honoured, durations collapsed
```

**Not run: `verify:browser` and `acceptance`.** Neither is built; they are gates 8 and 9.

---

## The toll price: derived from the tariff. Rebuilt at gate 4, after the first one was a placeholder.

> **SUPERSEDED at gate 6** by the section above. The uniform 2.65 rupees/km recorded here was never
> the billing mechanism for either road that carries our tolled network. Kept for its provenance and
> for the reasoning that exposed the error.

**The first toll number was never derived, and it was covering for the distance term.** It was 12
s/km, justified only as "half of `secondsPerKm`, so the two move together". That tie was tidy and
had no content: it made the price of a toll a function of the distance preference rather than of the
toll. Inverting the arithmetic shows the size of the error. 12 s/km implies a value of time of
`2.65 / 12 * 3600` = about **795 rupees an hour**, which nobody would defend for a private car driver
in Greater Noida. The toll was under-priced by roughly three and a half times, and the flat distance
preference had been silently doing its job.

**Two inputs, one division, both stated in `config/city.ts`:**

```
TOLL_TARIFF_RUPEES_PER_KM / VALUE_OF_TIME_RUPEES_PER_HOUR * 3600
  = 2.65 / 225 * 3600  =  42.4 seconds per tolled kilometre
```

**The tariff is verified, not recalled, and cross-checked against an independent total.** Three
sources agree on 2.65 rupees per km for a car: the Wikipedia article, tollguru's expressway guide
attributing it to 2025, and sarkarilist's rate list, which also gives the previous rate as 2.50 and
attributes the rise to YEIDA's 74th board meeting. The cross-check that matters is arithmetic rather
than editorial: the published full-run figure of 438 rupees over 165.5 km is **2.647 rupees per km**,
agreeing to three digits with a number reached a different way. Fetched 2026-08-03.

**One discrepancy, recorded rather than resolved by preference.** A Construction World article dated
2024-09-30 reports a 13.5% rise to 2.95 per km effective 1 October under the Suraksha resolution
plan. No source reporting a CURRENT rate corroborates it, and all three that do say 2.65. The higher
figure is not used. If it is in fact live, the derived cost rises about 11% and every conclusion here
strengthens rather than reverses, since a dearer toll can only make the tolled road less attractive.

**The value of time is a stated judgement and is labelled as one.** 225 rupees an hour, the midpoint
of a 150 to 300 band. It is not a published figure and is not presented as one.

**The band is what carries the argument, and it was measured before the result was looked at.** The
landmark answer is **-2.23% at every point in the band**, 31.8 s/km through 63.6 s/km, so the
conclusion does not depend on landing on 225:

| value of time | toll cost | GBU to Jewar | dist med | overlap |
|---|---|---|---|---|
| 300 rupees/hour, time rich | 31.8 s/km | -2.23% | 2.47% | 76.41% |
| **225 rupees/hour, stated** | **42.4 s/km** | **-2.23%** | **3.33%** | 67.03% |
| 150 rupees/hour, time poor | 63.6 s/km | -2.23% | 4.35% | 59.91% |

**The threshold this had to clear was computed BEFORE the derivation, and deliberately not consulted
during it.** Under the quality weights the landmark needed a toll price above **22.1 s/km** to change
its answer. The whole band clears it, the midpoint by 92%. Had the derivation landed below 22.1, the
honest response was to say the toll is worth less than the driver's behaviour implies, not to inflate
it. That is why the number was derived first and compared second.

**What this is and is not.** It is a fare converted into the only unit the search understands. It is
NOT a claim that the toll is charged continuously: it is levied at plazas at 38, 95 and 150 km from
Greater Noida, so the per-km figure is the tariff BASIS and not the billing mechanism. A per-km model
therefore over-charges short hops onto the expressway, which is the most likely source of the
overlap cost visible in the table above. No round-trip discount is modelled.

**THE CLASS RATIO IS THE EXCHANGE RATE, NOT A SIDE EFFECT OF IT. This paragraph previously said
otherwise and was wrong.** A per-km cost is a larger fraction of a fast road's cost than a slow
one's, so at 24 s/km a motorway edge goes from 40 to 64 s/km and a tertiary from 103 to 127, and the
ratio between them falls from 2.571 to 1.982. The earlier wording called that a side effect that
moved routes off fast roads "not only on the near-ties it was introduced for". **There are no
near-ties as a separate category.** The exchange rate applies at every margin, and the class ratio
is simply that same rate expressed as a maximum detour multiplier:

| rate | max detour factor | km per minute saved at that boundary |
|---|---|---|
| 0 s/km | 2.571 | infinite |
| 20 s/km | 2.048 | 3.0 |
| **24 s/km** | **1.982** | **2.50** |
| 30 s/km | 1.898 | 2.0 |

Swapping x km of tertiary for y km of motorway is accepted while `y < 1.982x`, and at that boundary
the extra distance buys exactly 2.50 km per minute saved. So 1.982 IS 24 s/km, seen from the other
side, and 2.571 is the willingness to detour forever for zero time saving. Asserting that the ratio
must not compress is asserting that the exchange rate is infinite. `npm run diagnose:flattening`
holds the measurement, and `tests/engine/quality.test.ts` holds the invariant.

**Two proposals for separating the two were rejected, both on measurement rather than on taste.**
Charging only the distance in EXCESS of the straight line between origin and destination is a
no-op: across 168 measured routes, zero were shorter than their own straight line, minimum ratio
1.1175, so `max(0, dist - D)` never clips, `D` is a per-query constant, and subtracting the same
constant from every candidate cannot change which one is cheapest. The proof generalises to any
query-constant baseline, the shortest path included. Weighting the rate by class so the ratio is
PRESERVED EXACTLY requires `quality` proportional to seconds-per-km, which makes the whole
objective `(1 + lambda) * driveTime`, a scalar on time, so the preference stops having an opinion
at all.

---

## Road quality: the third proposal, and it worked. Built at gate 4.

The complaint the flat rate produced was never "routes got shorter", it was **"we now prefer village
roads"**. Measured, that complaint is real: the share of route distance on tertiary and below went
from 26.80% under time alone to **34.42%** under a flat 24 s/km. The fix has to make a rough
kilometre cost more, not a long trip cost more, and the sign is the whole point.

**One preference, one rate, a weight on top.** `k_class = OBJECTIVE.secondsPerKm * quality[rank]`,
so the file still has one number with a unit and the sentence still has one exchange rate in it: a
minute is worth 2.5 km on an ordinary Greater Noida road, less on a rough one and more on a smooth
one, in proportion to how much worse the road is to drive. Tertiary is the neutral class at 1.00.

**The weights are NOT from OSM tags, and that is measured rather than assumed.**
`npm run calibrate:quality` reports `smoothness` on 0.46% of drivable km and `surface` on 18.37%.
Sparsity is the lesser problem. The decisive one is that `surface` coverage is INVERSELY correlated
with need: 50 to 59% of motorway through secondary km carry it, against **6.27% of unclassified** and
13.93% of residential. A tag present where roads are good and absent where they are rough cannot
measure roughness, and 15,343 of the 16,373 tagged ways say asphalt or paved. Controls were read
first, per `hard-rules.md`: `highway` at 100.00% and `maxspeed` at 1.46%, both matching independently
known values, so the low numbers are the data and not the loop. If OSM coverage here improves, a
per-edge surface field supersedes this table.

**Where the stated judgement met a structural invariant, the invariant won.** The hierarchy must not
compress: for any two classes, weighting must leave the slower one at least as expensive RELATIVE to
the faster one as pure time made it. That holds exactly when `quality / secondsPerClassKm` never
decreases as roads get smaller. My first cut had primary at 0.70 and trunk at 0.50, which broke it
against secondary; both came down. `tests/engine/quality.test.ts` walks every class pair.

| | time only | flat 24 | quality weighted |
|---|---|---|---|
| motorway, s/km | 40.00 | 64.00 | 47.20 |
| tertiary, s/km | 102.86 | 126.86 | 126.86 |
| **motorway to tertiary** | **2.571** | **1.982 COMPRESSED** | **2.688 expanded** |
| slow-road share of route km | 26.80% | 34.42% | 30.43% |

**LINKS ARE EXEMPT FROM THE ORDERING, deliberately.** A `*_link` ranks with its parent so that
leaving a motorway by the only means a motorway provides is not charged as a demotion. But
`motorway_link` defaults to 45 km/h and `primary` to 50, so once links are in, rank order and speed
order genuinely disagree and no per-rank weight can satisfy the invariant across both. The test
asserts the thing that would actually be a bug instead: no link is ever cheaper per km than the road
it serves. **Within a rank the weight cannot separate two classes either**, so `unclassified` against
`road` is still compressed. Keying on class rather than speed is the deliberate choice there, since a
residential street posted at 60 is still a residential street.

**Then the landmark came back, and that was the real finding.** Quality weights alone put
`gautam-buddha-university to jewar` back to +37.49%, because expanding the ratio works precisely by
making the motorway kilometre cheap, and the landmark had been fixed by making it expensive. At
`quality[motorway] = 0.30` the surviving class-independent distance preference is only
`24 * 0.30 = 7.2` s/km, one minute per 8.3 km, far outside the stated 2 to 3 km band, and weaker than
`dist-12` which was already shown to be worse than doing nothing. **A flat distance preference and an
uncompressed class hierarchy are opposed by construction.** What resolved it was not a compromise
between them but the toll price above, derived independently, which turned out to be what the
distance term had been standing in for all along.

**THE OBJECTIVE CHANGED WHAT A FAIR COMPARISON IS, and the diagnosis had to change with it.**
Adding the distance term made `npm run diagnose:route` report THREE router bugs that did not exist:
`jewar to gaur-city`, `random 15`, `random 20`. The tool compared DRIVE TIME while the router had
started minimising drive time plus distance plus toll, so a route that deliberately gives up 1.1 min
to save 25.5 km looked like a search failure. Two fixes: price OSRM's line under the full objective,
and exclude turn costs from BOTH sides rather than absorbing the unpriceable term into a margin, a
margin being just as good at hiding a real three-minute gap as a spurious one-minute one. The
apparent 1.9 min gap on `jewar to gaur-city` is really 0.5 min inside a 1.0 min margin.

This is the FOURTH instance of the same class in this project: comparing a modelled cost against a
measurement. The others were a server boot time, a tilemaker wall time, and validation duration.
The pattern is now explicit: **whenever the objective gains a term, every comparison against an
external reference has to be re-derived, because the reference does not have that term.** A
`TOO CLOSE TO CALL` verdict was added at the same time, since the old code printed "its path costs
MORE" on pairs where it cost less but by less than the instrument could resolve.

Final partition over 56 pairs with the full objective in force: **39 cost model, 16 OSRM leaving the
area, 1 too close to call, 0 router bugs, 0 graph defects.** Per pair, joined into `VALIDATION.md`.

**BOTH distance thresholds now fail: median 3.33% against 3%, p95 25.26% against 7%. Neither
threshold moved, and neither preference was tuned to recover them.** The median had been passing at
2.20% under the flat rate, so this is a real change in behaviour and is recorded as one. Its cause is
single and identifiable: pricing the Yamuna Expressway at its published tariff moves us off it, from
548 tolled km across the 56 pairs to 310, and OSRM's car profile prices no toll at all. Every pair
that swung is a trade declined against a stated rate rather than a road we could not find:

| pair | OSRM's route is | saves, our model | km per minute saved | at 2.5 km/min |
|---|---|---|---|---|
| random 26 | 24.4 km longer | nothing, it is slower | n/a | decline, ours dominates |
| random 15 | 25.5 km longer | 1.1 min | 23.2 | decline |
| random 20 | 5.8 km longer | 1.6 min | 3.6 | decline |

**The cheap way to pass both thresholds is available and is being refused, explicitly.** The
`toll at 300 rupees/hour` row scores best on nearly every column, median 2.47% and the highest
overlap in the table at 76.41%, with the identical landmark answer. Selecting it would mean choosing
a driver's value of time from a divergence table against a reference router that has no toll model,
which is parity chasing wearing a third hat. The value of time is stated at the midpoint of its band
in `config/city.ts` and the band is reported beside it, so anyone who thinks 300 is the better
judgement can argue for it on its own terms and change one constant.

---

## Gate 4, CLOSED as a documented modelling difference. Thresholds untouched.

The test for closing was never the percentage. It was whether the difference from a bigger router
can be said in one paragraph to a driver, without appealing to the number. It can:

> **We model trunk roads at the locally posted 70 km/h rather than 85, so a highway detour looks
> less rewarding to us than it does to other routers. We treat a minute saved as worth about 2.5 km
> of extra driving on an ordinary road, less on a rough one and more on a smooth one, so we decline
> long detours and we will not send you down a village road to save a little distance. And we price
> the Yamuna Expressway toll at what it actually costs, 2.65 rupees per km against a driver's time
> at 225 rupees an hour, so on Greater Noida to Jewar the expressway wins by a small margin and we
> take it, while OSRM takes it for free because it prices no toll at all.**

**That last clause disagrees with the instinct that started this work,** which was that a local
driver takes NH334DD. It is kept anyway, because the sentence has to describe the model rather than
flatter it, and because the model's reason is now stated in rupees that can be checked rather than
in a constant chosen to produce the preferred answer. If the instinct is right, the thing that is
wrong is the value of time or the tariff, and both are one named constant away from being corrected.

**Why this closes with two failing thresholds.** The standing rule for gate 4 is that a residual
which is an explained and defensible modelling difference counts as passed, and what is forbidden is
moving a threshold because a number is stubborn. Neither threshold moved. Every residual has a named
cause in `VALIDATION.md`, the partition contains **0 router bugs and 0 graph defects**, the search
was cleared by routing our own engine between OSRM's own endpoints, and the graph was cleared by two
independent coverage measures that agree. What remains is three stated preferences that OSRM does not
have: a locally calibrated speed table, a distance-and-quality preference, and a priced toll.

**THE REMAINING GAP, stated because a driver would care about it.** Surface quality is still not
modelled, only road CLASS as a proxy for it. A tertiary road that has been resurfaced and one that
has not are identical to us. The proxy is defensible here and measurably helps, but it is a proxy:
we may still route you down 57 km of village road because the class table says tertiary is ordinary
when that particular tertiary is not. `surface` coverage is too sparse and too biased to fix this
today, per the calibration above. **Gate 9, on a real drive, is where this gets found out**, and it
is the first thing to re-examine when a route feels wrong but prices correctly.

---

## Turn costs: a gap closed, not a choice made. Built at gate 4, calibrated on the divergence set.

Until this, every turn cost ZERO. That is not a modelling decision anyone took, it is a gap, and
it has a predictable shape: a router with free turns prefers a many-turn path through small streets
over a fewer-turn path along an arterial whenever the small path is even slightly shorter, because
nothing about the small path costs extra. `packages/engine/turncost.ts`, values in `config/city.ts`,
swept by `npm run experiment:turns`.

**Four terms, kept separate so each can be argued about alone rather than vanishing into one fudge
factor:** severity from bearing delta, crossing oncoming traffic, dropping road class, and the
U-turn. The speed table was held FIXED throughout, so every number below is attributable.

**Each term isolated, then combined. All 56 validation pairs.**

| candidate | dist median | dist p95 | overlap | GBU to Jewar |
|---|---|---|---|---|
| off | 3.39% | 17.90% | 70.50% | 37.49% |
| severity only | 3.19% | 16.98% | 74.63% | 37.49% |
| crossing only | 3.10% | 14.81% | 73.81% | 37.49% |
| class drop only | 2.91% | 22.15% | 71.25% | 37.49% |
| U-turn only | 3.39% | 17.90% | 70.50% | 37.49% |
| **shipped (3 / 3 / 2 / 40)** | **2.73%** | **16.98%** | **75.10%** | 37.49% |
| class heavy | 2.58% | 16.98% | 74.81% | 37.49% |
| strong | 3.20% | 16.98% | 73.74% | 37.60% |

`overlap` is the share of OUR route length running within 25 m of OSRM's line, averaged over the 40
pairs that stayed inside `BUILD_AREA`. It exists because a distance delta can fall while the route
runs down a different road entirely, which would mean the model got the right number by accident.

**The gap was REAL: the shape converged.** Overlap rises 70.50% to 75.10%, and the distance median
falls 3.39% to 2.73%, inside its 3% threshold for the first time. Both moved together, which is the
evidence that the routes actually changed for the better rather than the metric drifting.

**And it is NOT the cause of the landmark divergence.** `gautam-buddha-university to jewar` is
unmoved at 37.49% under every candidate, and its route is byte identical: same 43.87 km, same
58% motorway, same Yamuna Expressway. Only its cost rose, by the 1.1 min of turn penalties it now
pays. For that pair the residual really is the speed table, which is what the sweep was run to find
out.

**`class-heavy` scores a better median and was NOT taken.** 2.58% against 2.73%, but on worse
overlap and with 9 pairs moved rather than 5. Choosing it would be selecting the larger intervention
on the weaker signal, for a metric that is already inside its threshold.

**THE U-TURN PENALTY CANNOT BE CALIBRATED HERE, and this is the finding, not a gap in the work.**
`uturn-only` reproduces `off` in every column to every digit, and the total U-turn penalty charged
across all 56 routes is **0.0 minutes**. The router takes no U-turns on any validation pair, exactly
as the gate 3 measurement of 0 reverse-twin U-turns over 92 km predicted. So the validation set
carries zero signal about `uTurnS` and no sweep over it can mean anything. The MECHANISM is proved
instead by unit test, `tests/engine/turncost.test.ts`: charged at a junction, exempt where outgoing
degree is 1. The pinned terms hold, a penalty and never a ban. The number stays a reasoned 40 s and
gets its real calibration at gate 8, where re-routing from a matched mid-road position is the first
thing that will actually exercise it.

**Admissibility, since A\* comes next.** Every term is non-negative, enforced at construction by
`assertNonNegative` rather than left to review, because a negative turn cost does not fail, it
silently breaks optimality. Turn costs can therefore only ADD to a path, so any heuristic that lower
bounds the turn-free remaining cost still lower bounds the real one and stays admissible with no
modification. That is the sentence the A\* proof depends on and it is why the constraint is
mechanical.

**One convention worth stating, because it is exactly wrong half the time.** India drives on the
LEFT, so the turn that waits for a gap in oncoming traffic is the RIGHT turn. `drivesOnLeft` is an
explicit flag, not baked in. `bearingDelta` returns (-180, 180] closed at the top so an exact
reversal is classified as crossing rather than escaping the penalty on a sign convention.

---

## Hot-loop constant factors, profiled at gate 3 BEFORE building A\*. `npm run profile:route`.

A heuristic on top of a slow loop hides the slow loop. So the loop was profiled first, and the
profiler reports **settled and relaxed counts beside wall time**, because the two failure modes
are indistinguishable from milliseconds alone: too many states expanded (a heuristic fixes it)
versus each expansion too expensive (no heuristic fixes it).

The search is EDGE based, so the denominator is 532,951 directed edges, not 213,144 vertices.

| Route | km | before | after | settled | % of graph | ns/settle before | after |
|---|---|---|---|---|---|---|---|
| Pari Chowk to GBU | 8.4 | 28.8 ms | 17.5 to 24.1 ms | 46,001 | 8.6% | 627 | 380 to 523 |
| Surajpur to Knowledge Park | 8.7 | 24.2 ms | 16.0 to 19.7 ms | 34,711 | 6.5% | 698 | 461 to 569 |
| Dadri to Pari Chowk | 14.4 | 76.5 ms | 44.8 to 49.4 ms | 110,918 | 20.8% | 689 | 404 to 445 |
| Gaur City to Jewar | 60.8 | 287.4 ms | 227.4 to 244.6 ms | 490,961 | 92.1% | 585 | 463 to 498 |

Ranges are real run-to-run variance on this machine, which is large enough that mid-route
differences between individual optimisations were not distinguishable from noise. The long
routes carry the signal.

**Diagnosis: both failure modes were present.** The cross-city route settles 92.1% of the graph,
which is the case for A\* and bidirectional search. But ns/settle ROSE with the fraction of the
graph searched (391 at 6.5%, 603 at 92%), which is the signature of memory stalls rather than
arithmetic, and no heuristic addresses that.

Three changes, all constant-factor:

1. **Per-edge traversal seconds precomputed** into a `Float64Array` at construction. It had been
   `length / (speed * KMH_TO_MS)` evaluated inside the relaxation loop: a float division plus two
   typed-array reads, 1,388,769 times on one cross-city route. Costs 4.3 MB.
2. **No per-pop iterator allocation.** The end-of-route check iterated a candidate array with
   `for...of` on every pop, allocating an iterator object 490,961 times per cross-city route. The
   end is at most two directed edges, so they are now two scalars.
3. **`dist`, `parent` and `stamp` interleaved** into one 16-byte-per-edge buffer. All three are
   read at the same random CSR-derived index every relaxation; as three separate arrays that was
   three cache lines per relaxation. This is the change that moved the long routes (cross-city
   295.8 to 227.4 ms), which is what the cache hypothesis predicted and is the evidence for it.

**Still short of target, and the remaining gap is named.** The gate 5 target is p95 under 30 ms.
Cross-city sits near 230 ms, so about 8x remains against roughly 4 to 20x from A\* plus
bidirectional. What is left of the constant factor looks memory-bound rather than algorithmic;
the untried levers are a 4-ary heap (fewer, more local sift levels) and interleaving the heap's
own two arrays. Those get revisited at gate 5 if the ladder alone does not close it.

No conclusion about CH is drawn from any of this: that decision (see the top of this file) rests
on p95 after the ladder is built, not before.

---

## The 30 ms re-route budget names a case, not a query length. DEFINED at gate 5.

**This is a correction to how the budget was specified, and it is not a relaxation.** The
distinction matters enough to write down, because from the outside the two look identical: both
end with a threshold applying to fewer queries than before.

What makes this a definition rather than a moved goalpost:

- **No query leaves the sample.** The re-route distribution is drawn exactly as before, origins
  part way along real routes with the real remaining endpoint, sampled uniformly over the whole
  trip. Every query drawn is still measured, still reported, and stays in permanently.
- **The combined figure is still printed**, with its own p95, beside the two bands. The number
  that used to carry the verdict is still visible, so a reader can see precisely what the split
  changed.
- **The threshold did not move.** It is the same 30 ms. What changed is the statement of which
  queries it was ever a claim about.
- **It was written down before the measurement it affects**, not after a run came in over budget.

The substance. `rerouteP95Ms` was never derived from a query length; it was derived from a felt
requirement, a driver who has deviated and needs the new line before the next decision. The sample
as drawn contains that case and also contains a case the budget was never about. A re-route with
84 km remaining belongs to a driver who still holds a valid old route and more than an hour of
road. Nothing in their experience distinguishes 30 ms from 300 ms, and no interface event is
waiting on it. Judging that query against 30 ms measures something nobody can perceive, and worse,
lets it set the p95 that decides a verdict about a requirement it does not belong to.

So the sample is reported in two bands:

| Band | Definition | Threshold |
|---|---|---|
| Urgent | remaining distance under `ROUTE_BUDGET.urgentRemainingKm` (15 km) | p95 under 30 ms, PASS or FAIL |
| Long tail | everything beyond | measured and reported, no threshold |

**The boundary is a proxy and is named as one in the constant.** The variable that actually
decides urgency is time to the next maneuver. That quantity does not exist yet: instructions
arrive at gate 7 and tracking at gate 8. Remaining distance is what the benchmark can compute
today, it correlates with what is meant, and 15 km is roughly twenty minutes of driving at the
arterial speeds this graph produces. It gets revisited at gate 8 against the real quantity, and if
it moves, that move gets recorded here the same way.

**What this does not excuse.** The long-tail band having no threshold is not permission to let it
regress. It is reported in full, its p95 sits in `BENCHMARKS.md` next to the urgent band, and a
tenfold move there is a defect whether or not a number goes red.

---

## Exact state at via-way restrictions. Built at gate 5. DO NOT SIMPLIFY THIS BACK.

**Decision: a via-way edge carries one search state per neighbour, not one state per edge.** Forward
states are keyed by the incoming edge, backward states by the outgoing edge, plus one slot each for
a seed that has no neighbour. Every other edge in the graph keeps a single state, indexed by the
edge id exactly as before.

**Why the obvious design is wrong**, which is the part worth writing down, because the obvious
design is smaller, faster and was in place for four gates.

The search state was one directed edge. A restriction check needs the edge the driver ARRIVED on,
and that was recovered by reading the parent array. For a via-NODE ban that is exact, because such a
ban is a statement about a pair `(via, to)` and needs no history. For a via-WAY ban it is not: that
is a statement about an ordered triple `(from, via, to)`, and the parent array holds only the
CHEAPEST arrival, so the triple was judged against one approach out of several.

**The measured case**, from `gate:equality`, on the built graph:

```
banned triple      290382 -> 279799 -> 290383
before   290382 -> 277856 -> 128892 -> 128891 -> 279801 -> 290383 ...    814.9 m
after    290382 -> 13975  -> 13974  -> 279799 -> 290383 ...              539.1 m
```

Reaching the via way `279799` from `13974` rather than from `290382` makes the same continuation
legal, because the banned triple names a different `from`. The search never considered it: `290382`
is the cheaper arrival, so it became the parent, and the continuation was refused. The route
returned was **51% longer than a legal alternative**, which is precision charter item 11.

**How it was found, and why it could not have been found sooner.** Not by a test of the forward
search, which was self-consistent. It surfaced the moment a SECOND search direction existed to
disagree with it: the backward search enumerates predecessors and applies each triple per
predecessor, so it was already exact where the forward search was not. `gate:equality` reported ten
disagreements, and the two validators added alongside it attributed them. The path-legality
validator proved both routes legal, which ruled out "one rung ignores a ban". The
cost-against-returned-path validator proved each rung's reported cost was its own path's cost, which
ruled out an accounting error. What remained was that the cheaper route was real and one rung could
not see it.

**What it costs.** Only the keys of `bannedSequences` expand: 12 edges of 532,951, so a few dozen
extra states. The hot path pays one `Uint8Array` read per relaxation, deliberately a byte rather
than testing a wider base array, so the common case fits 64 edges to a cache line.

**What would reopen it:** nothing short of the via-way table becoming empty. If a future extract
carries no via-way restrictions the expansion allocates nothing and costs one predicted-false byte
read, so there is no version of "simplify it back" that is worth the correctness it removes.

---

## Gate 5, CLOSED. The initial-route budget is ACCEPTED UNMET, deliberately.

**Decision: ship bidirectional, close gate 5, and do not optimise the initial route further.**

**What passes.** The felt requirement. A re-route is computed mid-trip while the driver is moving
and a stale line is on screen, so its latency is felt directly, and the urgent band clears its
budget:

```
both budgets, per rung  (urgent = under 15 km remaining)
  rung                    urgent p95        long tail p95  initial p95
  dijkstra                     85.72   FAIL        515.20       633.07   FAIL
  dijkstra-h-discarded        115.66   FAIL        670.39       830.39   FAIL
  astar                        69.07   FAIL        597.28       770.55   FAIL
  bidirectional                27.46   PASS        356.74       560.48   FAIL
```

**What does not, and the honest state of the number.** Initial-route p95 is 560.48 ms on the run
above, against a 150 ms budget. That run's machine was the slowest of five: Chrome held roughly a
full core and Dijkstra's own initial p50 read 412.52 ms against 161.39 ms on the quietest run.

**THE 243 ms FIGURE IS ARITHMETIC ACROSS TWO MACHINES AND IS NOT A MEASUREMENT.** Bidirectional ran
at 560.48 / 633.07 = **0.885** of Dijkstra's initial p95 in that run. Applying that ratio to the
quietest run's Dijkstra p95 of 274.71 ms gives about **243 ms**. That is an estimate produced by
multiplying a within-run ratio by a different run's absolute number, which is exactly the operation
`hard-rules.md` now forbids drawing conclusions from. It is recorded because it is the best
available indication, and labelled because it is not evidence. **Gate 5 is not closed on it.**
No clean-machine measurement of the initial-route budget exists.

**Why closing anyway is the right call, stated as a position rather than a consolation:**

- An INITIAL route is computed once, at trip start, off the interaction path. Nothing is animating,
  no dot is moving, and the driver has just finished typing a destination.
- The p95 is set by corner-to-corner queries across a **3,432 km2 district**, 69.2 by 49.6 km. Four
  such pairs are pinned in the sample permanently and cannot be argued out. They are not a typical
  trip; they are the worst query the area admits.
- The felt requirement passes with margin, on the most loaded machine measured.

**What would reopen it:** gate 9, on a real drive, showing perceptible lag at trip start. **With a
measurement on the phone, not with arithmetic.** If that happens the cheapest lever is already
costed in the next section.

---

## Deferred: an equirectangular heuristic in place of haversine. Named and costed at gate 5.

**Not built. Recorded so it is not rediscovered from scratch, and not built because nothing needs
it yet.**

The A\* heuristic evaluates one haversine per vertex touched, memoised per query. Measured with the
fixed per-route cost cancelled, by differencing `dijkstra` against `dijkstra-h-discarded`, which
settle identical states in identical order: **235 to 273 ns per state**, against a baseline marginal
cost near 900 to 1100 ns per state. So the heuristic is roughly a quarter of per-state cost.

**The replacement.** Great-circle distance can be lower-bounded by a planar distance whose
east-west component is scaled by the MINIMUM cosine of latitude over `BUILD_AREA`. Over lat
28.058161 to 28.679899 that factor varies only between about 0.8823 and 0.8779, so using the
smaller value under-estimates the east-west term everywhere and the bound stays admissible. It
replaces two sines, two cosines and an arcsine with a square root.

**The value, estimated not measured:** A\* cuts 51.5% of re-route states for a 43.5% time saving
today. Removing most of the heuristic's cost would move that toward roughly 50%. On initial routes
the gain is smaller because the state cut is smaller.

**Why it is deferred.** It is worth about 1.2x, and the only budget still failing is the initial
route, which needs more than that. Re-routes already pass with margin. **Revisit only if gate 8's
tracking loop turns out to need the headroom**, and if it does, the measurement to take first is
whether the re-route budget still passes under a live fix stream at 1 Hz with the camera animating.

---

## Deviation, CLOSED: the server no longer imports `pipeline/`. Fixed after gate 3.

`packages/server/CLAUDE.md` says the server may import `config/`, `shared/` and `engine/`, and
never `pipeline/`. It currently imports `loadOrBuildClip`, `buildGraph` and `buildTurnTable`
from `pipeline/`, plus the style module. **This is a stated rule violation, not an oversight**,
and it is recorded here so it cannot be quietly inherited.

**Why it happened:** the graph and the turn table are not serialised artifacts yet, so the only
way to hold a routable graph at boot is to rebuild it from the clip cache. That also costs the
server a 3.8 s boot.

**The fix, now shipped:** `build-city` writes `data/graph.bin` (35 MB) and `data/style.json`, and
the server memory-loads both. The format is stated once in `shared/graphfile.ts`, because the
writer is in `pipeline/` and the parser in `engine/` and neither may import the other. Every array
is a zero-copy subarray view, which is why the writer orders sections widest-alignment-first.

**Measured, on an idle machine:** boot fell from **3.8 s rebuilding to 2.87 s loading**, and a
route returns byte-identical results (`distanceM 8413.272094997856`, `cost 989.8245660657711`,
before and after). An intermediate measurement of 89.36 s was taken while `build-city` was running
tilemaker on the same machine and is contention, not the artifact path; it is recorded here
because a number that large is worth explaining rather than quietly dropping.

`grep` for `pipeline/` imports under `packages/server/` now returns nothing.

---

## Timers are unreliable under load. Recorded at gate 0, binds from gate 8.

Measured with Chrome DevTools at 4x CPU throttle: a requested 100 ms interval fired at
**188, 315, 253 and 117 ms**. The tracking simulator and the display-dot smoother must be
driven by fix `timestamp` deltas and never by an assumed 1 Hz cadence. Code that assumes
cadence passes on this laptop and jitters on the target device, which is the hardest place to
notice it.
