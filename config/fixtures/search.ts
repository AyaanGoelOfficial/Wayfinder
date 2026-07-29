/**
 * SEARCH fixtures. What a PERSON TYPES, paired with what OSM actually holds.
 *
 * These two are routinely different, and that difference is the whole point of the file.
 * A person types "Kasna"; OSM says "Old Kasana Road". A person types "Pari Chowk"; OSM
 * has a metro station of that name and a separate roundabout. A person types "Knowledge
 * Park"; OSM has several numbered ones.
 *
 * THE ASSERTION IS DELIBERATELY NOT EXACT-STRING. For each entry:
 *
 *   the top result is the RIGHT KIND OF THING in the RIGHT PLACE
 *
 * that is, its category is in `expectKind` and its position is within `expectWithinM` of
 * `nearLat`/`nearLon`. Asserting an exact returned name would encode OSM's spelling into
 * our test suite and would go red the day a mapper fixes a typo, which tells us nothing
 * about our search quality.
 *
 * Verified against raw OSM via Overpass on 2026-07-29. Overpass is used here rather than
 * Nominatim on purpose: Nominatim is a separate index with its own ranking, so its silence
 * says nothing about what is in our extract.
 *
 * Graph coverage lives in ./routing.ts. Keep them apart.
 */

export interface SearchFixture {
  /** Exactly what the user types into the box. Do not "correct" it to OSM spelling. */
  readonly query: string;
  /** What OSM actually contains for this query, verified. Explains the assertion. */
  readonly osmReality: string;
  /** Acceptable categories for the top result. */
  readonly expectKind: readonly string[];
  readonly nearLat: number;
  readonly nearLon: number;
  /** How far the top result may sit from nearLat/nearLon, in metres. */
  readonly expectWithinM: number;
  /** True when several legitimate results exist and asserting a single hit is wrong. */
  readonly expectMultiple?: boolean;
  readonly note?: string;
}

/** Every search fixture must return its top result within this budget. Spec target. */
export const SEARCH_BUDGET_MS = 5;

export const SEARCH_FIXTURES: readonly SearchFixture[] = [
  {
    query: 'Pari Chowk',
    osmReality:
      'OSM way 696191675 is a railway=station named "Pari Chowk". The actual roundabout ' +
      'is a separate feature roughly 150 to 200 m north-east.',
    expectKind: ['railway', 'junction', 'highway', 'place'],
    nearLat: 28.46313,
    nearLon: 77.50810,
    expectWithinM: 400,
    note:
      'Either the station or the roundabout is a correct answer. Asserting which one ' +
      'would be asserting a ranking preference we have not justified.',
  },
  {
    query: 'Knowledge Park',
    osmReality:
      'Several numbered sub-areas. The station at 28.45699,77.50020 is labelled ' +
      '"Knowledge Park II" specifically, so no feature is named exactly "Knowledge Park".',
    expectKind: ['railway', 'place', 'highway', 'amenity'],
    nearLat: 28.45699,
    nearLon: 77.50020,
    expectWithinM: 2500,
    expectMultiple: true,
    note:
      'THE PREFIX TEST. A typed prefix that matches several real features must return ' +
      'several, ranked sensibly, not one arbitrary pick and not zero because no exact ' +
      'match exists. The generous radius covers Knowledge Park I through V.',
  },
  {
    query: 'Kasna',
    osmReality:
      'VERIFIED 2026-07-29 across the whole build area: ZERO place=* features under any ' +
      'spelling. Exactly two matches exist, both spelled KASANA: "Old Kasana Road" ' +
      '(highway=tertiary) and "Kasana Nursing Home" (amenity=clinic, node 7028065211).',
    expectKind: ['highway', 'amenity'],
    nearLat: 28.50800,
    nearLon: 77.48200,
    expectWithinM: 6000,
    expectMultiple: true,
    note:
      'THE MOST VALUABLE FIXTURE IN THIS FILE, and it tests two paths at once. ' +
      'First, the typed "Kasna" differs from the mapped "Kasana" by a single inserted ' +
      'character, so a prefix-only index returns nothing and the bounded edit-distance ' +
      'or trigram fallback is what must save it. Second, the only matches are a ROAD and ' +
      'a BUSINESS, so this fails outright unless the places sweep really does index ' +
      'named roads rather than POIs alone. ' +
      'Do NOT "fix" this by adding a Kasna alias. The absence is real and the fixture is ' +
      'the end-to-end check that fuzzy matching plus road indexing both work.',
  },
  {
    query: 'Gaur City',
    osmReality: 'OSM node 11054398266, shop=supermarket, inside the development.',
    expectKind: ['shop', 'place', 'building', 'amenity'],
    nearLat: 28.60542,
    nearLon: 77.42744,
    expectWithinM: 1500,
    expectMultiple: true,
    note:
      'Greater Noida West. Confirms the index reaches the northern lobe and is not ' +
      'quietly biased toward the older city.',
  },
  {
    query: 'Surajpur',
    osmReality: 'OSM node 8612166750 named "Surajpur", plus place=village way 353217244.',
    expectKind: ['place'],
    nearLat: 28.51065,
    nearLon: 77.47861,
    expectWithinM: 1500,
    note: 'The control. A real place, exact spelling, unambiguous. If this fails, everything is broken.',
  },
  {
    query: 'Jewar',
    osmReality:
      'A town in the south, plus tehsil relation 9999629 whose CENTROID sits on a ' +
      'national highway in open country, far from the town.',
    expectKind: ['place'],
    nearLat: 28.12,
    nearLon: 77.55,
    expectWithinM: 12000,
    note:
      'Deliberately NOT asserted against the routing fixture coordinate. A person typing ' +
      '"Jewar" means the town, not the tehsil centroid. This is exactly why search and ' +
      'routing fixtures are separate files.',
  },
  {
    query: 'Dadri',
    osmReality: 'Railway station node 7572622446, plus tehsil relation 9999631, plus "Dadri Road" ways.',
    expectKind: ['railway', 'place', 'highway'],
    nearLat: 28.53873,
    nearLon: 77.53722,
    expectWithinM: 4000,
    expectMultiple: true,
    note: 'One typed word, three legitimate kinds of answer. Tests importance ranking rather than recall.',
  },
] as const;
