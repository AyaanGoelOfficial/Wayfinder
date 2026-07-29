---
paths:
  - "**/CLAUDE.md"
  - ".claude/**"
  - "**/.claude/**"
---

# Instruction layout `[KEEP]`

Loads whenever an instruction file is touched. Where an instruction lives decides
whether it is loaded when it matters and whether it burns context when it doesn't.
Mechanics below are the harness's, not a preference:
`claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more`.

## ⛔ Which container

Choose by *shape of the instruction*, never by convenience. Putting a procedure in
`CLAUDE.md` is the single most common way an instruction set rots.

| The instruction | Goes in | Why |
|---|---|---|
| A fact held all the time: build commands, layout, conventions, team norms | Root `CLAUDE.md` | Loaded every session, so it must earn it |
| A fact true only inside one folder | `<folder>/CLAUDE.md` | Free until that folder is touched |
| A constraint on a file *type* scattered across the repo | `.claude/rules/*.md` + `paths:` | Loads only on a path match |
| A constraint that binds on every task everywhere | `.claude/rules/*.md`, no `paths:` | Same cost as the root file; priced that way |
| A **procedure**: an ordered checklist, a workflow, a runbook | `.claude/skills/<name>/SKILL.md` | Only name + description load until invoked |
| **"Never do X"** where X is mechanically detectable | `PreToolUse` hook, `.claude/settings.json` | Prose is a prompt; a hook is enforcement |
| **"Every time X, always do Y"** | A hook on the matching lifecycle event | The model choosing to run a formatter is not the formatter running |
| A side task whose intermediate output is noise | `.claude/agents/<name>.md`, called via Agent | Runs in an isolated context; only its final message returns |
| A personal preference, not a team norm | Local settings, not the shared file | Never ship taste to the whole team |

**`CLAUDE.md` is an index, not a manual.** Its job is to state the facts that must be
held always, and to point at the files that hold everything else.

## What actually loads, and when

| File | Loads | Cost when its area is untouched |
|---|---|---|
| `CLAUDE.md` at or above cwd | Session start, always. Memoized; re-read after compaction | Full, every session |
| `CLAUDE.md` **below** cwd (`app/api/CLAUDE.md`) | Only when a file under that folder is read | **Zero** |
| `.claude/rules/*.md` with no `paths:` | Session start, always. Re-injected on compaction | Full, every session |
| `.claude/rules/*.md` with `paths:` | Only when a matching file is touched | **Zero** |
| `.claude/skills/*/SKILL.md` | Name + description at session start; body on invoke | Two lines |
| Hooks in `.claude/settings.json` | Config never enters context; only output can | Near zero |
| `.claude/agents/*.md` | Only when the Agent tool calls it, in its own window | **Zero** |

Two consequences that decide most placements:

- **A scoped file is free until needed. An unscoped one is paid for on every task in
  the repo,** relevant or not. That cost is not just tokens: it dilutes adherence to the
  instructions that actually matter.
- **Scoped and lazily-loaded content is lost again** once that area stops being touched,
  and re-injected on compaction only if it is still in scope. Anything that must survive
  a whole session regardless of what is being edited cannot be scoped.

## ⚠️ Which files must sit at cwd

**Nested files load only if they sit BELOW the cwd.** Open a session in `app/api/` and
`CLAUDE.md` files in sibling trees never load, while everything at and above cwd still
does. Two consequences, both load-bearing:

- **Anything that must hold everywhere goes at or above the usual cwd** — repo root for
  repo-wide, `~/.claude/CLAUDE.md` for machine-wide. A universal rule parked in a leaf
  folder is a rule that is off most of the time.
- **Any folder that gets opened directly is a root.** Subprojects, monorepo packages,
  anything with its own toolchain: name them, and give each one the ⛔ tier-1 material in
  full rather than assuming inheritance. Inheritance only runs upward from cwd.

State the intended cwd per root, in that root's own file, in one line. In a monorepo,
give each team's directory its own `CLAUDE.md` so teams load only their own conventions;
`claudeMdExcludes` lets a developer skip the ones they never touch.

## ⛔ The 250-line cap

**No `CLAUDE.md` exceeds 250 lines. Target under 200.** Past that the tail is skimmed and
the bottom of the file is decoration. The cap is **per file and never on total content** —
overflow *moves*, it is never deleted. Destinations, in order:

1. **Out to a skill**, if it is a procedure. First thing to check, most often correct.
2. **Down** into `<subfolder>/CLAUDE.md`, if it concerns only that subtree.
3. **Out to a path-scoped rule**, if it concerns a file type that appears in several
   corners of the repo but not all of them. Preferred over a nested `CLAUDE.md` for that
   shape, because one rule covers N folders.
4. **Out to a hook**, if it is mechanically enforceable.
5. **Stay**, only if it is a fact that governs every task in every folder.

Each moved section leaves **one line** behind: what moved, where it went, when it loads.
Never a summary — a summary is a second copy that drifts.

**Exempt: an unfilled template.** A donor file carrying material for several destinations
is expected to blow past the cap; it is sharded on arrival, not maintained at length. The
cap binds every file that results from filling it in.

## ⛔ One CLAUDE.md per folder

**Every source folder gets one, at every depth**, nested folders included. The load then
distributes: each session pays only for the folders it actually opens, instead of one
root growing until nothing in it is read.

