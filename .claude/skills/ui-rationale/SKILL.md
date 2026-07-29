---
name: ui-rationale
description: Why the UI rules in .claude/rules/ui.md hold - the subtractive thesis and the measured five-design evidence base behind the emptiness, hue-drift, neutral-count, radius and accent numbers. Invoke when a UI rule looks arbitrary, when deciding whether a rule can be broken for a specific design, or when a new surface needs numbers the standard does not name.
---

# Why the UI standard holds

Reference only. The enforceable rules are in `.claude/rules/ui.md`; this is the argument
and the measurements behind them. Nothing here overrides a ⛔ there.

## The thesis

**Good UI is subtractive.** Every measurement points the same direction: the reference
designs are 61–94% empty, hold hue almost constant while only lightness moves, use
three greys, and spend one saturated accent per screen. The typography guidance says
the identical thing in another medium — fewer sizes, more contrast; three weights, not
five; one family, not two. Quality came from what was removed and from what was held
still. Anything that adds a second variable to a job already done by a first variable
makes the interface worse.

Corollary: **an interface is a system, not a screen.** The five references are five
completely different products — a database tool, an image editor, a portfolio, a
predictor, a game — sharing one skeleton with only hue and payload swapped. If your
second screen needs new spacing values, new radii, or a new type step, the system is
wrong, not the screen.

## The evidence base

Five reference illustrations, each a 512×305 canvas: a white card floating on a
saturated gradient. Measured, not estimated.

| Property | Measured across all five | What it means |
|---|---|---|
| Card width | 291–295px = **56.8–57.6%** of canvas | The surround is not waste. It is what makes the card read as an object. |
| Card centring | L/R margins within 1–2px | Optical centring is not eyeballed. |
| Card interior empty | 61.1 / 67.8 / 89.1 / 92.1 / **93.6%** | Mean **80.7%** empty. The headline number. |
| Corner radius | 2–5px on a 293px card = **~1–1.7%** of width | Tight, not pill. Big radii are an AI-default tell. |
| Frame band | ~11px inset = **3.8%** of card width | A hairline halo, not a border. |
| Frame fill | **14–17%** white over the background | |
| Frame stroke | **~35%** white, 1–2px | Brighter than both its neighbours. |
| Greys inside card | `#D3D3D3` `#DEDEDE` `#E3E3E3` | **Three**, all light. No dark grey, no black. |
| Distinct colours >0.3% coverage | 14 / 24 / 33 / 44 / 46 buckets | You can count the decisions. |
| Accent | Exactly **one** saturated focal element per card | |

Constant across all five regardless of product: frame geometry, card position, corner
radius, gradient direction, and the three status dots `#52B986` / `#FFC601` /
`#E32D4D`. Only hue and payload change. **That is what a design system is.**

## Using this to break a rule

A rule with a measured basis can be broken when the measurement does not apply to the
surface in front of you — a dense data table is not a focal card, and 80% emptiness is
not its target. A rule marked **[convention]** carries no measurement and is broken more
cheaply. In both cases the deviation gets stated in the same message, per
`rules/compliance.md` § Working rules.

What never gets broken on a rationale argument: the ⛔ rules. Those encode failures with
root causes, not preferences.
