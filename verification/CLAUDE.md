# verification — committed evidence from the browser gates

Screenshots and traces produced by the browser gates, committed so a claim about what the map
looked like can be checked rather than believed.

- **A screenshot is evidence only if nothing in it was inferred.** `hard-rules.md` § Evidence:
  never complete truncated text. If a label is clipped in a capture, re-capture it (zoom, widen
  the viewport, query the raw data) or report it as unknown. A partly-inferred screenshot is not
  evidence, and this is the folder where that rule bites hardest.
- **Name captures for what they prove, and include the view.** The URL hash carries
  `#zoom/lat/lon`, so a capture is reproducible by link: record it next to the file rather than
  describing the location in prose.
- **Keep the failure captures, not just the passes.** The gate 2 style error and the blank map
  from the missing MapLibre worker are more useful than the working screenshot, because they are
  what a regression will look like.
- **These are small PNGs, not build artifacts.** Nothing here is regenerable by `build-city`, so
  unlike `data/` it is committed. Do not put tiles, archives or extracts in here.
