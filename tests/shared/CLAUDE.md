# tests/shared — the contract's own logic, and the tracking engine

`packages/shared/` holds three things that are more than types: `geo.ts`, `toll.ts` and
`tracking.ts`. They are tested here because both sides of the boundary depend on them, so a
regression is a regression everywhere at once.

- **The tracking engine is tested with NO BROWSER AND NO GRAPH.** That is the whole reason it
  lives in `shared/` rather than `engine/`. Time enters as fix timestamps and as an explicit
  `nowMs` argument, so a trace runs deterministically with no timers. A test here that needs
  `Date.now()`, a fake clock library, or a DOM has found a design defect, not a testing problem.
- **NEVER DEAD-RECKON A CADENCE IN A FIXTURE.** Synthetic traces carry explicit timestamps, and
  the intervals between them should be UNEVEN on purpose. Measured under 4x CPU throttle, a
  requested 100 ms interval fired at 188, 315, 253 and 117 ms; a fixture that steps exactly
  1000 ms passes while hiding the exact assumption the real device breaks.
- **EVERY WRONG-SIDE TEST NEEDS THE OPPOSING CARRIAGEWAY PRESENT.** Asserting that a fix matched
  the correct road is worthless if the wrong road was never in the fixture. Build both
  carriageways, put the fix nearer the wrong one, and require the right one anyway. That is the
  only shape that can fail.
- **A no-teleport assertion must have something to teleport from.** Bounding the display step
  across a trace that never jumps proves nothing. Inject the discontinuity, then assert the
  bound holds.
- **Assert the refusal, not just the answer.** `matchToRoute` returning null when nothing
  survives the heading gate is a designed outcome. A test that only ever checks the happy path
  cannot tell a working gate from an absent one.
- **Imports:** `packages/shared/`, `config/`. Never `engine/`, never `data/`, never the network.
