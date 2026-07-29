---
name: add-feature
description: The ordered touchpoint checklist for adding a feature, tool, endpoint, or model to this repo - every file that must change, in order, including the ones that are hand-written and do not infer from anything else. Invoke before starting any new feature, endpoint, tool, command, or model so no touchpoint is missed. [FILL - rename this skill to match what this repo actually adds, e.g. add-endpoint or add-tool]
---

# Adding a <feature/tool/endpoint/model> — the N touchpoints `[FILL]`

This is the highest-value content in the instruction set: it turns "figure out the
codebase" into "follow the list". It lives as a skill rather than in `CLAUDE.md` because
it is a procedure, and procedures load when invoked instead of costing every session.

Work the list in order. Do not skip a step because it looks inferable — the ones marked
below are exactly the ones that are not.

1. `<file>` — <what to add>
2. `<file>` — <what to add>  ← **hand-written, does NOT infer from <other file>**
3. `<file>` — <what to add>; **start the handler with `<required guard>`**
4. `<file>` — register it in `<function>`
5. `<file>` — <UI/route/registry wiring: all the places, listed>

<Point at a worked example: "README §7 walks <feature> through all N.">

## Before finishing

- Root `CLAUDE.md` § The contract: a new capability means editing the contract file, not
  reaching across the boundary. Add the channel/route/schema entry there.
- The folder's own `CLAUDE.md`: if this added an invariant that only holds inside one
  folder, record it there, not in the root.
- Correctness gate, root `CLAUDE.md` § Commands. Quote the output.
- If anything rendered: the pre-ship checklist in `.claude/rules/ui.md`.
