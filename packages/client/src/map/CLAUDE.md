# packages/client/src/map — the MapLibre adapter

The only place MapLibre's API is touched. Everything above this folder deals in plain data, so a
MapLibre major bump is contained here.

- **maplibre-gl v6 has NO default export.** `import maplibregl from 'maplibre-gl'` can type-check
  under some configs and is `undefined` at runtime. Use named imports.
- **`addProtocol` is GLOBAL MapLibre state and must be registered exactly once per page.**
  React strict mode runs effects twice in development, so an unguarded registration throws on the
  second pass and the map never appears. Guarded by a module-level flag.
- **The PMTiles source URL is made absolute here.** The server emits a root-relative path so the
  style stays origin agnostic, but the protocol handler passes its URL to `fetch`, where a
  root-relative path resolves against the document base. The origin is only known at runtime.
- **`map.on('error')` must always be wired to visible UI.** MapLibre reports tile fetch failures
  there and nowhere else. Swallowing it makes a failed archive look like an empty region of the
  city, which is indistinguishable from correct behaviour over water or farmland.
- **Never cap `maxZoom` at the deepest built tile zoom.** Tiles stop at z15 and MapLibre overzooms
  for free. Capping there stops a driver zooming into a junction, which is when they need it most.
- **Style layer and attribute names are a three-way contract** with `pipeline/tiles/process.lua`
  and `pipeline/tiles/schema.ts`. Renaming one without the others yields a blank map and no error.
- **`moveend` fires on the initial hash jump, not only on user panning.** So a status channel
  shared between the map readout and anything asynchronous is a race: the route summary and the
  zoom readout took turns depending on whether the route fetch beat the first `moveend`, and a
  verification screenshot could capture either. One channel per source of truth, and a route
  failure reports on the route channel so its heading names what actually failed.
- **`resize_page` in the browser gates floors at about 502 CSS px.** The 320 px checklist item
  cannot be checked that way and silently passes. Use viewport emulation
  (`320x640x2,mobile,touch`) and assert `window.innerWidth` really is 320 before believing it.
