---
name: add-feature
description: The ordered touchpoint checklist for adding a capability to this repo, every file that must change, in order, including the ones that are hand-written and do not infer from anything else. Invoke before starting any new feature, endpoint, threshold, fixture or client surface so no touchpoint is missed.
---

# Adding a capability — the 12 touchpoints

Filled at gate 8, from walking all twelve for live tracking. Before that this file was a
`[FILL]` template, which meant it was inert and every feature re-derived the list from scratch.

Work the list in order. **Do not skip a step because it looks inferable.** The ones marked
⚠ are hand-written and infer from nothing, so a missed one fails silently rather than loudly.

## 1 to 3, decide before writing code

1. **Is there a number in this feature?** If yes it is DERIVED, never picked, and the derivation
   is a script in `scripts/` that prints its measurement. See `calibrate:tracking` for the shape:
   it measures one physical quantity over the real clip and every threshold follows from it. A
   constant whose comment argues for itself rather than citing a measurement is the defect.
2. **Which side of the boundary does it run on?** `packages/CLAUDE.md` has the table. The client
   may import `config/` and `shared/` and NOTHING else, so anything the browser must run that
   needs the graph has to be split: the pure half into `shared/`, the graph half behind an
   endpoint. Deciding this late means rewriting it.
3. **What is the positive control?** Every negative claim this feature will make needs one.
   Write it down now, while the claim is still a sentence.

## 4 to 7, the contract and the engine

4. `config/city.ts` — the constants, each with its derivation and the command that produced it.
   ⚠ **Check declaration ORDER**: the file is evaluated top to bottom, so a block referencing
   `SNAP_TRACKING_M` must sit below it or it is a temporal dead zone error at import.
5. `packages/shared/index.ts` — **THE CONTRACT, and it is edited FIRST.** Types, any new
   `ErrorCode`, and the `ROUTES` entry. A route or shape not named here does not exist.
6. `packages/shared/<feature>.ts` or `packages/engine/<feature>.ts` — the logic, placed by step 2.
   `engine/` does no IO and takes typed arrays; `shared/` may import `config/` only.
7. `packages/server/main.ts` — the handler. ⚠ **Start it by validating every parameter before
   the engine is touched**, following `parsePoint`. The client is untrusted input, and a body is
   a larger surface than a query string.

## 8 to 10, the client

8. `packages/client/vite.config.ts` — ⚠ **ADD THE PATH TO THE PROXY LIST.** It is explicit, and
   an unlisted path falls through to the SPA fallback and returns `index.html` with a **200**, so
   the client receives HTML where it expected JSON and nothing reports an error.
9. `packages/client/src/store.ts` — all state and every decision. Components render and dispatch,
   nothing else. Supersession needs BOTH an `AbortController` and a monotonic sequence number.
10. The component and its CSS, then `packages/client/src/map/` if it draws. ⚠ **Layer ORDER is
    load bearing and `addLayer` reports a bad `beforeId` on the map's ERROR CHANNEL rather than
    throwing**, so the call returns normally and the layer is simply absent. Same for a paint
    expression MapLibre rejects. Check `getLayer()` after adding, not just the return.

## 11 to 12, proof

11. `tests/<area>/` — and a new folder needs its own `CLAUDE.md`. ⚠ **Mutate the code to prove
    each new assertion can fail.** A test that cannot go red is a comment.
12. `config/fixtures/` for anything frozen, then the gate that reads it.

## Before finishing

- Root `CLAUDE.md` § The contract: a new capability means editing the contract file, not
  reaching across the boundary. Add the channel/route/schema entry there.
- The folder's own `CLAUDE.md`: if this added an invariant that only holds inside one
  folder, record it there, not in the root.
- Correctness gate, root `CLAUDE.md` § Commands. Quote the output.
- If anything rendered: the pre-ship checklist in `.claude/rules/ui.md`, at 320 px by DEVICE
  EMULATION rather than window resize, which floors at about 500 CSS px and silently passes.
- `PROGRESS.md` and `DESIGN.md` in the SAME change, never as a follow-up.

> Worked example: live tracking at gate 8 walked all twelve. `DESIGN.md` § Tracking records what
> each step cost, including the three defects that only the browser gate found.
