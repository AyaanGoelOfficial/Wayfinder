/**
 * Frozen tracking ground truth. The sites the browser gate drives synthetic fixes across.
 *
 * DERIVED, NOT CHOSEN. Every site here came out of `npm run calibrate:tracking`, which measures
 * the separation between genuinely different antiparallel one-way ways across the whole clip. A
 * divided-road fixture picked off a map by eye is the classic way this test goes hollow: it lands
 * on an ordinary two-way street, whose two directed edges share one shape and one way id, and
 * telling those apart is far easier than telling apart two separate carriageways 19 m apart. The
 * numbers in `TRACKING` and the sites here therefore agree by construction.
 *
 * VERIFIED AGAINST THE LIVE GRAPH, not just against the calibration output. Each site records the
 * two edge ids `/match` actually returns for the two directions of travel, and they must be
 * DIFFERENT WAYS rather than a forward and reverse pair. That check is what distinguishes a real
 * divided carriageway from a street the matcher merely happens to get right.
 */
import type { LngLat } from '../../packages/shared/index.ts';

export interface DividedRoadFixture {
  readonly key: string;
  /** A point on the carriageway travelled, between the two. */
  readonly point: LngLat;
  /** Direction of travel on the carriageway under test, degrees from true north. */
  readonly travelBearingDeg: number;
  /** Direction of the opposing carriageway. Roughly 180 from the above, never exactly. */
  readonly opposingBearingDeg: number;
  /** Measured separation between the two carriageways, in metres. */
  readonly separationM: number;
  /**
   * What the two directions must resolve to. Recorded so a remap that merges the pair into one
   * way makes the fixture FAIL rather than silently stop testing anything, which is the failure
   * mode `config/fixtures/CLAUDE.md` warns about for `gaur-city`.
   */
  readonly expectDistinctEdges: true;
  readonly covers: string;
}

export const DIVIDED_ROADS: readonly DividedRoadFixture[] = [
  {
    key: 'surajpur-divided',
    point: [77.5497452, 28.4920715],
    travelBearingDeg: 56.8,
    opposingBearingDeg: 236.6,
    // 19.0 m, against a measured median of 19.39 m across 66,359 pairs. Deliberately typical
    // rather than extreme: the tail of that distribution is where OSM geometry is untidy, and a
    // fixture that only passes on a tidy outlier proves less than one that passes on the median.
    separationM: 19.0,
    expectDistinctEdges: true,
    covers:
      'precision charter item 3. Verified live: travelling 56.8 resolves to edge 33658 and the ' +
      'reverse to edge 33785, which are 127 apart in the edge table and therefore separate ways ' +
      'rather than the forward and reverse of one two-way street.',
  },
  {
    key: 'greater-noida-west-divided',
    point: [77.4062814, 28.673217],
    travelBearingDeg: 107.8,
    opposingBearingDeg: 288.4,
    separationM: 16.8,
    expectDistinctEdges: true,
    covers:
      'A second site in a different part of the district, so a pass cannot come from one road ' +
      'happening to be mapped conveniently.',
  },
];

/**
 * The route the clean-drive, noise and deviation scenarios are flown over.
 *
 * Pari Chowk to Knowledge Park: 3.7 km, inside the built-up core, and it carries a roundabout,
 * several name changes and a divided section, so a drive across it exercises instruction
 * advancement rather than one long straight leg.
 */
export const DRIVE_ROUTE = {
  key: 'pari-chowk-to-knowledge-park',
  from: [77.5031, 28.4712] as LngLat,
  to: [77.4906, 28.4633] as LngLat,
  covers: 'Clean drive, noise tolerance, instruction advancement and off-route detection.',
} as const;
