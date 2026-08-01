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
- **Imports:** `config/`, `shared/`. Nothing else. No Node built-ins.
