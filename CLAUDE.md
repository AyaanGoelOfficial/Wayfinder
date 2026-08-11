# CLAUDE.md

Operating rules for Claude Code in this repo. **These OVERRIDE harness defaults and
training priors.** Not advice, not preferences — constraints.

**This file is an index, not a manual.** It holds the facts that must be true for every
task in every folder. Constraints live in `.claude/rules/`, procedures live in
`.claude/skills/`, mechanical enforcement lives in hooks, and folder-local knowledge
lives in that folder's own `CLAUDE.md`. The rules for that split, including the
250-line cap and the one-per-folder requirement, are in `.claude/rules/instructions.md`.

| Where | Loads | Holds |
|---|---|---|
| `CLAUDE.md` (this file) | Session start, always | Project facts, conventions, this index |
| `.claude/rules/compliance.md` | Session start, always | How every rule gets obeyed: Say NO, precedence, the ritual, gates |
| `.claude/rules/hard-rules.md` | Session start, always | ⛔ Universal and project-wide absolutes |
| `.claude/rules/copy.md` | Touching source that carries user-visible strings | Punctuation ban and copy constraints |
| `.claude/rules/ui.md` | Touching a stylesheet, component, or template | ⛔ UI rules, pre-ship checklist, failure catalogue, the standard |
| `.claude/rules/instructions.md` | Touching any `CLAUDE.md`, rule, skill, or hook | Which container an instruction belongs in, the cap, cwd, maintenance |
| `.claude/skills/add-feature/` | On invoke | The ordered touchpoint procedure |
| `.claude/skills/ui-rationale/` | On invoke | Why the UI numbers hold. The measured evidence base |
| `.claude/settings.json` | Executed, never in context | Hooks. NOT CREATED YET: no hook exists |
| `<folder>/CLAUDE.md` | When a file in that folder is read | That folder's job, invariants, gotchas |

**Intended cwd:** the repo root. This matters: a `CLAUDE.md` loads automatically only if it
sits **at or above** cwd, or below cwd in a folder that gets read. This repo has exactly one
root, the repo root. `packages/client` grows its own toolchain but is not opened as a
separate session; if that ever changes it needs `.claude/` re-pointed at it.

> ⛔ **Behavioural and absolute rules are not repeated here.** `compliance.md` and
> `hard-rules.md` are unscoped: they are already loaded, every session, and they bind
> whether or not this file mentions them. That includes two that fire while editing
> ordinary source: **every folder needs a `CLAUDE.md`**, and **no `CLAUDE.md` passes 250
> lines**.

---
---

## What this is

A complete navigation system for one city, Greater Noida, built from raw OpenStreetMap data
with **zero external services, zero paid APIs, zero Docker, and no routing, graph or
geocoding libraries**. Our own routing engine, our own vector tiles, our own places search,
and live GPS navigation: snapped blue dot, chase camera, instant re-routing.

The governing principle is **one source, three derivatives**. Two clipped OSM extracts are
merged once, and that single merged stream produces the routing graph, the vector tiles, and
the places index. All three are built by our own code from identical bytes, which is the
only reason the route line and the drawn road can never disagree.

Priorities, strictly ordered: **accuracy and precision** first (a route that is legal and
near-optimal, a line exactly on the drawn road, a dot that rides the carriageway like it is
on rails), then **execution quality**, then **clean UI**. Sloppiness anywhere is a bug, not
a polish item. The banned defects are enumerated as the precision charter in `DESIGN.md`, items 1
to 10 verbatim from the spec plus item 11 added at gate 5. They had been cited by number in eight
folder files while living only outside the repo; folder rules referencing `charter item N` now
resolve.

---

## Commands

```bash
npm run setup:tools      # vendor tilemaker v2.4.0 into tools/ (git-ignored). v3.x does not run here
npm run fetch:extracts   # download both zone extracts + verify live md5 -> data/
npm run derive:bbox      # NOT BUILT. See Conventions: the guard is a test, not this command
npm run build-city       # extracts -> graph + places + tiles. Does NOT re-download
npm run serve            # Fastify. Fails loudly if artifacts are missing
npm run dev              # client dev server (HTTPS, for real GPS on a phone)
```

**Correctness gate** — run before calling anything done:

```bash
npm run typecheck        # tsc --noEmit. Does NOT run tests
npm test                 # vitest run
npm run gate:copy        # em dash / en dash / interpunct scan of user-facing strings
npm run gate             # all three
```

Cross-checks that need the built artifacts, so they are NOT part of `npm run gate`:

