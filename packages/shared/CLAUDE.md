# packages/shared — THE CONTRACT

Every type crossing the server/client boundary. If it is not named here, neither side may
assume it exists.

- **`LngLat` is `[lon, lat]`. GeoJSON order. Everywhere, no exceptions.** OSM APIs, Leaflet
  and most human speech say lat/lon; GeoJSON, MapLibre and this codebase say lon/lat. The
  swap is silent, plausible, and puts Greater Noida in the Indian Ocean. Never introduce a
  `{lat, lon}` object into a geometry path to "make it clearer".
- **Adding a capability means editing this file FIRST**, then the two sides. A raw string
  route or an inline response shape defeats the entire point of the boundary.
- **Every user-reachable failure needs an `ErrorCode` and a message stating a REMEDY.**
  Precision charter item 10. "Point too far from road" is a fact; "point is 480 m from the
  nearest road, drop the pin closer" is a remedy. Messages here are user-facing, so
  `rules/copy.md` binds: no em dash, en dash, or interpunct.
- **`Route.id` is monotonic per server process and exists solely so the client can discard
  stale answers** (charter item 6). Never reuse or reset it.
- **`Route.geometry` is full-fidelity edge shape geometry.** Not vertex-to-vertex. Anything
  that simplifies it beyond sub-pixel tolerance at max zoom breaks charter items 1 and 2.
- **`Route.tollDisplay` decides whether a rupee figure may be shown bare or must be labelled an
  estimate, and a view may NEVER decide that for itself.** The rule lives in `toll.ts` as a
  function both sides call, because a ⛔ in a doc comment is a prompt and a function is enforcement.
  An estimate presented as a fact looks exactly like a fact, so the failure is silent.
- **`BuildReport.dedupe` counts must be non-zero.** The two extracts overlap along the
  Central/Northern seam, so a zero duplicate count means the dedupe never ran.
- **`Instruction.distanceM` IS THE LEG BEFORE THE MANOEUVRE, not after it.** It is the distance
  from the previous manoeuvre to this one, so a step reading "Turn left, 210 m" means the turn is
  210 m ahead. Both conventions exist in the wild and picking the other one silently shifts every
  number by one row.
- **`roadName` is ABSENT, never an empty string, when a way has no name.** Most roads here are
  unnamed, so this is the common case rather than a defect, and an empty string renders as "Turn
  left onto " with a dangling preposition.
- **`Approach` IS NOT PART OF THE DRIVEN ROUTE.** It is the straight gap between where the driving
  stops and where the user asked to go, and it must never be folded into `distanceM`, `durationS` or
  `instructions`: a driver cannot drive it and an ETA including it is wrong. It is a straight line
  because we have no pedestrian routing, and drawing anything path-shaped would imply one.
- **`tracking.ts` IS THE TRACKING ENGINE, AND IT LIVES HERE RATHER THAN IN `engine/` FOR A
  BOUNDARY REASON, not a filing one.** The client runs it, and `packages/CLAUDE.md` lets the client
  import `config/` and `shared/` and nothing else. On-route matching needs no graph, only the route
  polyline the client already holds, so it costs no round trip and works with no network.
  Free-drive matching DOES need the spatial index over 532,951 edges, so that half is a server
  endpoint in `engine/mapmatch.ts` behind `/match`. Do not move either half across that line.
- **NO BROWSER ANYTHING IN `tracking.ts`.** No timers, no `Date.now()`, no rAF, no DOM. Time enters
  as fix timestamps and as an explicit `nowMs` argument. That single decision is what makes the
  whole engine testable against synthetic traces, and it is also what makes it immune to the timer
  unreliability measured at gate 0: under 4x CPU throttle a requested 100 ms interval fired at
  188, 315, 253 and 117 ms.
- **THE MATCHER GATES ON HEADING AND ONLY RANKS ON DISTANCE, and that ordering is a measurement.**
  `npm run calibrate:tracking`: 71.9% of one-way road samples in this city have an opposing
  carriageway inside `SNAP_TRACKING_M`, at 7.91 m separation at p5. No consumer fix separates
  those by distance, and every confusable pair is opposed by at least 150 degrees. Folding heading
  into a score as one term among several lets a slightly nearer wrong carriageway outvote it; a
  gate cannot be outvoted. Reversing this reintroduces precision charter item 3 across most of the
  network, not in a corner case.
- **`matchToRoute` RETURNING NULL IS AN ANSWER, not a failure.** It means nothing survived the
  heading gate, and the caller must hold its previous match rather than claim a road it cannot
  justify. A stopped vehicle at a divided-road junction is exactly where inventing one puts the
  dot on the wrong carriageway.
- **A FIX IS ONLY IMPOSSIBLE IF IT IS IMPOSSIBLE ALLOWING FOR ITS OWN STATED ACCURACY.** The
  implied-speed filter subtracts both fixes' `accuracyM` before computing speed. Comparing raw
  positions rejected 581 of 1,121 fixes on an ordinary 8 m noise drive, because at a 96 ms
  interval a vehicle travelling 1.3 m is displaced about 11 m by noise and reads as 420 km/h.
  `accuracyM` is a 95% radius per the W3C Geolocation definition, not a sigma; anything producing
  fixes must report it that way or the filter is right to reject them.
- **Imports:** `config/` only. Never a package, never Node built-ins, never the DOM. This
  file is bundled into the browser.
