---
paths:
  - "**/*.css"
  - "**/*.scss"
  - "**/*.less"
  - "**/*.tsx"
  - "**/*.jsx"
  - "**/*.vue"
  - "**/*.svelte"
  - "**/*.astro"
  - "**/*.html"
  - "**/styles/**"
  - "**/components/**"
---

# UI quality standard `[KEEP]`

Project-independent. Loads whenever something that renders is touched. Most rules carry
a measured basis: a reference set of five production illustrations was sampled
pixel-by-pixel, and the numbers are quoted inline so a future session can re-derive them
instead of trusting them. Rules sourced from convention rather than measurement are
marked **[convention]**.

Ordered like everything else: the ⛔ absolutes first, then the checklist that enforces
them, then the standard, then the measurements that produced it.

## ⛔ Hard rules

- **NEVER declare a `font-weight` with no matching face.** Measured on the system
  stack: `500`/`600` render as one identical face, and `650`/`700`/`750` render as
  another. Declaring `650` or `750` is precision the font cannot deliver; it silently
  collapses onto a neighbour. Detect it: render a probe string at each weight and
  compare widths — equal widths mean one face. Declare only weights verified distinct.
- **NEVER set font sizes in `px`.** It ignores the user's browser text setting. Use
  `rem`, and set `html { font-size: 100% }`.
- **NEVER ship more than 5 type sizes or 3 weights on one surface.** Sizes 1.1× apart
  (14 / 14.5 / 15px) read as noise, not hierarchy. Compact surfaces need 4.
- **NEVER use `animation-fill-mode: both` on an element that also has a `:hover`
  transform.** A filled animation's final keyframe outranks normal declarations, so a
  keyframe ending in `transform: none` permanently kills the hover. Use `backwards`
  for entrances — identical visual result, nothing retained.
- **NEVER let one visual variable do two jobs.** Hue carries identity; lightness
  carries depth. Size carries hierarchy level; weight carries role; colour carries
  emphasis. Cross-wiring them is the most common cause of "muddy".
- **NEVER contradict the light source.** Pick one and obey it everywhere: page
  gradient, card shadow, button inner highlight, pressed state. Mixed lighting reads
  as broken before anyone can say why.
- **NEVER disable zoom** (`user-scalable=no`), and never break at 200% zoom. Fix the
  layout instead.
- **NEVER add a second font family to create emphasis.** Use italic or bold of the
  same family. Mixed-family emphasis inside a headline is an amateur tell.

Punctuation in user-facing strings is governed by `copy.md`, which loads on a wider set
of paths than this file.

## Pre-ship checklist

Mechanical. No item answers "yes" without a number, selector, or value. Required by the
compliance protocol before any UI change is called done.

- [ ] Distinct `font-size` values on the surface: **≤5** (≤4 if compact)
- [ ] Distinct `font-weight` values: **≤3**, each verified to be a real face
- [ ] Zero `px` font sizes; `html { font-size: 100% }` present
- [ ] Type tokens named by role, not value
- [ ] Zero `—`, `–`, or `·` in user-facing strings: `grep -rn $'[—–·]'` over the
      rendered source, not an eyeball pass (`copy.md`)
- [ ] Focal container measured **≥70%** empty (painting elements only)
- [ ] Container gaps verified equal via `getBoundingClientRect`, not by eye
- [ ] Hue drift across any gradient **≤20°**, and only alongside a lightness change
- [ ] Exactly one saturated accent; neutrals are light-only
- [ ] Light source consistent across gradient, shadows, and pressed states
- [ ] Every interactive element has rest / hover / active / `:focus-visible`
- [ ] Nested radii concentric (inner = outer − padding)
- [ ] Semantic states survive greyscale (paired with a non-colour channel)
- [ ] No horizontal page scroll at 320px; nothing collides at the worst-case string
- [ ] Layout holds at 200% zoom
- [ ] `prefers-reduced-motion` respected
- [ ] Every failure-catalogue row checked

> Verify the narrow breakpoints with **device emulation**, not window resize — the
> browser window has a width floor (~500px CSS) that silently prevents small
> breakpoints from ever engaging.

## Failure catalogue