```bash
npm run gate:fixtures    # frozen routing + search fixtures, held-out queries, restriction enforcement
npm run gate:equality    # every rung vs Dijkstra through EVERY restriction site. Path and cost, 1e-6
npm run gate:oracle      # places index vs pyosmium. ~6 min, cached on the extract md5s
npm run gate:oracle -- --full   # ALSO re-derives the clip from raw extracts. 993 s, has passed
npm run profile:route    # settled/relaxed counts beside wall time, for the gate 5 ladder
```

Measurement and acceptance:

```bash
npm run validate         # 6 landmark + 50 random pairs vs OSRM. Median <3%, p95 <7%
npm run diagnose:route   # WHY a pair diverges, grouped by cause -> DIVERGENCE.md. Add --all
npm run calibrate:speeds # tagged maxspeed per class vs our defaults. Read the sample counts
npm run calibrate:quality # surface/smoothness/lanes coverage per class. Controls printed first
npm run diagnose:flattening # class ratio, slow-road share, and the straight-line-excess proof
npm run experiment:speeds # A/B a speed table over the same 56 pairs. No rebuild needed
npm run experiment:turns  # A/B the turn cost model. Reports SHAPE overlap, not just the delta
npm run experiment:objective # distance and toll preferences. Route sanity BEFORE divergence
npm run bench            # p50/p95/p99 for route, snap, search -> BENCHMARKS.md
npm run verify:browser   # NOT BUILT until gate 8. Console, visual, network, GPS, throttled
npm run acceptance       # NOT BUILT until gate 9. One pass/fail table, every charter item
```

**There is no lint step.** TypeScript strict plus the copy gate is the whole static check;
do not claim a lint gate ran. `build-city` does **not** hot-reload: the server memory-loads
artifacts at boot, so any rebuild needs a full server restart.

---
---

## Adding a feature

The ordered touchpoint checklist is the `add-feature` skill
(`.claude/skills/add-feature/SKILL.md`). It is a procedure, so it loads on invoke rather
than every session. **Invoke it before starting one.**

---

## Architecture — a build pipeline, a pure engine, and a thin client

Five units. Depth lives in each folder's own `CLAUDE.md`, not here.

- **`config/`** — the ONLY place the target city is defined. No hand-picked coordinates.
- **`packages/shared/`** — **THE CONTRACT**. Every type crossing server/client.
- **`packages/pipeline/`** — extracts to artifacts. Owns the native binaries and all IO.
- **`packages/engine/`** — routing, snapping, instructions. Pure, no IO, toy-graph testable.
- **`packages/server/`** — Fastify. Memory-loads artifacts, serves API and `.pmtiles`.
- **`packages/client/`** — Vite + React + MapLibre. Treated as untrusted, API access only.

### Capability matrix
| Capability | pipeline | engine | server | client |
|---|:--:|:--:|:--:|:--:|
| Filesystem / native binaries | ✅ | ❌ | read-only | ❌ |
| Network egress | ✅ | ❌ | ❌ | ❌ |
| Holds the loaded graph | ✅ | given it | ✅ | ❌ |
| Reaches the other side | via artifacts | never | via HTTP | via HTTP |

### Trust boundary (enforced in `packages/server/`)
- The client is untrusted input. Every parameter is validated before the engine is touched.
- No auth: this is a single-user local system with no accounts and no user data.
- Out-of-area coordinates return `OUTSIDE_BUILD_AREA`; unsnappable points return
  `POINT_TOO_FAR_FROM_ROAD` with the measured distance and a remedy. Never a stack trace.

---

## The contract

`packages/shared/index.ts` holds the route table, request and response shapes, the
`ErrorCode` union, and `BuildReport`. **Adding a capability means editing THIS file**, not
reaching across the boundary with an inline shape or a raw string path.

Patterns in use:
- **Typed response envelope** — every response carries `timingMs` per phase, never a total.
- **Monotonic response id** — `/route` answers carry an increasing `id`; the client discards
  anything that is not the latest and aborts superseded requests in flight.
- **Structured error with remedy** — `ErrorCode` plus a user-facing message that says what
  to do, governed by `rules/copy.md`.

> Exceptions NOT in the contract: the static `.pmtiles` path and the MapLibre style JSON URL
> are plain static routes, not typed endpoints. Nothing else may bypass `shared/`.

---

## Domain subsystems

One line each; invariants live in the folder.

