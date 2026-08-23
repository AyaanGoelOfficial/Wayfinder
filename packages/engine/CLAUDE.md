# packages/engine — routing, snapping, instructions. Pure, no IO

Receives loaded typed arrays, returns plain data. Never touches the filesystem or network,
which is what lets the whole ladder be tested against hand-built toy graphs.

- **The rungs must agree EXACTLY.** A\*, bidirectional, and anything later must match plain
  Dijkstra per pair, within 1e-6 on cost. A mismatch is release-blocking, never explained
  away as rounding. Dijkstra is the definition of correct here.
- **The A\* heuristic must stay admissible**, and the proof lives in a comment beside it.
  An inadmissible heuristic still returns routes, just silently wrong ones, which is the
  worst failure mode in this package. **Turn costs do not threaten this and the proof must
  say so explicitly rather than leave it implied:** every term in `TURN_COST` is
  non-negative, enforced at construction by `assertNonNegative`, so turn costs can only ADD
  to a path. A heuristic that lower-bounds the turn-free remaining cost therefore still
  lower-bounds the real cost. A negative turn cost would break optimality silently, which is
  why that check is mechanical and not a review item.
- **THE OBJECTIVE IS NOT JUST TIME, and `seconds` is NOT a duration.** `seconds` is the modelled
  cost the search minimised: `driveSeconds + turnSeconds + distanceSeconds + tollSeconds`. Only
  `driveSeconds` is comparable to another router's duration. Reporting `seconds` next to an OSRM
  duration compares a model against a measurement, which has been introduced and fixed twice here.
- **THE DISTANCE CHARGE IS PER CLASS, so it is NOT recoverable from the total.** `distanceSeconds`
  is summed from a precomputed per-edge array, never as `metres * secondsPerKm`: with a quality
  weight the charge depends on WHICH classes the route used, not only how far it went, and deriving
  it from the total would report a number the search never charged. A weight of 1.0 everywhere, or
  an absent `qualityByRank`, restores the flat behaviour the toy graphs assume.
- **THE SEARCH PAYS A PROXY, THE REPORT PAYS THE TRUTH, and they are different numbers by
  design.** Every toll road contributes a smooth `searchRatePerKm` to the edge cost, because a
  shortest path can only minimise an additive cost and no real toll mechanism is additive. The
  billed figure is computed once, over the chosen path, by that road's exact mechanism. Do not
  "fix" the disagreement by putting the exact mechanism back into the edge cost: it was tried, and
  a 140 rupee barrier on one 604 m edge became a 37 minute penalty that the router answered by
  leaving the expressway and rejoining past the plaza. `DESIGN.md` states the pattern once.
- **`tollConfidence` is decided per continuous RUN, never per edge.** Whether a ramp was involved
  is a property of the whole run: a route crossing a barrier only on its last edge is a mainline
  crossing throughout, and judging each edge as it passed marked the whole thing an estimate.
  It also tracks roads TRAVERSED, not roads charged, or a route that exits before the plaza reports
  `verified` on the strength of having paid nothing.
- **`avoidTolls` is a HARD filter, never a large penalty.** "Avoid tolls" means the route must not
  use one; pricing tolls very high instead still returns a tolled route when no free one exists,
  which is the opposite of what the caller asked. Returning no route is the correct answer.
- **TURN COSTS ARE CHARGED ON THE ARC, inside relaxation.** The cost of moving from edge `e`
  to edge `f` depends on both, so it belongs in the tentative distance and competes like any
  other cost. Charging it after the fact would let a cheap arrival win on edge cost and then
  pay a turn it never competed on. `seconds` is the total modelled cost and `turnSeconds` is
  the turn portion of it: anything comparing our cost against a path priced from speeds alone
  must subtract `turnSeconds`, or it compares a model against a measurement.
- **`Router`'s turn model is OPTIONAL, and the toy graphs leave it off.** Toy graphs have no
  meaningful bearings, and forcing a turn model on them would make every unit test assert
  against angles instead of against the search. Production always passes one.
- **Zero allocation in the hot loop.** Preallocated typed-array dist/parent/visited with
  GENERATION COUNTERS rather than clearing between queries. Clearing a million-entry array
  per request is the mistake this note exists to prevent.
- **Results must be deterministic.** Equal-cost ties broken by a stable rule, never by
  insertion order or heap luck, or golden routes drift for no reason.
- **TWO SNAP RADII, and they are not interchangeable.** `SNAP_TRACKING_M` (40 m) for live
  fix matching; `SNAP_DESTINATION_M` (500 m) for a tapped or searched destination. A
  tracking path using the destination radius is a bug. The `dadri` fixture exists to catch
  exactly that crossing.
- **Snapping and matching respect direction of travel.** Never return the opposite
  carriageway of a divided road or an overpass neighbour because it is marginally closer.
  Charter item 3, with `gaur-city` as the permanent test site.
- **Haversine is implemented ONCE**, tested against known distances. Distance along a route
  comes from edge offsets, never accumulated per-frame floats. Charter item 8.
- **`noUncheckedIndexedAccess` is on repo-wide.** If it becomes genuinely unworkable in a
  CSR hot loop, override it in a tsconfig for this package with the reason written here
  first. Do not scatter non-null assertions to silence it.