- **Content:** what a session needs *while editing that folder and nothing else*. Its
  job in one line, its invariants, its gotchas, what it may and may not import, its
  intended cwd if it is a root. Never a restatement of the parent — the parent is
  already loaded.
- **Excluded:** generated, vendored, and ignored trees — `node_modules/`, `dist/`,
  `build/`, `.git/`, `target/`, coverage and asset dumps. Instructions there are never
  read and get wiped by the next regen. This is the one exclusion that needs no stated
  reason.
- **Nothing to say is a finding, not a placeholder.** A folder with no folder-specific
  rule usually has no distinct job. Write the one-line job statement, or fold the folder
  into its parent. An empty section is worse than no section.

## Rule files

`.claude/rules/<name>.md`, one concern per file, `paths:` frontmatter for scope:

```markdown
---
paths:
  - "src/api/**"
  - "**/*.handler.ts"
---
All API handlers must validate input with Zod before processing.
```

Omit `paths:` only when the constraint truly binds on every file in the repo. An unscoped
rule loads at session start and re-injects after every compaction, exactly like the root
`CLAUDE.md`. Scope aggressively: `migrations are append-only` scoped to `db/migrations/**`
costs nothing during frontend work.

## Skills

`.claude/skills/<name>/SKILL.md`, YAML frontmatter with `name` and `description`, body
below. Only the name and description load at session start; the body loads when the skill
is invoked, by slash command or by matching the description to the task.

**The description is the trigger.** Write it as *when to use this*, naming the situation
in the words a session would use, not as a title. A skill with a vague description is a
skill that never fires.

## Maintaining an instruction file

### Two zones

- **`[FILL]`** — project-specific skeleton. Fill it in or delete the section. An empty
  section is worse than no section, and an unfilled one is inert.
- **`[KEEP]`** — project-independent standards. Copy verbatim into every project. Do not
  rewrite to taste; they carry measured reasoning and stated sources. `[KEEP]` blocks are
  copied whole into each root, never sharded across them.

### Order by tier

Sections sort by **read frequency × cost of violating them**, never by topic, never by
narrative flow, and never by the order things were added. Highest first:

| Tier | Contains | Test |
|:--:|---|---|
| 1 | ⛔ rules, compliance | Read on every task, including skimmed ones |
| 2 | What this is, commands/gate | Needed to act at all |
| 3 | Architecture, contract, subsystems, gotchas, secrets | Needed to act *correctly* in an area |
| 4 | Long reference | Consulted, not memorised |
| 5 | Known weaknesses, quick reference | On demand only; safe to miss |

The tier rule applies **inside** a section too. A mandatory checklist buried under the
argument for it is mis-sorted exactly like a ⛔ rule buried under reference material.

**Restructuring is pre-authorised** — same change, report the moves, never ask first.
Triggers, any one is sufficient:

- A rule had to be scrolled past to be found, or was found only after a search
- A ⛔ rule or a mandatory checklist sits below the material that explains it
- A section outgrew its tier, or two files state the same rule
- The file grew — new material means re-checking that nothing important got pushed down
- A `[FILL]` section is still empty while the thing it describes now exists in code
- A file passed **250 lines**, or a folder exists with no `CLAUDE.md` — both trigger a
  split, not a trim
- A procedure is sitting in a `CLAUDE.md`, or a mechanical "always/never" is sitting in
  prose instead of a hook

**Method:** re-sort whole sections; never delete a rule while reordering; never reword
while moving. Moving and editing are two separate changes — if a move needs a rewrite,
say both happened. A split is the same method across two files: the moved block arrives
verbatim, the file it left keeps a one-line pointer, and both tier tables are updated in
the same edit.

### What earns a line

Three verdicts, never two. Reaching for delete when the answer is *move* is how real
information gets lost.

- **Delete** — only when **false**: contradicted by the code, aspirational and unfollowed,
  duplicated verbatim elsewhere, or an unbounded log (changelogs, task history) that was
  never a fact about the repo. Deleted for being wrong, never for being long.
- **Move** — true, but in the wrong container. **The default verdict.** Use the table at
  the top of this file: procedure → skill, file-type constraint → scoped rule, folder
  fact → that folder, mechanical always/never → hook.
- **Promote** — proved it gets hit often, or violating it is expensive. Costs every
  future session a re-read, so it must earn the move.

**Derivable is not a reason to delete.** A fact a competent engineer could recover in 30
seconds still costs a tool call, a file read, and context. Write it down and put it in the
cheapest container that still loads when it is needed.

The one exception: **facts that rot faster than the file gets updated** — file trees, line
numbers, dependency versions. These do not become useless when stale, they become wrong,
and wrong is the delete condition. Record the command that regenerates them instead.

**Keep:** anything marked ⛔ or ⚠️ · measured numbers plus the case that produced them ·
ordering rules and "exactly one X" invariants · touchpoint checklists · failures with root
causes attached · deliberate choices that look like bugs.

**Every rule needs a reason.** "Don't use raw fs" is ignorable. "Don't use raw fs —
encrypted inputs need the qpdf decrypt path, raw reads give you ciphertext" is not.

**State absolutes as absolutes.** "Prefer X" reads as optional. "NEVER Y — it breaks Z"
reads as a constraint. Hedge only where the choice really is free.

**Give the set an owner and review changes to it like code.** An instruction file nobody
owns is one every session appends to and none deletes from.
