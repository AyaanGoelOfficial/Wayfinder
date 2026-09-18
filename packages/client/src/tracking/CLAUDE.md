# packages/client/src/tracking — the fix stream and the frame loop

The tracking ENGINE is not here. It lives in `packages/shared/tracking.ts`, because the client
may only import `config/` and `shared/`, and because a matcher that needs a browser to run is a
matcher that cannot be tested. What lives here is everything that is genuinely browser shaped:
where fixes come from, when frames happen, and what reaches React.

- **TWO FIX SOURCES, ONE ENGINE.** `simulator.ts` replays a computed route; `controller.ts`
  wraps `watchPosition` (there is no separate `geolocation.ts`). Neither may contain matching, smoothing or progress logic. If a
  behaviour differs between simulated and real driving, that is a bug in the source, not a
  reason to branch inside the engine.
- **THE FRAME LOOP MUST NOT RE-RENDER REACT AT 60 fps.** The dot and the camera are driven
  imperatively into MapLibre from the rAF callback; only coarse state (phase, quality,
  instruction index, rounded distance and ETA) is pushed into the store, and only when it
  actually changes. A store write per frame turns the whole rail into a 60 Hz render and is how
  the throttled performance target gets missed.
- **NEVER DEAD-RECKON FROM A CADENCE.** rAF is not 16.7 ms and `setInterval` is not its argument.
  Measured under 4x CPU throttle, a requested 100 ms interval fired at 188, 315, 253 and 117 ms.
  Every advance passes real elapsed time to `TrackingEngine.frame`, and every fix carries its own
  `timestamp`.
- **A DROPPED FIX IS NOT A REPEATED FIX.** The simulator returns null for a dropout and the
  device source simply goes quiet. Neither may resend the last position: that draws a confident
  stationary dot on data we do not have, which is charter item 10.
- **The simulator is SEEDED.** Same seed, same trace, so a changed screenshot means changed
  behaviour rather than changed dice.
- **Imports:** `config/`, `shared/`, and the store. Never `engine/`, never `pipeline/`.
