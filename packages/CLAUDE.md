# packages — the five units and the boundary between them

| Package | Role | May import |
|---|---|---|
| `shared/` | THE CONTRACT. Types crossing server/client | `config/` only |
| `pipeline/` | Builds the three artifacts from the extracts | `config/`, `shared/` |
| `engine/` | Routing, snapping, instructions. Pure, no IO | `config/`, `shared/` |
| `server/` | Fastify. Loads artifacts, serves the API and tiles | all of the above |
| `client/` | Vite + React + MapLibre | `config/`, `shared/` ONLY |

- **The client may NEVER import `engine/` or `pipeline/`.** It talks to the server over the
  API surface named in `shared/`. Reason: the engine loads hundreds of MB of typed arrays
  and the pipeline shells out to native binaries; either one reaching a browser bundle is a
  build that appears to work locally and fails on a phone.
- **`engine/` does no IO.** It receives loaded typed arrays and returns plain data. That is
  what lets the whole routing ladder be tested against toy graphs with no filesystem.
- **Adding a capability means editing `shared/` first.** A route, error code or channel that
  is not named there does not exist. Reaching across the boundary with an inline shape or a
  raw string path is the defect this table exists to prevent.
- **No package imports from `scripts/` or `tools/`.**
