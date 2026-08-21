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
- **A ROAD'S OWN RAMPS BELONG TO IT, and ONLY anonymous `*_link` ways are eligible.** Interchange
  ramps are tagged `toll=yes` and usually carry no `name` and no `ref`, so name matching drops them
  to `unpriced`, and since route confidence is the weakest link that dragged EVERY EPE route down.
  `attributeTollRamps` claims them by SHARED NODE, which is exact where a radius would need tuning.
  A way carrying a `name` or a `ref` is asserting an identity and geometry does not overrule it: a
  first cut without that guard absorbed the Delhi Western Peripheral and NH148NA into EPE, and the
  symptom was an unpriced total of exactly 0.00 km, which reads as success.
- **BOTH KINDS OF TOLL BOOTH ARE MARKED, mainline and ramp, and they bill differently.** Marking
  only mainline barriers left the router free to leave a gate-charged expressway at one interchange
  and rejoin past the plaza for nothing, which it did, over 22.0 km. Distinguishing the two rather
  than merging them is what still avoids billing one plaza several times.
- **EPE chainage is MEASURED, never matched by village name.** `epe.ts` chains the mainline and
  anchors on a fitted constant; `npm run calibrate:epe` is the derivation and REFUSES on a drifting
  residual. OSM names three of eleven plazas and the villages it carries sit up to 18 km off the
  road, so a name match here is inference wearing the clothes of observation.
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
- **ROAD NAMES ARE INTERNED, AND A SEMICOLON IS AN ENCODING, NOT A NAME.** OSM joins multiple
  values with `;`, so a road carrying two national numbers is tagged `NH34;NH334C`, and that reached
  the turn-by-turn list verbatim as "Continue onto NH34;NH334C". Only two names in the whole table
  carry it, which is exactly why it survived review: rare enough to miss, user-facing when it
  appears. The first value is what a sign leads with. `name` is preferred over `ref`, and an empty
  string never enters the table or every unnamed edge would share index 0 and read as a road
  actually called "".
- **`junction=roundabout` IS STORED PER EDGE even though it is already consumed as an implied
  one-way.** "Take the third exit" is a statement about the circle, and the exit has to be COUNTED
  while traversing it. Nothing else in the artifact identifies which edges form the circle, so the
  engine cannot recover it. This is what made the format v6 bump, alongside the name table.
- **A CIRCLE IS A SHAPE, AND OSM OFTEN FORGETS THE TAG.** Two roundabouts on `alpha-1 to surajpur`
  are `highway=secondary oneway=yes` closed loops with eight connections each and no `junction` tag,
  so the instruction builder announced neither and called one of the entries a turn that does not
  exist. `isUntaggedCircle` promotes a closed, ALREADY one-way, non-service way whose widest span is
  at most 180 m and which touches at least three other drivable ways. Every number is measured: the
  widest circle OSM itself tags here spans 181 m, the one-way block systems above start at 290 m,
  and the connection test is what separates a roundabout from a cul-de-sac turning head, which is
  also a small closed one-way loop. Without it 109 loops promote and 86 are turning heads.
- **⛔ PROMOTION IS ADDITIVE AND MUST NEVER FEED BACK INTO ONE-WAY INFERENCE.** It requires the way
  to be one-way already, from its own tags, so promoting can never change a direction of travel and
  therefore can never change a route. `edgeRoundabout` is read by the instruction builder and by
  nothing else. Feeding it back into `directionOf` would turn an instruction fix into a legality
  change, which is the one thing this folder must not do by accident.
- **Imports:** `config/`, `../clip/`, Node built-ins. Never `engine/`, never `server/`.
