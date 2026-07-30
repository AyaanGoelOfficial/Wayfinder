# packages/pipeline/places — the third derivative

Turns the clipped subset into a searchable index of everything a person would type and expect
to travel to. Built from the same bytes as the graph and the tiles.

- **NAMED ROADS ARE INDEXED, not just POIs and settlements.** This is not a nice-to-have: in
  Greater Noida people navigate by road and sector name far more than by POI, and the Kasna
  fixture depends on it outright. "Kasna" exists in OSM only as `Old Kasana Road` and
  `Kasana Nursing Home`, so an index of settlements alone returns nothing for a locality people
  use daily. Measured: 1,078 named roads, collapsed from 4,663 OSM ways.
- **ONE ROAD IS ONE PLACE.** OSM splits a road wherever a tag changes, so emitting one hit per
  way floods the result list with near-identical entries and buries everything else. Ways
  sharing a normalised name are clustered by proximity within `ROAD_CLUSTER_RADIUS_M`, so one
  road split into eleven ways becomes one place while two unrelated "Main Road"s stay separate.
- **A way's representative point is the mean of its nodes, which lies ON the road.** A bounding
  box centre sits off the carriageway on any curved road, and the search result is what the map
  flies to.
- **Importance is STRUCTURAL, never popularity.** There is no click data and never will be:
  settlement rank, then POI significance, then road class, stated in one table. Do not add
  per-query tuning; add a rank to the table or change the table.
- **Relation points are coarse and known to be.** A relation's geometry is not assembled here,
  so its point is the mean of whatever member nodes the clip holds. Good enough to place a label
  and rank by distance, never good enough to route to.
- **`normalise` lives in `shared/text.ts` and MUST be the same function the search uses.** If
  the index normalises one way and the query another, affected names become unfindable and
  nothing reports an error: the index looks full and the result list is empty.
- **Devanagari names must survive normalisation.** Stripping all combining marks after NFD
  turns कासना into कसन. The combining-mark strip is scoped to the Latin block on purpose.
  Measured: 26 indexed names carry Devanagari.
- **Imports:** `../clip/`, `../../shared/`. Never `engine/`, never `server/`.
