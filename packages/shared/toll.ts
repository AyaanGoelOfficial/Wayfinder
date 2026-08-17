/**
 * The one rule that turns toll confidence into what a screen may show.
 *
 * WHY IT IS A FUNCTION AND NOT A COMMENT. `Route.tollDisplay` carries a ⛔ saying the estimate
 * label is not a view decision. A ⛔ in a doc comment is a prompt; a function both sides call is
 * enforcement. This is the only place the mapping exists, so a new surface cannot quietly invent a
 * fourth answer, and `tests/engine/objective.test.ts` can assert the rule directly rather than
 * asserting it through a route.
 *
 * SEPARATE FROM `index.ts` for the reason stated in `packages/shared/CLAUDE.md`: that file is the
 * contract and holds types crossing the boundary, not utilities. `geo.ts` sits beside it on the
 * same grounds.
 */
import type { TollConfidence, TollDisplay } from './index.ts';

export function tollDisplayOf(confidence: TollConfidence, tollMetres: number): TollDisplay {
  // No tolled metres means no toll element at all, whatever the confidence happens to be. A route
  // that never touched a toll road reports `verified` by vacuous truth, and showing "0" for it
  // would be a claim about a road the driver never used.
  if (tollMetres <= 0) return 'none';
  return confidence === 'verified' ? 'exact' : 'estimated';
}