- **AN INSTRUCTION IS ONLY EMITTED FOR A MANOEUVRE THE DRIVER ACTUALLY MAKES.** A vertex exists
  wherever two ways meet, so a route driving straight through a crossroads produces an edge change
  with no turn in it, and a road that bends through a junction produces a real angle with no
  decision in it. Suppression is the hard half of `instructions.ts`, not detection: without it a
  73 km route grows an instruction per junction and stops being read at all. Every suppression rule
  is pinned by a toy-graph test that asserts NOTHING is emitted.
- **A BEND IS NOT A TURN, and a fork onto the road you are already on is not a fork.** Under a
  slight turn on a continuously named road, no manoeuvre is emitted whatever the out-degree. The
  measured case: "turn slight left onto Noida-Greater Noida Expressway" 20 km into a route already
  on it, then "keep right onto Bendy Road" once the out-degree escape was added.
- **A MERGE IS DEFINED BY THE CLASS JUMP, AN EXIT BY THE CLASS JUMP PLUS A NAME CHANGE, and the
  asymmetry is the data.** Slip roads onto an expressway are unnamed, so requiring a name change on
  the merge suppressed the single most important instruction on a 73 km route. Rural trunk roads
  flip between trunk and unclassified along one carriageway, so NOT requiring one on the exit fired
  five times in 2.5 km.
- **A MANOEUVRE IS NAMED FROM AHEAD OF THE JUNCTION, never from the edge at it.** The edge after a
  junction is usually the slip road and slip roads here are unnamed, which produced "merge onto
  (unnamed)" onto the Yamuna Expressway. `nameAhead` also prefers a structure-free name, so a driver
  is told "Vikas Marg" and not "Vikas Marg Underpass".
- **THE DECISION AND THE LABEL MUST USE THE SAME NAME.** They did not, and the result was "continue
  onto Vikas Marg" three times in 7 km: the decision compared raw way names, which really did
  change, while the label resolved back to the same road each time.
- **JUNCTION POSITIONS ARE NEAREST-MATCHED ALONG THE LINE, never first-past-the-target.**
  `edgeLengthM` is haversine from the pipeline and the instruction builder measures the polyline
  with a local flat approximation. They agree to about half a percent, which is nothing over a route
  and everything at a corner: the index landed one shape point past a square left, the bearing was
  read from after the turn to further after it, and a 90 degree turn was never announced.
- **ONE INSTRUCTION PER ROUNDABOUT, AT THE ENTRY.** A separate enter and exit produced a pair whose
  second half read "0 m" on every small circle, because on a short traversal the entry and the exit
  are the same place, and a careful reader took "enter, 1.3 km" then "exit, 0 m" to mean 1.3 km were
  driven inside the circle. A number that has to be explained is wrong on screen. `roundabout-enter`
  survives only for a route that ENDS on a circle, and must not invent an exit number there.
- **TWO EXITS MERGE FOR TWO DIFFERENT REASONS, AND THEY ARE NOT THE SAME RULE.** Proximity, under
  `SAME_EXIT_M`, says a driver cannot resolve two exits less than a car and a half apart, whichever
  way they point: confirmed at 8.4 m on a pair whose roads differ by 106 degrees. DIRECTION, under
  `SAME_ARM_DEG`, says two adjacent exits whose roads run the same way are one divided road: the
  case that forced it meets the circle 28.7 m apart, wider than gaps between genuine exits on the
  same route, so no distance rule can catch it. Conflating them gave a right answer on one circle
  and a wrong one on another. 15 degrees is measured, not fitted: over 288 circles the adjacent-pair
  bearing difference is bimodal with a cluster under 15 and a trough from 15 to 45.
- **NEVER DISCARD AN EXIT FOR BEING SHORT OR MINOR.** It was a candidate and it is wrong: a confirmed
  circle's first exit is a 22 m `residential` way that the driver counts. Class and length say
  nothing about whether a road is an exit.
- **A U-TURN PENALTY IS NOT A DIVIDED-ROAD REVERSAL PENALTY, and conflating them would be a defect.**
  `uTurnS` prices the REVERSE TWIN only. Going round a median gap onto the opposite carriageway uses
  a different edge and is never charged by it, correctly: it is legal, it is often the only way to
  reach the other side, and Google produces the identical manoeuvre where we do. Measured: the knee
  where twin U-turns stop being chosen is 8 s, the shipped 40 s is five times above it, and the
  reviewed route is geometrically identical from 0 to 600 s.
- **`searchUnindexed` IS NOT DEAD CODE.** It is the same ranking with no precomputation, kept
  runnable so the index's value is measured in the product rather than asserted. It MUST return the
  identical ranking to `search`, and `tests/engine/search.test.ts` enforces that rather than trusting
  the comment.
- **`edgePrivate` IS PRICED, NOT BANNED, and the penalty is only half the mechanism.**
  `privateSecondsPerKm` stops a private road being used as a THROUGH route. It cannot stop a route
  ENDING inside a gate, because the snap picks its edge before the search runs: sweeping the
  constant from 0 to 1800 left the gated-campus approach at 160 m at every value. The server snaps
  preferring a public edge and falls back to private only when none is in radius. Measured knee
  90 s/km, shipped 180. A ban is wrong: 0.85 km of the remaining private road is genuinely the only
  way in, and four places in the index have no legal edge within 500 m at all.
- **Imports:** `config/`, `shared/`. Nothing else. No Node built-ins.
