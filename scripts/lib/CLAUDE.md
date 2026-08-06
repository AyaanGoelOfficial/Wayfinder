# scripts/lib

- **A BENCHMARK MEASURES THE MACHINE BEFORE IT MEASURES THE CODE, and refuses rather than warns.**
  `machine.ts` times a fixed CPU kernel immediately before `bench` runs and exits non-zero above
  `STABILITY_MAX_SPREAD`. Reason: a benchmark that self-reports contamination and prints a table
  anyway will have that table quoted, because the numbers are the memorable part and the caveat is
  not. The ruled-out causes are listed in that file so the diagnosis is not repeated.
- **INTERLEAVE RUNGS PER QUERY, never one rung at a time.** A sequential schedule attributes machine
  drift to whichever rung was running. Measured: a mode doing strictly MORE work than Dijkstra, with
  an identical settled count, came out 53% faster on one budget and 93% slower on the other in a
  single run whose preflight had passed. Rotate the order by query index too, so no rung
  permanently takes the cache-cold first slot. — shared helpers for the operator scripts

Pure functions used by more than one script in `scripts/`. Nothing here is invoked directly by an
`npm run` target; the scripts one level up are the entry points.

- **This folder exists to stop measures being COPIED between experiments.** Two copies of a
  geometric measure drift, and then `experiment:turns` and `experiment:objective` disagree about
  the same pair for a reason nobody can find. A helper moves here the moment a second script needs
  it, never a second copy.
- **No IO, no network, no `data/` reads.** The scripts own their inputs; these transform them. That
  keeps a helper testable and keeps the network egress in one visible place per script.
- **Imports:** `config/`, `packages/shared/`. Never `packages/pipeline/` or `packages/engine/`: a
  helper that needs a loaded graph is doing the script's job and belongs in the script.
