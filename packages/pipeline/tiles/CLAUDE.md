# packages/pipeline/tiles — vector tiles from the same bytes as the graph

Drives tilemaker over `data/clipped.osm.pbf`, the deduped BUILD_AREA subset our own PBF writer
emits, and produces `data/wayfinder-gn.pmtiles`.

- **TILEMAKER READS THE CLIPPED PBF, NEVER THE RAW EXTRACTS.** Pointing it at the two extracts
  would be wrong three ways at once: it would process 91.5M nodes to draw a district of 2M, it
  would re-introduce the Central/Northern seam the clip just removed so every element along the
  western edge is drawn twice and every label doubled, and it would mean the tiles came from
  different bytes than the graph. That last one breaks the governing principle: one source,
  three derivatives. Feeding a pre-deduped single file makes doubled seam labels
  **structurally impossible** rather than something to inspect the output for.
- **The bundled OpenMapTiles profile is deliberately NOT used.** It sources ocean polygons,
  Natural Earth urban areas, glaciers and ice shelves from external shapefiles: downloads this
  project does not have and does not want, three of which are meaningless for an inland district
  in the Indian plains. `process.lua` here is written from scratch.
- **`bounding_box` is GENERATED from `BUILD_AREA`, never typed.** A hand-typed bbox here is a
  second, drifting definition of the city, and `config/` is the only place the city is defined.
- **Layer and attribute names are a three-way contract:** `process.lua`, `schema.ts`, and the
  hand-written MapLibre style. Renaming one without the others yields an empty map with no error.
- **Never simplify roads at high zoom.** `simplify_below: 13` exists so z13 to z15 geometry is
  untouched. Simplifying there is exactly what makes the route line and the drawn road visibly
  disagree, which is charter item 1.
- **Keep the local-script name AND the Latin one.** Many names here are Devanagari. A style that
  can only render Latin still needs something to draw, but dropping the original is a data loss
  that cannot be recovered at render time.
- **tilemaker is pinned to v2.4.0, and it writes a DIRECTORY of tiles, not a `.pmtiles`.**
  v3.1.0 publishes zero release assets; v3.0.0's Windows binary crashes with `0xC0000409`
  before reading any input, on any input, with any config, under any flags. v2.4.0 runs but
  predates PMTiles, so `pmtiles.ts` packs the archive from the tile tree. That also means v2's
  METHOD-style Lua API (`way:Find`) applies, not v3's globals (`Find`).
- **The PMTiles writer uses `zxyToTileId` from the `pmtiles` package, not its own Hilbert
  code.** That is the exact function the client's reader uses to locate a tile; an independent
  implementation that differs by one curve orientation yields an archive which looks valid and
  serves the wrong tile for every request.
- **Peak RSS is read from the OS, not estimated.** tilemaker is a native process, so
  `process.memoryUsage()` in Node says nothing about it. Windows keeps a monotonic
  `PeakWorkingSet64` per process, polled while it runs.
- **`tilemakerSeconds` IN THE BUILD REPORT IS WALL TIME AND IS CONTAMINATED BY ANYTHING ELSE ON
  THE MACHINE.** Measured in isolation on this input, tilemaker takes about **18 seconds** for all
  4,098 tiles: 18.4 s writing to `%TEMP%` and 17.96 s writing into `data/`, so the output location
  makes no difference and OneDrive is NOT the variable. One recorded build reported **2,425.4 s**
  for byte-identical output, 132x the isolated cost. That was a contaminated measurement, not a
  regression, and the contaminating factor was never identified. Never quote a build-report wall
  time as tilemaker's cost without saying what else was running; re-measure alone if the number
  matters.
- **If memory binds, the order is fixed and does not include shrinking `BUILD_AREA`:** smallest
  correct input first (already done, tilemaker sees ~2M nodes not 91.5M), then `--store` on disk
  (already on), then `--shard-stores`. Shrinking the area to make a build pass is loosening the
  spec to fit the implementation.
- **Imports:** `config/`, `../clip/`, Node built-ins, and `tools/` via the vendored binary.
