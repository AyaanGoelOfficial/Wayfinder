# vendor/fonts — the Noto faces the glyph generator reads

Three faces, committed, SIL Open Font License 1.1.

| File | Covers |
|---|---|
| `NotoSans-Regular.ttf` | Latin and common punctuation |
| `NotoSansDevanagari-Regular.ttf` | Devanagari (U+0900 to U+097F) |
| `NotoNaskhArabic-Regular.ttf` | Arabic script, for Urdu |

- **All three are required, and the order matters.** The composite stack takes each codepoint
  from the first face that has a real glyph for it. Noto Sans resolves क to .notdef and Noto Sans
  Devanagari resolves A to .notdef, so neither alone can render a mixed local name.
- **Adding a face means updating `SUPPORTED_SCRIPTS` in `packages/pipeline/glyphs/build.ts`**, or
  the build will still treat its codepoints as out of scope and skip them without failing.
- **Do not swap in a variable font without checking `opentype.js` reads its outlines.** The
  generator walks glyph paths directly; a face whose outlines it cannot parse produces empty
  glyphs and the coverage check will NOT catch it, because a glyph with no contours is treated as
  a legitimate blank such as a space.
- **Re-download from `notofonts/notofonts.github.io`**, path `fonts/<Family>/hinted/ttf/`. Verify
  the URL returns 200 before trusting the file: a 404 still writes a small HTML body, and a
  14-byte "font" fails much later and much less clearly.
