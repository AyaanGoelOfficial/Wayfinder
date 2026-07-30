/**
 * Places search: prefix, token, then fuzzy fallback.
 *
 * THE ASSERTION CONTRACT IS "the right KIND of thing in the right PLACE", never exact-string.
 * `config/fixtures/search.ts` records what OSM actually contains next to what a person types,
 * because those differ constantly: Pari Chowk resolves to a metro station, Knowledge Park is
 * numbered II/III, and Kasna is spelled Kasana and exists only as a road and a clinic.
 *
 * THE THREE PATHS EXIST IN THIS ORDER FOR A REASON:
 *   prefix  an exact leading match on the whole name or any token. What most queries are.
 *   token   every query token appears somewhere in the name. Handles reordering and extra words.
 *   fuzzy   bounded edit distance, only when the first two return nothing. This is what makes
 *           "Kasna" find "Old Kasana Road": one inserted character.
 *
 * Fuzzy runs LAST and only on failure, because it is the path that produces confident nonsense.
 * A query that matched exactly must never be outranked by something two edits away.
 */
import { editDistance, normalise, tokens } from '../shared/text.ts';
import { haversineM } from '../shared/geo.ts';
import type { Place, SearchHit } from '../shared/index.ts';

export interface SearchOptions {
  readonly limit?: number;
  /** Bias toward the user's map centre. Distance breaks ties; it never overrides kind or rank. */
  readonly near?: readonly [number, number];
  /** Max edit distance for the fuzzy fallback. 1 catches a typo; 3 catches a different word. */
  readonly maxEdits?: number;
}

interface Indexed {
  readonly place: Place;
  readonly norm: string;
  readonly toks: readonly string[];
}

/**
 * Locality bonus. Exponential decay, not a small linear tiebreak.
 *
 * This is a single-district navigation app: the whole build area is 69 by 50 km, so something
 * 35 km away is at the far end of the district and is almost never what was meant. An earlier
 * version capped this at 8 points, which made proximity decorative: the query "Kasna" returned
 * a village called Kapna 35 km away, one edit distant, ahead of "Old Kasana Road" two km away
 * and equally distant in spelling. Prominence beat presence, which is backwards for navigation.
 *
 * The decay is NEIGHBOURHOOD scale, not district scale. At an 8 km decay, something 3 km away
 * kept three quarters of its bonus, which is wrong for a city: 3 km is several sectors, not
 * "nearby". It made a suburb 3 km away outrank an equally-good prefix match 14 m away, purely
 * on prominence. 2.5 km decay: 55 at the cursor, 37 at 1 km, 25 at 2.5 km, 16 at 3 km, ~0 at
 * 20 km. That is enough for presence to beat a moderate prominence gap, and not enough to lift
 * a service road above a town.
 */
const LOCALITY_WEIGHT = 55;
const LOCALITY_DECAY_M = 2_500;
function localityBonus(distanceM: number): number {
  return LOCALITY_WEIGHT * Math.exp(-distanceM / LOCALITY_DECAY_M);
}

/**
 * How much intrinsic prominence counts on the FUZZY path.
 *
 * A fuzzy hit is already a guess about what was typed, so leaning on prominence compounds one
 * guess with another: it answers "what is the most important thing vaguely like this anywhere"
 * when the question was "what near me did I mean". At full weight the 50-point gap between
 * place=village and highway=tertiary cannot be closed by any honest distance term, so a distant
 * settlement always wins. Compressing it lets presence decide between equally-spelled guesses,
 * while leaving exact and prefix matches ranked by prominence as before.
 */
const FUZZY_IMPORTANCE_WEIGHT = 0.35;

/**
 * Two rules that decide whether a fuzzy candidate is a TYPO or a DIFFERENT PLACE.
 *
 * Absolute edit distance cannot tell those apart, and the held-out query set proved it:
 * "Beta 1" returned "Delta 1", and "Alpha 2" returned "Alpha 1". Both are two-or-fewer edits and
 * both are the wrong sector. Sending a driver to Delta 1 when they typed Beta 1 is worse than
 * returning nothing, because nothing prompts them to retype and a confident wrong answer does not.
 *
 * RULE 1, relative distance. One edit in a four-letter word is a quarter of the word, which is a
 * different word; one edit in a ten-letter word is a slip. So the budget scales with length,
 * floored at 1 so short queries still tolerate a single typo. This rejects beta -> delta while
 * keeping kasna -> kasana.
 *
 * RULE 2, digits are identity, not spelling. Greater Noida is laid out as Alpha 1, Alpha 2,
 * Beta 1, Sector 62. A digit is the whole difference between two real destinations kilometres
 * apart, so an edit that changes or drops one is never a typo to forgive. Query and candidate
 * must carry the same digit sequence, or the candidate is not a fuzzy match at all.
 */
