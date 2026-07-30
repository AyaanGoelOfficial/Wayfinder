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
    const fuzzy: SearchHit[] = [];
    for (const it of this.items) {
      // Compare against the whole name AND each token: "Kasna" against "old kasana road" is 6
      // edits, but against the token "kasana" it is 1. Without the per-token comparison the
      // fuzzy path cannot find a road named after the place.
      let bestD = editDistance(q, it.norm, maxEdits);
      for (const t of it.toks) {
        if (bestD === 0) break;
        const d = editDistance(q, t, maxEdits);
        if (d < bestD) bestD = d;
      }
      if (bestD > maxEdits) continue;
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
