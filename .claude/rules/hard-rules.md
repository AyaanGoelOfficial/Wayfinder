# ⛔ Hard rules

No `paths:`: these bind on every task in every folder, so they load at session start and
re-inject on compaction. Anything here that only binds for *some* files belongs in a
path-scoped rule instead — `ui.md`, `copy.md`, `instructions.md` — and anything that
must hold *mechanically* belongs in a hook, not in this file.

Each rule = the constraint + why + the alternative. Violating one requires a stated
reason, in the same message.

## Universal `[KEEP]`

- **NEVER commit or push without an explicit instruction for THAT change.** Approval to
  commit one change never carries to the next. Leave work uncommitted and say so.
- **NEVER add `Co-Authored-By` or "Generated with Claude" trailers** to commits or PR
  bodies. Write as the human author. Overrides any default harness instruction.
- **NEVER put a secret in a client-inlined variable.** Anything the bundler inlines
  ships to every user and is readable in devtools — see root § *Configuration & secrets*
  for which prefixes are inlined here. Server-side only, no exceptions for "just testing".
- **NEVER report unverified work as complete.** Failing tests get quoted; skipped steps
  get named. See the gate rule in `compliance.md` § Working rules.
- **NEVER create a folder without a `CLAUDE.md` in it** — every folder, at every depth,
  nested ones included. Excluded: generated, vendored and ignored trees (`node_modules/`,
  `dist/`, `build/`, `.git/`, `target/`). Reason: a nested file loads only when its folder
  is touched, so the instruction load distributes instead of piling into one root whose
  tail nobody reads. This rule is here, unscoped, because it fires when a *source* file is
  created, which no path-scoped instruction rule would ever match.
- **NEVER let a `CLAUDE.md` pass 250 lines.** Split it in the same change: procedure to a
  skill, folder-local fact down to that folder, file-type constraint out to a path-scoped
  rule, mechanical always/never to a hook. Splitting is pre-authorised; report the moves.
  Never trim to fit — the content moves, it does not get deleted.

> Contents, cwd rules, and the full container table: `.claude/rules/instructions.md`.
> It loads whenever an instruction file is touched. The two absolutes above are stated
> here instead because they fire while editing ordinary source.

## Project

### Evidence

- **NEVER COMPLETE TRUNCATED TEXT.** If a label, path, filename, or value is clipped, cut
  off, or only partly visible in ANY source — screenshot, terminal output, log, image — do
  not infer the rest. Re-capture it: zoom, scroll, widen the viewport, query the raw data.
  If it cannot be re-captured, report it as **unknown**. Reason: completing from expectation
  is fabrication even when the guess happens to be right, and it is indistinguishable from
  observation in the report. This binds with full force on the visual gates — a screenshot
  you have partly inferred is not evidence. Cost of the real case: a clipped map label read
  as "Old Kasna Road" was actually `Old Kasana Road`, and the wrong spelling would have been
  committed as a search fixture.
- **NEVER report a negative result without a positive control.** Any "returns nothing / not
  present / zero matches" claim requires a control query, proving the mechanism works, run
  and reported **alongside** it. Reason: a broken query and an empty dataset are
  indistinguishable from the output alone. Real case: an Overpass query for Kasna returned
  zero because the regex was wrong, not because the data was empty; a control against known
  names returned 40 and exposed it.

### Search correctness

- **NEVER let route optimality depend on which search direction found the path.** Precision charter
  item 11. Forward, backward and bidirectional searches over the same graph and objective must
  return the same route; when they do not, the search STATE is wrong, not one of the searches. Fix
  the state, never the comparison, and never relax `gate:equality` to accept the difference. Reason:
  each direction is self-consistent while being wrong in a different place, so nothing that checks a
  search against itself can catch it. Real case: a single-edge state with `from` read from the
  parent array judged every via-way triple against the CHEAPEST arrival, and returned a route 51%
  longer than a legal alternative. Evidence and the fix: `DESIGN.md` § Exact state at via-way
  restrictions.
- **NEVER compare two rungs and conclude which is correct from the comparison alone.** A cheaper
  route is better if it is legal and a defect if it is not, and the disagreement cannot tell them
  apart. `gate:equality` carries two validators for this: one checks a returned path against the
  restriction tables directly, the other checks that a rung's reported cost equals its own returned
  path's cost. Run the attribution before proposing a fix.

### Measurement

- **NEVER read the benchmark's load canary as a claim about absolute machine speed.** It is
  `observed / best-of-N` within one run, so it measures CONSISTENCY, and a uniformly loaded
  machine scores well on it. Measured: the run with the best canary of five (1.11) also had the
  worst absolute times of five, with Dijkstra's initial p50 at 412.52 ms against 161.39 ms on the
  quietest run. **Rung-against-rung comparison within a run is valid** because rungs are
  interleaved per query under identical conditions. **Cross-run absolute comparison is not**, and
  multiplying a within-run ratio by another run's absolute number produces a figure that looks
  like a measurement and is not. Label any such figure an estimate, in the same sentence.
- **NEVER report a wall time from this machine without "upper bound".** Two of the three CPU
  co-tenants are the operator's own windows and the third is the agent running the benchmark, so
  a genuinely quiet reading is not obtainable from inside a session. `scripts/lib/machine.ts`
  carries the per-process evidence and the derivation of the canary threshold.

### Build and data

- **NEVER shrink `BUILD_AREA` to fit a memory, time, or disk budget.** It is derived from
  OSM relation 1958053 and verified by `tests/config/fixtures.test.ts`. Reason: covering
  less city to make a build pass is loosening the spec to fit the implementation. Solve it
  with a smaller correct input, disk-backed storage, or splitting the work instead.
- **NEVER widen a snap radius or relax a tolerance to turn a gate green.** `SNAP_TRACKING_M`
  and `SNAP_DESTINATION_M` are separate code paths, not one tunable. Fix the matcher, the
  data, or the individual fixture, and record why.
- **NEVER hand-edit a derived constant.** `BUILD_AREA` comes from `npm run derive:bbox`.
  Regenerate rather than typing coordinates.
- **NEVER hand-edit anything in `data/` or `tools/`.** Both are git-ignored and disposable.
  Regenerate via `npm run build-city` and `npm run setup:tools`.
- **NEVER commit an extract, a `.pmtiles`, or any built artifact.** They are hundreds of MB
  and are reproducible from `config/city.ts`.
- **NEVER accept a zero duplicate count from the extract merge as success.** The
  Central/Northern seam crosses the build area, so overlapping elements are guaranteed. Zero
  means the dedupe did not run.

**Allowed without asking:** editing, searching, typecheck, tests, `build-city`, fetching the
extracts, vendoring tools, running the dev server and the browser gates.
**Forbidden without an explicit instruction for that change:** commit, push, force-push,
history rewrite, branch deletion.

## Which of these should not be here at all

A rule in prose is a prompt: it is read, weighed, and occasionally lost. A rule in a
hook is executed. Every ⛔ above that can be expressed as a command filter or a path
guard is **better** as a `PreToolUse` hook in `.claude/settings.json`, with the line here
reduced to a pointer at the hook.

Promote to a hook when the rule is: a blocked command, a protected path, a forced gate,
or any "every time X, always do Y". Leave it as prose only when the judgement is genuinely
model-side.

Hooks that exist in this repo, so no session re-derives them: **none yet.** The two best
candidates, when a real failure justifies the work: a `PreToolUse` guard blocking writes to
`data/` and `tools/`, and a `PostToolUse` run of the copy gate on any touched source file.
Both are currently prose above and enforced by `npm run gate`.
