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
- **Imports:** `config/` only. Never a package, never Node built-ins, never the DOM. This
  file is bundled into the browser.
