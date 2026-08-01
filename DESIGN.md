# Design decisions

Decisions that were made once, from measured evidence, and should not be re-litigated without
new numbers. Each records what was decided, the evidence, and what would reopen it.

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
