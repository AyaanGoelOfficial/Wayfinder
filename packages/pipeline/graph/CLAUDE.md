# packages/pipeline/graph — clipped OSM to a routable CSR graph

Reads the clip cache and produces vertices, directed edges, CSR adjacency, a via-node turn
table, and the largest strongly connected component. This is where legality becomes
structural: if this folder is right, no route the engine computes can be illegal.

- **VERTICES EXIST ONLY AT WAY ENDPOINTS AND INTERSECTIONS.** Intermediate shape points live
  in packed edge geometry and are never vertices. This is charter item 1 (the route line lies
  exactly on the drawn road) made structural rather than something the renderer must remember.
  It is also why the vertex count is far below the clipped node count, and the vertex count
  after SCC filtering is the only one the CH decision should ever be read from.
- **SCC IS ITERATIVE TARJAN, never recursive.** At this scale recursion overflows the stack,
  and it does so while descending the LARGEST component, which is the only one that matters.
- **`oneway=-1` is real and easy to miss.** It means one-way against the way's own node order.
  Forgetting it silently reverses a road, and the route still looks plausible.
- **Implied one-ways: motorway, motorway_link, and any roundabout or circular junction.** An
  explicit `oneway=no` overrides every implication, so the explicit tag is read first.
- **Unknown `highway` values are EXCLUDED, not admitted.** New OSM values appear over time and
  a permissive default puts a car on whatever gets invented next. `highway=track` is excluded
  by judgement: here they are unsurfaced field access, and routing onto one is the classic
  "technically shorter" wrong answer.
- **`access=private` is kept as a flag, not deleted.** The GBU fixture requires a destination
  inside a gated campus to snap to the nearest LEGAL edge at the gate, with the route neither
  failing nor silently driving through. The router can only do that if it knows the way is
  private rather than absent.
- **SPEEDS COME FROM ONE TABLE, and they are estimates until gate 4 says otherwise.**
  `CLASS_SPEED_KMH` is deliberately below legal limits, targeting real travel speed including
  signals, autos and unmarked speed breakers. Never inline a speed at a call site: a second
  source is how a route starts disagreeing with its own ETA. `maxspeed` wins when present and
  parseable; an unparseable value falls back to the class default rather than guessing.
- **`CLASS_RANK` IS STORED PER EDGE, never inferred from speed.** The turn cost model needs to
  know what KIND of road an edge is, to price turning off a big road onto a small one. Deriving
  that from `edgeSpeedKmh` is wrong the moment a `maxspeed` tag appears: a residential street
  posted at 60 would outrank a tertiary road. A `*_link` ranks WITH its parent, so leaving a
  motorway by its own slip road is not charged as a demotion. It rides in the artifact's u8 block,
  which is what made the format v2 bump.
- **NO RESTRICTION IS SILENTLY DROPPED.** Every relation that cannot be resolved is counted by
  reason in `RestrictionStats`. A discarded restriction is an illegal turn the router will take
  happily, surfacing months later as a routing bug rather than here as a data-handling one.
- **Conditional and time-qualified restrictions are NOT honoured, and are counted.** Applying
  one as permanent sends a driver the long way round at 3am; ignoring it silently hides the
  choice. Counting it makes the gap visible in the build report.
- **A dangling way ref does not discard the way.** Extracts genuinely have refs pointing
  outside themselves near their own boundary. Dropping the whole road would sever a corridor
  that is otherwise complete, so the gap is skipped and counted.
- **Distance is haversine, from `geo.ts`, and there must be exactly ONE implementation.** When
  the engine needs it, that file moves to `packages/shared/` rather than being copied. Two
  distance functions is how the ETA and the drawn line start disagreeing.
- **Imports:** `config/`, `../clip/`, Node built-ins. Never `engine/`, never `server/`.
