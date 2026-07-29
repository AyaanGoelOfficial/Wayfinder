---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.vue"
  - "**/*.svelte"
  - "**/*.astro"
  - "**/*.html"
  - "**/*.py"
  - "**/*.go"
  - "**/*.rb"
  - "**/*.rs"
  - "**/*.java"
  - "**/*.kt"
  - "**/*.swift"
  - "**/*.php"
  - "**/*.cs"
  - "**/locales/**"
  - "**/i18n/**"
  - "**/content/**"
---

# ⛔ User-facing copy `[KEEP]`

Scoped wide because user-facing strings are not confined to the view layer: an error
raised in a service, a validation message, a seeded database row, and a translation file
all reach the reader. If a string in this file can end up on a screen, this rule binds.

- **NEVER put an em dash (`—` U+2014), an en dash standing in for one (`–` U+2013), or
  an interpunct (`·` U+00B7) in user-facing text.** Covers every string a person reads
  in the product: labels, headings, body copy, buttons, empty states, errors, toasts,
  tooltips, placeholders, in-app docs, notification and email copy, and anything
  assembled at runtime. Reason: the em dash is the loudest machine-written tell in
  shipped copy, and `·` used as a separator collapses visually into a list bullet at
  small sizes while reading as noise to a screen reader.
  **Instead:** a comma, a colon, parentheses, or two sentences. For separated lists use
  a real list, a `/`, or a `|`.
  **Exempt:** code comments, identifiers, log output, commit messages, and repo docs
  such as `CLAUDE.md` and the files in `.claude/`.

**Verify mechanically, never by eye** — the characters are near-invisible in review:

```bash
grep -rn $'[—–·]' src/        # or: grep -rn $'[—–·]' src/
```

Zero hits, or a named exemption per hit. This is one line of the pre-ship checklist in
`ui.md`, and it is the one that fails most often after a copy edit.

> A grep that must pass on every change is hook material, not checklist material. When
> this repo grows a `PreToolUse` or `PostToolUse` hook that runs it, delete the manual
> step and point at the hook.
