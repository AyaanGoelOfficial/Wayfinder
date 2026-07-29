# packages/engine — routing, snapping, instructions. Pure, no IO

Receives loaded typed arrays, returns plain data. Never touches the filesystem or network,
which is what lets the whole ladder be tested against hand-built toy graphs.

- **The rungs must agree EXACTLY.** A\*, bidirectional, and anything later must match plain
  Dijkstra per pair, within 1e-6 on cost. A mismatch is release-blocking, never explained
  away as rounding. Dijkstra is the definition of correct here.
- **The A\* heuristic must stay admissible**, and the proof lives in a comment beside it.
  An inadmissible heuristic still returns routes, just silently wrong ones, which is the
  worst failure mode in this package.
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
