# packages/pipeline/glyphs — SDF glyph ranges, generated offline

Turns the vendored Noto faces into the range PBFs MapLibre needs to draw any label at all.
Nothing is fetched from a public glyph endpoint, at build time or at runtime.

- **`fontnik` is NOT usable here.** The purpose-built generator needs a native build and fails
  to install on Node 24, so the SDF is computed in plain TypeScript over `opentype.js`.
- **opentype.js ships CommonJS, and the DEFAULT import is the working form.** A namespace import
  yields `{ default, "module.exports" }` with no `parse` on it. That fails at runtime, not at
  typecheck, so it will not be caught by the gate.
- **Distance is measured to the FLATTENED OUTLINE and signed by winding number**, not by
  rasterising and running a distance transform. A pixel-grid transform quantises distance to
  whole pixels, which shows up as wobble on the halo of every label at 24 px per em.
- **Nonzero winding, never even-odd.** Even-odd hollows out the counters of glyphs like 8 and क.
- **The constants are Mapbox's and the client assumes them**: 24 px em, 3 px buffer, 8 px spread,
  0.25 cutoff. The bitmap is `(width + 6) * (height + 6)`. Change any of these without changing
  the client and labels come out blurry, clipped, or misplaced.
- **`left` and `top` are sint32 and must be ZIGZAG encoded.** Writing them as plain varints sends
  every glyph with a negative bearing to a huge positive offset.
- **A blank glyph such as space still needs an entry**, with an advance and no bitmap, or every
  label containing a space collapses.
- **COVERAGE IS DERIVED FROM THE PLACES INDEX, never from a guessed codepoint list.** The build
  fails if a codepoint in a SUPPORTED script has no glyph, because that means a face is missing.
  Codepoints outside the supported scripts are listed in full and do not fail: the index really
  does contain CJK, a heart and an Egyptian hieroglyph, and vendoring roughly 20 MB of CJK for
  nine characters is a bad trade. That line is a stated scope decision, not an oversight.
- **Urdu is a supported script because it is an additional official language of Uttar Pradesh.**
  Arabic script here is local, not foreign.
- **DO NOT BUILD A SHAPING PIPELINE.** The limit below is MapLibre's and is not fixable at our
  layer; an Indic shaper here would be a large, permanent maintenance burden for 26 names out of
  7,676. The mitigation is to prefer `name:en` for DISPLAY where OSM provides it and fall back to
  `name` otherwise, which is what the three `text-field` expressions in `tiles/style.ts` do. The
  local-script name is still INDEXED and still carried in the tiles, so nothing is lost for search
  or for a future renderer that can shape. Revisit only if a label a real user would read is
  affected. Evidence stays committed: `verification/gate2-devanagari-*.png`.
- **KNOWN LIMIT: MapLibre does not shape Indic text.** Devanagari glyphs are drawn in logical
  order without conjunct formation or matra reordering, so a Devanagari label is legible but not
  typographically correct. There is no plugin for this the way there is for RTL.
- **Imports:** `../clip/binio.ts`, `opentype.js`, Node built-ins.
