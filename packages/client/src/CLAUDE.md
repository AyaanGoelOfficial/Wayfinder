# packages/client/src — the app shell

React + MapLibre, talking to the server over HTTP only. Treated as untrusted by the server, and
it never holds the graph.

- **The client may NEVER import `engine/` or `pipeline/` runtime code.** It talks to the server
  over the surface named in `shared/`. The engine loads hundreds of MB of typed arrays and the
  pipeline shells out to native binaries; either one reaching the browser bundle is a build that
  works locally and dies on a phone. The one exception is TYPES, which erase at compile time.
- **The style is FETCHED from the server, never rebuilt here.** It is a derivative of the tile
  schema, which the pipeline owns. A second copy means a renamed layer silently yields a blank
  map that nothing reports as broken.
- **`ui.md` binds on every file here.** rem type only, at most 5 sizes and 3 weights, one
  saturated accent, four states on every interactive element, `prefers-reduced-motion` honoured,
  no horizontal scroll at 320px. The pre-ship checklist is not optional before calling UI done.
- **Never set a `px` font size.** It ignores the reader's browser text setting, which on a phone
  in daylight is not decoration. Map label sizes inside the MapLibre style are exempt: they are
  canvas-rendered and have no rem equivalent.
- **`NEVER` put a secret in a `VITE_`-prefixed variable.** Vite inlines those into the shipped
  bundle where devtools can read them. This project has no secrets by design, so the correct
  action if one ever appears is to move it server side, not to obscure it.
- **`LngLat` is `[lon, lat]` everywhere**, GeoJSON order, matching `shared/`. MapLibre agrees;
  human speech does not. The swap is silent and puts the city in the Indian Ocean.
- **Callbacks passed into effect dependencies must be `useCallback`-stable.** A fresh closure per
  render tears the map down and rebuilds it on every state update, which reads as flicker rather
  than as a bug.