- **`config/`** — city definition, derived build area, frozen fixtures.
- **`config/fixtures/`** — `routing.ts` (graph coverage) and `search.ts` (name resolution).
- **`packages/pipeline/`** — streaming decode, merge, clip, graph, places, tiles.
- **`packages/engine/`** — heap, Dijkstra ladder, spatial index, instructions.
- **`packages/server/`** — API, range-request tile serving, artifact loading.
- **`packages/client/`** — map, search, route rendering, tracking, camera.
- **`scripts/`** — operator one-shots. The only code allowed network egress.
- **`tests/`** — cross-package suites. Unit tests sit beside their code.

---

## Conventions & gotchas (read before shipping)

- **`LngLat` is `[lon, lat]`, GeoJSON order, everywhere.** Most APIs and all human speech
  say lat/lon. The swap is silent, plausible, and puts the city in the Indian Ocean.
- **Windows default text encoding mangles Devanagari.** Many local names need it. Every file
  read and write states UTF-8 explicitly. This has already bitten once, parsing OSM names.
- **Timers are unreliable exactly when it matters.** Under 4x CPU throttle a requested 100 ms
  interval fired at 188, 315, 253, 117 ms. Never dead-reckon from an assumed cadence; always
  use fix `timestamp` deltas.
- **The two extracts overlap on purpose.** Geofabrik cuts zones with complete ways, so the
  Central/Northern seam duplicates elements. Dedupe by OSM element id, first-write-wins, and
  **a zero duplicate count in the build report is a bug, not a clean run.**
- **Never shrink `BUILD_AREA` to fit a budget.** It is derived from OSM relation 1958053 and
  verified by test. Memory and time problems get solved by smaller correct inputs, disk-backed
  storage, or splitting; never by quietly covering less city.
- **Never widen a snap radius to make a test pass.** `SNAP_TRACKING_M` (40) and
  `SNAP_DESTINATION_M` (500) are different code paths, and crossing them is a bug.
- **tilemaker is pinned to v2.4.0, NOT the newest release, and an existing release asset is not
  evidence that the binary runs.** Both halves of the evidence are already recorded where they
  bind: the crash and the pinning rule in `scripts/CLAUDE.md`, the tile-directory consequence in
  `packages/pipeline/tiles/CLAUDE.md`.
- **Duplicated state to change together:** a new `ErrorCode` touches `shared/index.ts`, the
  server handler that raises it, and the client state that renders its remedy.
- `data/`, `tools/`, `dist/` and `node_modules/` are git-ignored and disposable.

**Record durable lessons here.** When trial-and-error yields a reusable gotcha, add a
one-line bullet with its root cause. Convention-grade only. Folder-local lessons go in that
folder's file; UI-shaped ones in `.claude/rules/ui.md`; absolutes in `hard-rules.md`.

---

## Configuration & secrets

**There are no secrets in this project, and that is a design constraint, not an accident.**
No accounts, no paid APIs, no API keys, no user data. Nothing here needs a `.env` to run.

If that ever changes: Vite inlines every `VITE_`-prefixed variable into the shipped browser
bundle, where it is readable in devtools. Server-only values must never carry that prefix.
The absolute is in `hard-rules.md` § Universal.

A fresh clone runs: `npm install`, `npm run setup:tools`, `npm run fetch:extracts`,
`npm run build-city`. Extract URLs and checksum policy live in `config/city.ts`.

---
---

## Known weaknesses / not-yet-done

**Moved to `PROGRESS.md`** when this file reached the 250-line cap in `hard-rules.md`. Nothing was
deleted. That file holds gate status and every measured weakness: places index state and its
oracle, routing latency against the gate 5 budget, the missing U-turn penalty, speed estimates,
sparse turn restrictions, and the Indic shaping limit.

---

## Quick reference

- **Ports** — server 8080, client dev 5173 (HTTPS via mkcert, needed for real GPS).
- **Build area** — lat 28.058161..28.679899, lon 77.262262..77.768478. 69.2 x 49.6 km.
  Derived from OSM relation 1958053 (Gautam Buddha Nagar, admin_level 5).
- **Extracts** — Geofabrik `asia/india/central-zone` and `asia/india/northern-zone`. Both
  are required; central alone fails the coverage gate.
- **Paths actually touched** — `config/city.ts`, `config/fixtures/*.ts`,
  `packages/shared/index.ts`, `packages/pipeline/`, `packages/engine/`, `scripts/`.
- **tilemaker** — `tools/build/RelWithDebInfo/tilemaker.exe` on Windows, after `setup:tools`.
- **Env vars** — none. See Configuration above.

> Do **not** record anything that rots faster than this file gets updated — line numbers,
> dependency versions, generated file listings. Record the regenerating command instead.
