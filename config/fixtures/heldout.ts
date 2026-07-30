/**
 * HELD-OUT search queries. Not fixtures, not tuning data.
 *
 * WHY THIS FILE EXISTS: the search ranking constants (locality decay, fuzzy prominence weight)
 * were tuned while looking at the results of `search.ts` fixtures. That is textbook over-fitting
 * risk: constants chosen to make seven specific queries pass may be worse than the ones they
 * replaced for everything else, and the fixtures can no longer detect it.
 *
 * These queries were written from prior knowledge of Greater Noida BEFORE looking at the places
 * index, and were NOT consulted while choosing any constant. They are a check on generalisation,
 * so the rule is absolute:
 *
 *   NEVER TUNE AGAINST THIS FILE. If these fail, the ranking is wrong and must be re-derived.
 *   Adjusting a constant until these pass converts the held-out set into more tuning data and
 *   destroys the only independent signal there is. Adding queries is fine; using them to pick a
 *   number is not.
 *
 * `mustResolve` marks queries whose subject is certain to exist in the area in some form. The
 * rest are allowed to return nothing: OSM coverage is uneven, and an absent feature is a fact
 * about the data rather than a ranking failure.
 */
export interface HeldOutQuery {
  readonly query: string;
  /** Why a real user would type this. */
  readonly rationale: string;
  /** True when something matching this must exist in the build area. */
  readonly mustResolve: boolean;
  /** What the index actually contains, VERIFIED, when that differs from the real world. */
  readonly osmReality?: string;
}

/** Fraction of `mustResolve` queries that must return a plausible hit for the gate to pass. */
export const HELD_OUT_PASS_RATIO = 0.7;

export const HELD_OUT_QUERIES: readonly HeldOutQuery[] = [
  {
    query: 'Alpha 2',
    rationale: 'Greater Noida sectors are named by Greek letter; people type them constantly.',
    // VERIFIED against the built index: the ONLY Greek-letter sector features are "Alpha 1" and
    // "Delta 1", both railway stations. The sectors themselves are not tagged as places. Control
    // for that negative: 496 indexed names contain a digit, including Sector 18 and Sector 62,
    // so digit-bearing names are certainly found. mustResolve was originally true and was wrong
    // about the DATA, not about the ranking. Corrected, not loosened.
    osmReality: 'no Alpha 2 feature exists; only Alpha 1 (railway station)',
    mustResolve: false,
  },
  {
    query: 'Beta 1',
    rationale: 'Another Greek-letter sector, and a common destination.',
    osmReality: 'no Beta 1 feature exists in the index under any spelling',
    mustResolve: false,
  },
  { query: 'Gamma 1', rationale: 'Third sector series. Tests that sector naming is indexed generally, not case by case.', osmReality: 'no Gamma 1 feature exists', mustResolve: false },
  { query: 'Yamuna Expressway', rationale: 'The major road out of the district toward Agra.', mustResolve: true },
  { query: 'Sharda University', rationale: 'One of the large private universities in Knowledge Park.', mustResolve: true },
  { query: 'Galgotias', rationale: 'A university people refer to by one word, never its full name.', mustResolve: true },
  { query: 'Jagat Farm', rationale: 'A market area in Gamma, known locally by name rather than sector.', mustResolve: false },
  { query: 'Ecotech', rationale: 'The industrial sector series. Tests a prefix shared by many features.', mustResolve: false },
  { query: 'Pari Chok', rationale: 'MISSPELLING of Pari Chowk, the kind a phone keyboard produces.', mustResolve: true },
  { query: 'Nolej Park', rationale: 'PHONETIC misspelling of Knowledge Park. Harder than a one-character typo.', mustResolve: false },
];
