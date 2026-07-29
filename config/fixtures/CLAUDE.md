# config/fixtures — frozen ground truth the gates assert against

Two files, split by what they test. Do not merge them: a routing fixture may sit on a
highway in open country where nobody would search, and a search fixture may resolve
nowhere near a road. `jewar` is both, at two different coordinates, for exactly this reason.

- **`routing.ts`** — graph coverage. Snapping, legality, SCC connectivity.
- **`search.ts`** — name resolution. What a person types vs what OSM actually holds.

## Rules

- **Fixtures are FROZEN. Never re-resolve them from a live service during a build or a
  test.** A landmark gate failing must tell you something about OUR extract, sweep, or
  graph. A gate that calls Nominatim goes red when Nominatim is down and green when
  Nominatim knows something we do not, which is the opposite of an assertion.
- **Every entry states the class of bug it catches (`covers`) or the reality it encodes
  (`osmReality`).** An entry that cannot say what it would catch does not belong here.
- **`gaur-city` is THE permanent wrong-side test for precision charter item 3.** Do not
  repurpose or move it. If that site is ever remapped as a single way instead of a divided
  pair, the fixture silently stops testing anything, so re-verify before trusting it.
  `alpha-1` is the designated backup site.
- **`gautam-buddha-university` is an ACCESS-RULE test, not an exception.** Do not move it
  to the campus gate to make it pass. Snapping it to the gate is the behaviour under test,
  along with never traversing an `access=private` way and never silently failing. Same
  pattern applies to any gated sector.
- **`dadri` is the proof the two snap radii are wired to different code paths.** It must
  pass under `SNAP_DESTINATION_M` and FAIL under `SNAP_TRACKING_M`, and the test asserts
  both. If a tracking call ever accepts it, the radii have been crossed.
- **Search assertions are never exact-string.** The contract is: the top result is the
  right KIND of thing in the right PLACE. Asserting a returned name encodes OSM's spelling
  into our suite and goes red the day a mapper fixes a typo.
- **Never widen a radius to turn a gate green.** Move the individual fixture and record
  why. Widening weakens the assertion for every entry at once.
- **`Kasna` in `search.ts` must not be "fixed" with an alias.** Verified 2026-07-29: zero
  `place=*` features under any spelling in the whole build area. The only matches are
  `Old Kasana Road` and `Kasana Nursing Home`, both spelled KASANA. The absence is real,
  and the fixture is the end-to-end check that fuzzy matching (typed "Kasna", mapped
  "Kasana", one inserted character) and named-road indexing both actually work.
- **Imports:** nothing. This folder is data. It must never import from `packages/`.
