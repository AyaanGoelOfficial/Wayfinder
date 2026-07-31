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

  // ---------------------------------------------------------------------------
  // SECOND BATCH. The first ten left only four queries load-bearing, because six turned out to
  // name things OSM does not carry and were correctly marked `mustResolve: false`. A held-out set
  // where six of ten pass by returning nothing is not a generalisation check, it is four queries
  // wearing a coat. These were written from prior knowledge of Gautam Buddha Nagar BEFORE running
  // any of them, for the same reason as the first batch.
  //
  // `mustResolve` here is a claim about the WORLD: settlements and major institutions in this
  // district are well covered by OSM. If one fails, the question is whether the feature is absent
  // from the data or the ranking buried it, and that is settled with a positive control, never by
  // flipping the flag to make the gate green.
  // ---------------------------------------------------------------------------
  {
    query: 'Bisrakh',
    rationale: 'Village in Greater Noida West, locally famous and widely used as a destination.',
    // Resolves, but NOT to the village: the only two indexed names containing "Bisrakh" are
    // "BISRAKH FCS" as a fuel station and as a charging station, at 77.4450,28.5746. That is the
    // right LOCATION, so a driver typing this is sent to the right place by an accident of what
    // OSM carries. The village itself is not indexed as a `place=*` under this spelling.
    // Control: the substring scan over all 7,676 indexed names returns exactly those two.
    osmReality: 'no place=* named Bisrakh; only BISRAKH FCS (fuel and charging) at the village location',
    mustResolve: true,
  },
  { query: 'Dankaur', rationale: 'Town on the southern side of the district, on the way to Jewar.', mustResolve: true },
  { query: 'Rabupura', rationale: 'Town near the Yamuna Expressway. Tests coverage away from the urban core.', mustResolve: true },
  { query: 'Chhapraula', rationale: 'Village on the western edge, near the Ghaziabad boundary.', mustResolve: true },
  { query: 'Bennett University', rationale: 'A third university in the area, distinct from Sharda and Galgotias.', mustResolve: true },
  {
    query: 'Grand Venice',
    rationale: 'A large mall people name by two words, never in full.',
    // mustResolve was TRUE and it FAILED. Corrected only after a positive control settled that
    // this is a data absence rather than a ranking failure: zero of the 7,676 indexed names
    // contain "Venice", while "Grand" returns 8 (Grand Trunk Road, Pearl Grand, Mona Grand Hotel
    // and others), so multi-word and substring matching demonstrably work. The mall is simply not
    // in this extract. Corrected about the WORLD, not loosened to make the gate pass.
    osmReality: 'no indexed name contains "Venice"; control: "Grand" matches 8 names',
    mustResolve: false,
  },
  { query: 'Eastern Peripheral Expressway', rationale: 'The other motorway through the district. A long multi-word road name.', mustResolve: true },
  { query: 'Buddh International Circuit', rationale: 'The motor racing circuit. A prominent named feature with no settlement nearby.', mustResolve: true },
  { query: 'Ek Murti', rationale: 'A well known roundabout. Junctions are often unnamed in OSM, so this may legitimately return nothing.', osmReality: 'confirmed absent: zero indexed names contain "Murti"', mustResolve: false },
  // Marked uncertain and it resolved anyway, to amenity/aerodrome. Left as `may`: the flag records
  // what was known when it was written, and raising it now on one lucky pass is how a held-out set
  // quietly becomes tuning data.
  { query: 'Noida International Airport', rationale: 'The Jewar airport. Under construction, so its tagging and naming are genuinely uncertain.', mustResolve: false },
];