const FUZZY_RELATIVE_BUDGET = 0.25;

function fuzzyBudget(len: number, cap: number): number {
  return Math.min(cap, Math.max(1, Math.floor(len * FUZZY_RELATIVE_BUDGET)));
}

/** The digit runs in a string, in order. "alpha 2" -> "2", "sector 62" -> "62". */
function digitsOf(s: string): string {
  const m = s.match(/\d+/g);
  return m === null ? '' : m.join(',');
}

export class PlacesSearch {
  private readonly items: readonly Indexed[];

  constructor(places: readonly Place[]) {
    this.items = places.map((place) => {
      const norm = normalise(place.name);
      return { place, norm, toks: tokens(place.name) };
    });
  }

  get size(): number {
    return this.items.length;
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const q = normalise(query);
    if (q === '') return [];
    const limit = opts.limit ?? 10;
    const qToks = tokens(query);

    const prefix: SearchHit[] = [];
    const token: SearchHit[] = [];

    for (const it of this.items) {
      const hit = (matchType: SearchHit['matchType'], bonus: number): SearchHit => {
        const base: SearchHit = {
          ...it.place,
          matchType,
          score: it.place.importance + bonus,
        };
        if (opts.near === undefined) return base;
        const d = haversineM(opts.near[1], opts.near[0], it.place.point[1], it.place.point[0]);
        return { ...base, distanceM: d, score: base.score + localityBonus(d) };
      };

      if (it.norm === q) {
        prefix.push(hit('prefix', 40));
        continue;
      }
      if (it.norm.startsWith(q)) {
        prefix.push(hit('prefix', 25));
        continue;
      }
      if (it.toks.some((t) => t.startsWith(q))) {
        prefix.push(hit('prefix', 15));
        continue;
      }
      if (qToks.length > 0 && qToks.every((qt) => it.toks.some((t) => t.startsWith(qt)))) {
        token.push(hit('token', 5));
      }
    }

    const strong = [...prefix, ...token];
    if (strong.length > 0) {
      strong.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
      return strong.slice(0, limit);
    }

    // ---- Fuzzy fallback. Only reached when nothing matched cleanly. ----
    const maxEdits = opts.maxEdits ?? (q.length <= 4 ? 1 : 2);
    const qDigits = digitsOf(q);
    const fuzzy: SearchHit[] = [];
    for (const it of this.items) {
      // RULE 2: a differing digit means a different destination, never a typo. Checked before
      // any distance work, because it is a cheap string compare that rejects most candidates.
      if (digitsOf(it.norm) !== qDigits) continue;

      // Compare against the whole name AND each token: "Kasna" against "old kasana road" is 6
      // edits, but against the token "kasana" it is 1. Without the per-token comparison the
      // fuzzy path cannot find a road named after the place. RULE 1: the budget is relative to
      // the length of whatever is being compared, so a short word tolerates proportionally less.
      let bestD = editDistance(q, it.norm, fuzzyBudget(Math.max(q.length, it.norm.length), maxEdits));
      if (bestD > fuzzyBudget(Math.max(q.length, it.norm.length), maxEdits)) bestD = Infinity;
      for (const t of it.toks) {
        if (bestD === 0) break;
        const budget = fuzzyBudget(Math.max(q.length, t.length), maxEdits);
        const d = editDistance(q, t, budget);
        if (d <= budget && d < bestD) bestD = d;
      }
      if (!Number.isFinite(bestD) || bestD > maxEdits) continue;
      const base: SearchHit = {
        ...it.place,
        matchType: 'fuzzy',
        // Each edit costs more than any importance gap within a tier, so a closer spelling wins
        // before rank does. Prominence is compressed here; see FUZZY_IMPORTANCE_WEIGHT.
        score: it.place.importance * FUZZY_IMPORTANCE_WEIGHT - bestD * 30,
      };
      if (opts.near === undefined) fuzzy.push(base);
      else {
        const d = haversineM(opts.near[1], opts.near[0], it.place.point[1], it.place.point[0]);
        fuzzy.push({ ...base, distanceM: d, score: base.score + localityBonus(d) });
      }
    }
    fuzzy.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return fuzzy.slice(0, limit);
  }
}
