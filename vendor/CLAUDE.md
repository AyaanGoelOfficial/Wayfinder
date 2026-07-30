# vendor — third-party inputs, committed on purpose

Unlike `tools/` and `data/`, this tree is COMMITTED. It holds small third-party inputs the build
needs, so a fresh clone can build labels without a network fetch.

- **`fonts/` holds the Noto faces the SDF glyph generator reads.** Noto Sans (Latin), Noto Sans
  Devanagari, and Noto Naskh Arabic (Urdu, an additional official language of Uttar Pradesh).
  All three are needed: Noto Sans contains no Devanagari and Noto Sans Devanagari contains no
  Latin, and local names mix them in a single label.
- **All Noto fonts here are licensed SIL Open Font License 1.1**, which permits redistribution
  including bundling. Keep the licence in mind before adding a face from another foundry.
- **These are INPUTS, not artifacts.** `hard-rules.md` bans committing extracts and built
  artifacts because they are hundreds of MB and regenerable from `config/city.ts`. These are
  about 1.1 MB total and are not derivable from anything in this repo, so the reasoning does not
  apply. Do not use this folder as a loophole for build outputs.
- **Source of record:** the `notofonts/notofonts.github.io` repository, `fonts/<Family>/hinted/ttf/`.
  Verify a URL by fetching it before relying on it: the `googlefonts/noto-fonts` layout differs
  and earlier guesses at the path returned 404 while still writing a 14-byte file.