Root-caused and reproducible. Check these before shipping.

| Symptom | Root cause | Fix |
|---|---|---|
| Weight change has no visible effect | Declared weight has no matching face; it collapses onto a neighbour | Probe rendered widths per weight; declare only distinct ones |
| `:hover` transform never fires | A filled (`both`) entrance animation ends on `transform: none` and outranks it | `backwards`, not `both` |
| Circle has a bulge at 3 o'clock | `stroke-linecap: round` on a dash that closes a full circle — the two caps overlap | `butt` cap + dasharray = exact circumference (`2πr`) |
| SVG arc off-centre / arrowhead detached | Arc endpoints don't lie on the intended circle, so the renderer derives its own centre | Make the arc terminus *equal* the arrowhead vertex by construction |
| Stroke clipped at the container edge | SVG clips to its `viewBox` by default | `overflow: visible` on the SVG |
| "Circles" render as ovals | Fixed `width` + `height` let the container go non-square | `aspect-ratio: 1` |
| White label looks cramped and thin | Negative tracking applied to light-on-dark | Positive tracking + the other two compensation axes |
| Computed style reads the wrong value | Read taken mid-transition, right after a class change | Wait past the transition duration before asserting |
| Emptiness metric looks bad on an interactive surface | Transparent hit-targets tile the container and count as "content" | Measure only elements that paint (text, background, border, SVG shape) |
| Page scrolls sideways only once text size is raised | `<input>` carries a UA intrinsic width from its default `size=20` — measured in *characters*, so it scales with font-size and ignores the viewport. Fits at 100%, overflows at 200% | `inline-size: 100%` + `min-inline-size: 0` on the input and its flex/grid parent |

## Space

- **Target 70–90% empty on a focal surface.** If a screen feels cheap, the first
  question is never "what should I add" — it is "what can I remove". Measure it.
- **Content occupies a bounded fraction of its frame** (~57% width in the reference
  set). Full-bleed content with thin margins reads as a document, not a product.
- **One spacing scale, derived from the line-height of body text.** If body is 16px at
  1.5, the unit is 24px and every vertical gap is a multiple of it. Text and space then
  share a mathematical basis. **[convention]**
- **Centre optically, then verify numerically.** Read both gaps off
  `getBoundingClientRect` and require them equal. Eyeballing a screenshot is
  unreliable — decorative background elements skew perception badly.

## Colour

- **Hold hue; move lightness.** Measured drift across each reference gradient: 2–4° for
  mono-hue designs. Lightness does the work (Δ11–29 points); saturation stays pegged
  high. A gradient that swings hue looks like a mistake unless it is the brand.
- **The one licensed exception: rotate hue toward the shadow.** The two blue references
  drift 204° → 221° (19°, toward violet) *as they darken*. Hue may follow lightness
  down. It may not wander sideways at constant lightness. Cap drift at ~20°.
- **Fixed light source.** All five: bottom-left darkest, bottom-right lightest, top
  mid-light. Never contradicted once across five designs.
- **Three neutrals, all light.** Structural greys must never compete with the accent.
  If a grey is dark enough to read as content, it is content.
- **One accent, at full strength, once.** A second saturated colour halves the first
  one's power.
- **Semantic colour must survive being greyscaled.** If categories are distinguishable
  only by hue, they fail for colour-blind users. Pair hue with a second channel —
  position, count, or shape.

## Type

### System

- **Product register**: one system family, fixed `rem` scale, ratio **1.125–1.2**
  between steps. System stacks are legitimate and underrated here — native, instant,
  no layout shift. **Brand register**: a chosen typeface, fluid `clamp()`, ratio
  **≥1.25**. Flat scales (1.1× apart) read as uncommitted.
- **5 sizes cover most needs**; a compact surface needs 4:
  `caption .75rem` · `secondary .875rem` · `label/body 1rem` · `display 2rem+`.
  Give the display step a large jump — that gap *is* the hierarchy.
- **Name tokens by role, never by value.** `--text-display`, not `--font-32`. A role
  can be retuned in one place; a value name lies the moment you change it.
- **Retune tokens at breakpoints; never re-point roles.** The small breakpoint changes
  what `--text-display` equals. It does not move the title onto a different token.
