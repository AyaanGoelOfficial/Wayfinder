# tests/config — proves the config is derived, not hand-written

One job: make the claims in `config/` mechanically checkable, so a careless edit goes red
instead of silently changing the build area or weakening a gate.

- **`BUILD_AREA` is recomputed here from `RELATION_BBOX` and `BUFFER_KM`.** That test is the
  enforcement behind "no hand-picked coordinates". If it fails, someone edited a derived
  constant by hand. Fix the edit, never the tolerance.
- **The fixture assertions check INTENT, not just shape.** They assert that `gaur-city` and
  `gautam-buddha-university` still exist, that `dadri` still names both snap radii, and that
  the `Kasna` query is still spelled as a person types it. Each of those would otherwise be
  easy to delete while "tidying up", taking a whole class of coverage with it.
- **These tests must stay offline and instant.** They run on every `npm test`, need no
  extract, and must never call Overpass, Nominatim or OSRM.
