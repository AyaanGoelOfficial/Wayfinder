# config — the only place the target city is defined

- **NO HAND-PICKED COORDINATES, EVER.** Every number in `BUILD_AREA` is derived from the
  OSM boundary relation named in `BOUNDARY_RELATION`, buffered by `BUFFER_KM`. If a number
  here cannot be traced to a relation id and a fetch date, it is a bug. **`npm run derive:bbox` does not exist**, so
  recompute from `RELATION_BBOX` and `BUFFER_KM` by hand and let
  `tests/config/fixtures.test.ts` confirm it, or build the script. Reason: a guessed rectangle silently
  truncates the city, and a truncated graph fails as "no route found" far from its cause.
- **Nothing outside this folder may hardcode Greater Noida.** Retargeting the system at
  another city is editing this file and nothing else. A grep for `28.` or `77.` outside
  `config/` and `data/` is a defect.
- **Two extracts are required, and it is measured, not assumed.** The district polygon is
  fully inside Geofabrik Central Zone, but the 3 km buffer crosses into Delhi on the
  western edge, which is Northern Zone. Central alone fails the coverage gate at
  4516/14641 cells. Do not "simplify" back to one extract without re-running the gate.
- **Never pin an extract MD5 here as a build assertion.** Geofabrik republishes daily, so
  a pinned checksum breaks every build within 24 hours. `observedMd5` is provenance only.
  The build fetches the live `<url>.md5` and verifies against that.
- **`SNAP_TRACKING_M` and `SNAP_DESTINATION_M` are NOT interchangeable.** Tight (40 m) is
  for matching a live GPS fix: farther than that means the matcher is wrong, not that the
  driver is in a field. Generous (500 m) is for a tapped or searched destination, which may
  legitimately sit off-road. A tracking code path using the destination radius is a bug, and
  the `dadri` fixture exists to catch exactly that. Never widen either to pass a test.
- **Semantic gates live in `fixtures/`, split into `routing.ts` and `search.ts`.** See that
  folder's `CLAUDE.md`. Do not add a landmark list back into this file.
- **`TRACKING.nominalFixHz` is UI copy, not a timing assumption.** Measured under 4x CPU
  throttle, a 100 ms interval fired at 188/315/253/117 ms. Anything that dead-reckons from
  an assumed cadence will pass on a laptop and jitter on a phone.
- **Imports:** this folder imports nothing from `packages/`. Everything else may import it.
  Keeping it dependency-free is what lets the pipeline, engine, server and client all share
  one definition without a cycle.
