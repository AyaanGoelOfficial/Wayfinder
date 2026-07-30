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

**Known gap at gate 1: 12 restrictions are NOT honoured.** All 12 are `no_u_turn` with a
via-*way*, which OSM uses to model U-turn bans on divided carriageways via the connector
between them. A via-node table cannot express a two-hop constraint. Every one is a potentially
permitted illegal turn, which is charter item 7.

The forensics rule out the other explanations: **zero** failed because a member fell outside
`BUILD_AREA`, **zero** because a member was not drivable, **zero** because SCC filtering
dropped a member. So widening the restriction-resolution window beyond the clip would fix
nothing. The remaining 3 unresolved are genuinely malformed relations missing `from`/`to`
roles, and cannot permit an illegal turn because they name no turn.

**Planned fix, at gate 3 or later:** where the from-way is the ONLY way arriving at the via
way's entry vertex, arriving on the via edge *implies* having come from the from-way, so an
unconditional ban on (via edge, to edge) is provably exact rather than over-banning. That
condition is checkable per relation. Relations failing it need real two-edge lookback.

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
69 x 50 km single-district app, presence should beat moderate prominence gaps), but gate 7
should re-derive them against a wider query set rather than trusting these two cases.

---

## Timers are unreliable under load. Recorded at gate 0, binds from gate 8.

Measured with Chrome DevTools at 4x CPU throttle: a requested 100 ms interval fired at
**188, 315, 253 and 117 ms**. The tracking simulator and the display-dot smoother must be
driven by fix `timestamp` deltas and never by an assumed 1 Hz cadence. Code that assumes
cadence passes on this laptop and jitters on the target device, which is the hardest place to
notice it.
