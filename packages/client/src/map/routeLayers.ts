/**
 * The route line, added above the basemap at runtime.
 *
 * Defined HERE, not imported from the pipeline's style module, because
 * `packages/CLAUDE.md` forbids the client importing `pipeline/`. The accent value is the one
 * shared constant that must not drift: it is the single saturated colour in the product, and
 * it also appears as `--accent` in index.css. If it changes, change it in both.
 */
export const ROUTE_ACCENT = '#1f6feb';

export const ROUTE_LAYERS = {
  /** White casing under the line, so the route stays readable over dark landuse and water. */
  casing: {
    id: 'route-casing',
    type: 'line',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 15, 14, 18, 22],
      'line-opacity': 0.9,
    },
  },
  line: {
    id: 'route-line',
    type: 'line',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ROUTE_ACCENT,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 15, 9, 18, 14],
    },
  },
  /**
   * The walking approach at either end, from the snapped road point to where the user asked to go.
   *
   * ⛔ IT MUST NOT LOOK LIKE ROUTE. Same accent so it reads as part of the same answer, but dashed,
   * thinner and semi-transparent, with no casing, so it is legible as "not driven" before any label
   * is read. We have no pedestrian routing, so it is a STRAIGHT line between two points and must
   * never be drawn through a path that implies one.
   *
   * `line-dasharray` is in line widths, not pixels, so the dash keeps its proportion as the line
   * thickens with zoom.
   */
  approach: {
    id: 'route-approach',
    type: 'line',
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: {
      'line-color': ROUTE_ACCENT,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 15, 4, 18, 6],
      'line-opacity': 0.75,
      'line-dasharray': [2, 2],
    },
  },
} as const;
