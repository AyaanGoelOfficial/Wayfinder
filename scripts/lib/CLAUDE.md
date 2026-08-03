# scripts/lib — shared helpers for the operator scripts

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