- **≤3 weights**, one clear job each (e.g. `400` body · `600` label · `700` display and
  primary action). Verify each maps to a real face — see ⛔ above.

### Detail

- **Line-height**: headings 1.1–1.2, body 1.5–1.7. Measure 45–75ch (`max-width: 65ch`).
- **Tracking**: tighten large dark-on-light display (−0.02 to −0.03em); leave body
  alone; open ALL-CAPS and small labels **+0.05–0.12em** — capitals sit too close by
  default.
- **Light-on-dark needs compensation on three axes, not one.** White type on a
  saturated field sheds perceived weight and closes its counters. Fix all three:
  line-height +0.05–0.1, letter-spacing **+0.01–0.02em**, optionally one weight notch
  up. This is why a white button label wants *positive* tracking even when the
  dark-on-light title it echoes wants negative — compensation makes them match
  perceptually rather than numerically.
- **`font-variant-numeric: tabular-nums`** on any number that updates in place, or the
  layout jitters as digits change width.
- **`font-kerning: normal`** and **`font-optical-sizing: auto`** on `body`. Free.
- **Body text ≥16px.** Captions may be 11–12px; body may not. **[convention]**

### Selection

- **One family beats two.** Add a second only for genuine contrast (serif+sans,
  geometric+humanist, condensed+wide), never for variety. Hard cap 2–3. **[convention]**
- **Reflex-reject list.** Training-data defaults that create monoculture:
  Inter · Roboto · Arial · Open Sans · Helvetica · DM Sans · DM Serif · Plus Jakarta
  Sans · Outfit · Space Grotesk · Space Mono · IBM Plex (all) · Instrument Sans/Serif ·
  Fraunces · Newsreader · Lora · Crimson (all) · Playfair Display · Cormorant · Syne.
  Procedure: write three *physical-object* brand words ("warm and mechanical and
  opinionated"), list the three fonts you'd reach for by reflex, reject any on the
  list, browse a real catalogue, then cross-check — **if the final pick equals the
  original reflex, start over.** **[convention]**
- **A creative brief does not imply a serif.** "Creative = serif" is the single
  most-tested AI tell. Sans display is the default for the same reason black is the
  default in fashion. **[convention]**
- **Identity-preservation wins.** If a brand already ships one of these fonts, keep it.
  The list governs greenfield choices only. **[convention]**
- **Eyebrow restraint.** Small uppercase wide-tracked labels above headings: at most
  `ceil(sectionCount / 3)` per page. Count them mechanically. **[convention]**

### Loading (web fonts only) **[convention]**

`font-display: swap`; metric-matched fallback via `size-adjust` / `ascent-override`;
preload the critical weight only; one variable font once you need 3+ weights. Prefer
`optional` over `swap` when zero layout shift beats seeing the branded font.

## Depth, shape, motion, state

- **Elevation is layered, never a single blur.** A real shadow set is: 1px inner top
  highlight, 1px inner bottom seat, a tight contact shadow, and a wide ambient one.
  A lone `0 10px 30px rgba(0,0,0,.3)` reads as a drop-shadow filter, not as light.
- **Tint ambient shadows toward the surface beneath**, not toward black. Black shadows
  on a coloured field read as dirt.
- **Radii are proportional and tight** (~1–2% of the element's width for large
  surfaces). Nested radii must be concentric: inner = outer − padding.
- **Motion: 150–250ms for state, 300–450ms for entrance.** Entrances stagger 40–80ms.
  Anything over 500ms on an interaction feels broken.
- **Every interactive element needs four states**: rest, hover, active/pressed, and
  `:focus-visible`. The pressed state must *invert* the elevation (outer shadows →
  inset), or the press has no physical logic.
- **Honour `prefers-reduced-motion`** by collapsing durations, not by deleting the
  final state.
- **Disabled ≠ invisible.** Keep 3:1 contrast so it can still be read.

---

*Everything above is the standard. Why it holds is in the `ui-rationale` skill: the
thesis, the five-design evidence base, and the measured numbers behind each rule. Invoke
it when a rule looks arbitrary and you need to know whether it can be broken.*
