/**
 * ROUTING fixtures. Chosen for GRAPH COVERAGE, not for name resolution.
 *
 * Each entry exists to exercise a specific way the graph can be wrong. They are not a
 * list of nice places; removing one removes a class of bug from the gate.
 *
 * THE GATE (gate 1, and re-run at every later gate):
 *   1. each point snaps to a legal edge for its profile within SNAP_DESTINATION_M
 *   2. every ordered pair routes successfully inside the largest SCC
 *   3. per-entry assertions in `asserts` hold
 * Hard fail on any of these, independent of the coverage gate and never an override.
 *
 * Coordinates are FROZEN. Resolved via Nominatim and the OSM API on 2026-07-29 and each
 * one eyeballed on openstreetmap.org the same day. Never re-resolve at build or test time.
 *
 * Name resolution lives in ./search.ts. Keep the two apart: a routing fixture may sit on a
 * highway in open country where nobody would ever search, and a search fixture may be a
 * name that resolves nowhere near a road.
 */

export interface RoutingFixture {
  readonly id: string;
  readonly lat: number;
  readonly lon: number;
  /** The class of graph bug this entry exists to catch. */
  readonly covers: string;
  readonly source: string;
  readonly asserts?: readonly string[];
  readonly note?: string;
}

export const ROUTING_FIXTURES: readonly RoutingFixture[] = [
  {
    id: 'jewar',
    lat: 28.20165,
    lon: 77.62654,
    covers: 'rural SCC edge. Proves the largest SCC spans the whole district, not just the urban core.',
    source: 'OSM relation 9999629 (boundary=administrative, admin_level=6) centroid, 2026-07-29',
    asserts: [
      'routes to and from every other routing fixture',
      'lands in the largest SCC, never an island',
    ],
    note:
      'Eyeballed: the TEHSIL CENTROID, on national highway NH-3x in open country between ' +
      'the villages Birampur, Bhikanpur, Mundrah and Ranhara. It is NOT Jewar town, and ' +
      'that is fine here because this fixture tests connectivity, not naming. Roughly ' +
      '30 km south of Pari Chowk, the southernmost point in the set.',
  },
  {
    id: 'gaur-city',
    lat: 28.60542,
    lon: 77.42744,
    covers:
      'THE PERMANENT WRONG-SIDE TEST for precision charter item 3. Divided carriageway ' +
      'with both directions mapped as separate ways.',
    source: 'OSM node 11054398266 (shop=supermarket), Nominatim 2026-07-29',
    asserts: [
      'a fix stream heading north matches the northbound carriageway only',
      'the same stream reversed matches the southbound carriageway only',
      'no fix in either run matches the opposing carriageway, at any noise level tested',
      'also the Greater Noida West anchor: proves the northern lobe connects to the rest',
    ],
    note:
      'Eyeballed: sits on "gaur city mall" fronting a divided road, Hindon River just ' +
      'west. Chosen over the other divided-road candidates because the two carriageways ' +
      'are far enough apart to be unambiguous to a human and close enough to fool a ' +
      'nearest-edge matcher that ignores heading. If this site is ever remapped as a ' +
      'single way, this fixture stops testing anything, so re-verify before trusting it.',
  },
  {
    id: 'alpha-1',
    lat: 28.47103,
    lon: 77.51274,
    covers: 'dense urban expressway corridor with frequent parallel service roads.',
    source: 'OSM node 4165778689 (railway=station), Nominatim 2026-07-29',
    asserts: ['snaps to the expressway or its service road, never to the metro line itself'],
    note:
      'Eyeballed: metro station on the expressway corridor, Alpha 1 sector label to the ' +
      'north-west. Also a divided carriageway, so it is the backup wrong-side site if ' +
      'gaur-city is ever remapped.',
  },
  {
    id: 'surajpur',
    lat: 28.51065,
    lon: 77.47861,
    covers: 'dense named-road town grid. The straightforward control case.',
    source: 'OSM way 353217244 (place=village), Nominatim 2026-07-29',
    asserts: ['snaps well inside SNAP_TRACKING_M, being surrounded by roads on all sides'],
    note:
      'Eyeballed: town centre, roads named Dadri Road (secondary), Purana Bazaar and ' +
      'Lakhnawali Road (tertiary), roundabout to the south-west. The cleanest fixture ' +
      'in the set, so if THIS one fails the problem is systemic, not local.',
  },
  {
    id: 'dadri',
    lat: 28.53873,
    lon: 77.53722,
    covers:
      'OFF-ROAD DESTINATION. The nearest drivable road is far enough away that a tight ' +
      'radius would reject it.',
    source: 'OSM node 7572622446 (railway=station), Nominatim 2026-07-29',
    asserts: [
      'snaps successfully under SNAP_DESTINATION_M',
      'would FAIL under SNAP_TRACKING_M, and the test asserts that it fails',
      'never snaps to the railway, which is not a drivable edge',
    ],
    note:
      'Eyeballed: the railway station on the Howrah-Delhi line. Dadri Road is roughly ' +
      '150 to 200 m west, Dadri Bypass further south-west. This is deliberately the ' +
      'entry that proves the two radii are wired to different code paths: if a tracking ' +
      'call ever accepts this point, the radii have been crossed and that is a bug.',
  },
  {
    id: 'gautam-buddha-university',
    lat: 28.42268,
    lon: 77.52464,
    covers:
      'ACCESS RULES. A destination inside a gated campus whose internal ways are ' +
      'commonly access=private.',
    source: 'OSM way 188067195 (amenity=university) bbox centroid, 2026-07-29',
    asserts: [
      'the destination snaps to the nearest LEGAL edge, the public road at the gate',
      'the returned route never traverses an access=private way',
      'it neither fails outright nor silently routes through private ways',
      'the same pattern must hold for any other gated sector, this is the template',
    ],
    note:
      'Eyeballed: the point is INSIDE the campus polygon on internal roads. The nearest ' +
      'certainly-public edge is the Yamuna Expressway along the west side. This is an ' +
      'access-rule test, NOT an exception to be worked around. Do not move this fixture ' +
      'to the gate to make it pass; snapping it to the gate is the behaviour under test.',
  },
] as const;

export type RoutingFixtureId = (typeof ROUTING_FIXTURES)[number]['id'];
