# packages/server — Fastify. Loads artifacts, serves the API and the tiles

- **RANGE REQUESTS ARE MANDATORY for the `.pmtiles` file.** PMTiles works by reading byte
  ranges; a handler that returns 200 with the whole file "works" in a browser and ships a
  multi-hundred-MB download per map load. The gate 2 assertion is that tile requests return
  **206**, not 200.
- **Every response carries `timingMs` per phase.** Not a total. A slow route is either snap,
  search or path, and a single number cannot tell you which.
- **Every `/route` response carries a monotonic `id`.** The client discards anything that is
  not the latest, and superseded in-flight requests get aborted. Charter item 6.
- **Errors are structured and state a REMEDY**, using the `ErrorCode` union in `shared/`.
  Never leak a stack trace or a raw exception message to a client.
- **Validate every request parameter before touching the engine.** Out-of-area coordinates
  get `OUTSIDE_BUILD_AREA`, not a snap attempt that wanders.
- **Artifacts are memory-loaded ONCE at boot, never per request**, and the process fails
  loudly at startup with `ARTIFACTS_NOT_BUILT` if they are absent, naming `npm run
  build-city`. A server that starts and then 500s on first use is worse than one that
  refuses to start.
- **`/health` serves the full `BuildReport`**, so a running server can always be traced back
  to the extracts and the relation it was built from.
- **The graph is READ from `data/graph.bin`, never rebuilt here.** The file read lives in this
  package because this is the layer allowed to touch the filesystem; the parser is
  `engine/graphfile.ts` and is pure, so the whole loader is testable from a `Uint8Array`. The
  format is `shared/graphfile.ts`, which both the writer in `pipeline/` and the parser obey.
  This was a real violation for two gates: the server imported `loadOrBuildClip`, `buildGraph`
  and `buildTurnTable` and rebuilt the graph at every boot, costing 3.8 s.
- **The MapLibre style is SERVED from `data/style.json`, never built here.** It is a derivative
  of the tile schema, which `pipeline/` owns. Building it here made a second copy of that schema
  and needed a `pipeline/` import; `build-city` now emits it from the same run as the tiles.
- **SNAP PREFERRING A PUBLIC ROAD, AND FALL BACK.** `/route` snaps with `excludePrivate` first and
  retries without it only when no legal edge is in radius. Without the first call a destination
  inside a gated campus snaps onto the campus road and the route drives in; without the fallback,
  four places in the index become unroutable. The gap the preference opens is not hidden, it becomes
  the `Approach` the client draws dashed.
- **Imports:** `config/`, `shared/`, `engine/`. Never `pipeline/`, never `client/`, and never
  `scripts/`. If the server appears to need something from `pipeline/`, the answer is a new
  artifact written by `build-city`, not an import.
