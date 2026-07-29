# packages/client — Vite + React + MapLibre. The map IS the interface

`rules/ui.md` binds on everything that renders here, and `rules/copy.md` on every string.
Run the pre-ship checklist in `ui.md` before calling any UI change done.

- **ZERO business logic in components.** All state in the Zustand store, MapLibre behind a
  thin adapter. A later visual overhaul must be possible without touching the engine or the
  store, and that is only true if components render state and dispatch intent, nothing else.
- **NEVER import `engine/` or `pipeline/`.** Only `config/` and `shared/`. The engine holds
  hundreds of MB of typed arrays and the pipeline shells out to native binaries; either one
  in a browser bundle works on this laptop and dies on a phone.
- **The display dot is an ANIMATED ENTITY, not the raw fix.** It interpolates along matched
  geometry between fixes and eases toward each correction. It must never teleport or jitter.
  Charter item 4.
- **NEVER dead-reckon from an assumed 1 Hz cadence.** Measured under 4x CPU throttle, a
  requested 100 ms interval fired at 188, 315, 253 and 117 ms. Always use fix `timestamp`
  deltas. Code that assumes cadence passes on a laptop and jitters on the real target device,
  which is the hardest place to notice it.
- **`maplibre-gl` is at 6.0.0, a recent major.** Pin it and read its style spec rather than
  assuming v5 behaviour.
- **The camera is locked to the build area** via `maxBounds` plus a minimum zoom. The tile
  void must be unreachable. Charter item 9.
- **The only overlay beyond the route is the user dot.** No debug visualisations flooding the
  city, ever, not even behind a flag that might ship enabled.
- **Every failure state has designed UI with a stated remedy**: GPS denied, GPS poor,
  off-network, unsnappable point. Charter item 10.
- **Imports:** `config/`, `shared/`. Nothing else from `packages/`.
