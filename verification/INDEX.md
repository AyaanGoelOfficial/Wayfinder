# Capture index

`verification/CLAUDE.md` requires each capture to carry the view that reproduces it, next to the
file rather than described in prose. The client puts the view in the URL hash (`#zoom/lat/lon`), so
a capture is reproducible by pasting the link with both servers running (`npm run serve` plus
`npm --prefix packages/client run dev`).

Captures taken before this index existed do not have their centre recorded. They are listed as
**unknown** rather than reconstructed: `hard-rules.md` § Evidence forbids completing a value that
was not observed, and a plausible-looking coordinate is exactly that kind of completion.

## Gate 3, routing

Route query string: `?from=<lon,lat>&to=<lon,lat>`, engine geometry drawn by `drawRoute()`.

| File | Route | View |
|---|---|---|
| `gate3-crosscity-whole-z10.png` | `?from=77.43000,28.60000&to=77.55000,28.13000` | `#10/28.36/77.50` |
| `gate3-crosscity-curve-z18.png` | same as above | `#18/28.583085/77.441601` |
| `gate3-route-curve-z18.png` | `?from=77.50310,28.47120&to=77.52464,28.42268` | `#18/28.468590/77.508615` |
| `gate3-route-curve-z18-thin.png` | same as above | same as above |

`gate3-route-curve-z18-thin.png` is the SAME view and route as `gate3-route-curve-z18.png` with
the route line narrowed to 3 px and the casing hidden, applied as a runtime paint override on the
live map. It exists because the shipped 14 px line at z18 completely covers the road beneath it, so
the shipped appearance cannot show whether the line sits on the drawn road. The paint values in
`routeLayers.ts` are unchanged; keep both, because the pair is the evidence.

Curve sites were chosen by measuring accumulated heading change over a sliding 120 m window of the
route's own shape points, not by eye. Panchmukhi Chowk in `gate3-crosscity-curve-z18.png` is named
from `querySourceFeatures` on the `transportation_name` layer, because the rendered label is
overlapped by the route line in the capture and must not be read from the pixels.

## Gate 2, tiles and labels

| File | View |
|---|---|
| `gate2-devanagari-shaping-inspection.png` | unknown centre, Devanagari POI label inspection |
| `gate2-devanagari-z16.png` | z16, centre unknown |
| `gate2-devanagari-z17.png` | z17, centre unknown |
| `gate2-labels-wide.png` | unknown |
| `gate2-labels-z14.png` | z14, centre unknown |
| `gate2-map-z15.png` | z15, centre unknown |
| `gate2-map.png` | unknown |
| `gate2-parichowk-z15.png` | z15, Pari Chowk, exact centre unknown |
| `gate2-poi-devanagari.png` | unknown |
