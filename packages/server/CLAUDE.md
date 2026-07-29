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
- **Imports:** `config/`, `shared/`, `engine/`. Never `pipeline/`, never `client/`.
