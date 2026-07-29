# packages/pipeline — one source, three derivatives

`npm run build-city` reads the merged extracts once and emits the routing graph, the places
index, and the vector tiles. All three come from the identical bytes, which is the only
reason the route line and the drawn road can never disagree.

- **NEVER load a whole extract into memory.** Input is 546 MB across two files on a 7.7 GB
  machine. Decode is streaming, and the clip to `BUILD_AREA` happens during the stream.
- **DEDUPE BY OSM ELEMENT ID ON INGEST, first-write-wins.** Geofabrik cuts zones with
  complete ways, so every element near the Central/Northern seam appears in BOTH files.
  Without dedupe the seam gets doubled edges, doubled labels, and doubled place entries.
  The build report must publish duplicate node/way/relation counts, and **a count of zero
  is a bug, not a clean run**: the seam is real and crosses the western edge of the area.
- **The coverage gate is strict and has no threshold.** `BUILD_AREA` must be fully inside
  the union of the extract `.poly` files. Hard fail. No percentage, no warn-and-proceed: in
  an autonomous run a warning is the same as no check.
- **Never shrink `BUILD_AREA` to fit a memory or time budget.** That is loosening the spec
  to make a build pass. Order of attack when tilemaker is the constraint: smallest correct
  input first (clip the merged extract upstream), then disk-backed store, then split and
  merge by tile range. Measure, record what was tried, decide from evidence.
- **Legality lives in the graph, not the search.** One-ways (including `oneway=-1` and the
  implied ones on roundabouts and motorway links), `access`/`motor_vehicle`, the per-profile
  highway whitelist, and turn restrictions are applied while building. If the graph is right
  no computed route can be illegal, which is charter item 7 made structural.
- **Speeds come from one documented table.** `maxspeed` when tagged, else the India-tuned
  class defaults. One place in the code, never inlined at a call site.
- **Keep only the largest SCC per profile**, so no snappable point can be stranded.
- **Intermediate shape points are NOT vertices.** Vertices exist only at way endpoints and
  intersections; the shape lives in packed edge geometry. This is what makes charter item 1
  structural rather than something to remember.
- **Imports:** `config/`, `shared/`, Node built-ins, and `tools/` via `scripts/setup-tools`.
  Never `engine/`, never `client/`.
