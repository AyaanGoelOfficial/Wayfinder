/**
 * The car profile: which ways are drivable, in which direction, and how fast.
 *
 * This is the single place legality is decided. packages/pipeline/CLAUDE.md: legality lives
 * in the graph, not the search. If this file is right, no computed route can be illegal,
 * which is charter item 7 made structural instead of something the router has to remember.
 *
 * Speeds come from ONE table. Never inline a number at a call site: a second speed source is
 * how a route starts disagreeing with its own ETA.
 */

export type Access = 'allowed' | 'private' | 'denied';

/**
 * Drivable highway classes with their default speeds in km/h, tuned for Indian conditions
 * rather than taken from a European default table.
 *
 * These are DEFAULTS, used only when `maxspeed` is absent, and they are deliberately below
 * the legal limits: the target is realistic travel speed on Greater Noida roads including
 * signals, cattle, autos and unmarked speed breakers. Gate 4 measures the result against
 * OSRM and gate 6 tightens these from evidence. Until then they are declared estimates, not
 * measurements, and the build report says so.
 */
export const CLASS_SPEED_KMH: Readonly<Record<string, number>> = {
  motorway: 90,
  motorway_link: 45,
  trunk: 70,
  trunk_link: 40,
  primary: 50,
  primary_link: 30,
  secondary: 40,
  secondary_link: 25,
  tertiary: 35,
  tertiary_link: 25,
  unclassified: 30,
  residential: 25,
  living_street: 10,
  service: 15,
  road: 25,
};

/**
 * Road class rank. 0 is the biggest road, 7 the smallest.
 *
 * Used ONLY by the turn cost model in `packages/engine/turncost.ts`, to price the act of turning
 * off a bigger road onto a smaller one. It is deliberately NOT derived from `CLASS_SPEED_KMH`: a
 * residential street tagged `maxspeed=60` would then outrank a tertiary road, and the whole point
 * is to capture what KIND of road it is, not how fast this particular one is posted.
 *
 * A `*_link` ranks WITH ITS PARENT, never below it. A link is the transition between two roads,
 * not a demotion, and ranking `motorway_link` under `motorway` would charge a penalty for leaving
 * a motorway by the only means a motorway provides.
 */
export const CLASS_RANK: Readonly<Record<string, number>> = {
  motorway: 0, motorway_link: 0,
  trunk: 1, trunk_link: 1,
  primary: 2, primary_link: 2,
  secondary: 3, secondary_link: 3,
  tertiary: 4, tertiary_link: 4,
  unclassified: 5, road: 5,
  residential: 6,
  living_street: 7, service: 7,
};

/** Not drivable by car under any tagging. Listed rather than inferred, so it is auditable. */
const NEVER_DRIVABLE = new Set([
  'footway', 'path', 'cycleway', 'steps', 'pedestrian', 'bridleway', 'corridor',
  'construction', 'proposed', 'platform', 'raceway', 'busway', 'escape', 'via_ferrata',
]);

/**
 * `highway=track` is excluded. In this area tracks are unsurfaced field access, and routing a
 * car onto one is the classic "technically shorter" wrong answer. Recorded here because it is
 * a judgement call and the next person will wonder.
 */
const EXCLUDED_BY_JUDGEMENT = new Set(['track']);

/** Tag keys that grant or deny motor vehicle access, most specific first. */
const ACCESS_KEYS = ['motorcar', 'motor_vehicle', 'vehicle', 'access'] as const;

const DENY_VALUES = new Set(['no', 'false']);
const PRIVATE_VALUES = new Set(['private', 'permit', 'customers', 'delivery', 'agricultural', 'forestry']);

/**
 * Resolves motor vehicle access. `private` is distinguished from `denied` on purpose: the GBU
 * fixture requires that a destination inside a gated campus snaps to the nearest LEGAL edge at
 * the gate, and that the route neither fails nor silently drives through the private road. The
 * router needs to know a way is private rather than merely absent to do that.
 */
export function accessOf(tags: ReadonlyMap<string, string>): Access {
  for (const key of ACCESS_KEYS) {
    const v = tags.get(key);
    if (v === undefined) continue;
    if (DENY_VALUES.has(v)) return 'denied';
    if (PRIVATE_VALUES.has(v)) return 'private';
    // yes / designated / destination / permissive all permit passage.
    return 'allowed';
  }
  return 'allowed';
}

export interface WayClassification {
  readonly drivable: boolean;
  readonly highway: string;
  readonly access: Access;
  readonly forward: boolean;
  readonly backward: boolean;
  readonly speedKmh: number;
  /** True when speedKmh came from a maxspeed tag rather than the class default table. */
  readonly speedTagged: boolean;
  /** `CLASS_RANK` of this way's highway class. 0 is the biggest road. */
  readonly classRank: number;
  readonly roundabout: boolean;
}

const NOT_DRIVABLE: WayClassification = {
  drivable: false,
  highway: '',
  access: 'denied',
  forward: false,
  backward: false,
  speedKmh: 0,
  speedTagged: false,
  classRank: 255,
  roundabout: false,
};

/**
 * Parses `maxspeed`. Returns undefined when the tag is absent or not understood, so the caller
 * falls back to the class table rather than inventing a number.
 *
 * Handles the forms that actually occur: "60", "60 km/h", "60 kmh", "30 mph", "IN:urban".
 * A walk/none value is treated as unknown rather than as zero or infinity.
 */
export function parseMaxspeed(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const s = raw.trim().toLowerCase();
  if (s === '' || s === 'none' || s === 'signals' || s === 'variable' || s === 'walk') return undefined;

  const mph = /^(\d+(?:\.\d+)?)\s*mph$/.exec(s);
  if (mph) {
    const v = Number(mph[1]) * 1.609344;
    return v > 0 && v < 200 ? v : undefined;
  }
  const kmh = /^(\d+(?:\.\d+)?)\s*(?:km\/h|kmh|kph)?$/.exec(s);
  if (kmh) {
    const v = Number(kmh[1]);
    return v > 0 && v < 200 ? v : undefined;
  }
  // Implicit country categories such as IN:urban. Not resolved here: guessing a number from a
  // category we have not verified for India would be a fabricated measurement.
  return undefined;
}

/**
 * Direction of travel. `oneway=-1` is a real and easily missed value: it means the way is
 * one-way AGAINST its own node order, so forgetting it silently reverses a road.
 *
 * Implied one-ways per the OSM wiki: motorway, motorway_link, and any roundabout or circular
 * junction. An explicit `oneway=no` overrides every implication, which is why the explicit tag
 * is read first.
 */
export function directionOf(
  tags: ReadonlyMap<string, string>,
  highway: string,
): { forward: boolean; backward: boolean; roundabout: boolean } {
  const junction = tags.get('junction');
  const roundabout = junction === 'roundabout' || junction === 'circular';
  const raw = tags.get('oneway');

  if (raw === 'yes' || raw === '1' || raw === 'true') return { forward: true, backward: false, roundabout };
  if (raw === '-1' || raw === 'reverse') return { forward: false, backward: true, roundabout };
  if (raw === 'no' || raw === '0' || raw === 'false') return { forward: true, backward: true, roundabout };

  if (roundabout || highway === 'motorway' || highway === 'motorway_link') {
    return { forward: true, backward: false, roundabout };
  }
  return { forward: true, backward: true, roundabout };
}

export function classifyWay(tags: ReadonlyMap<string, string>): WayClassification {
  const highway = tags.get('highway');
  if (highway === undefined) return NOT_DRIVABLE;
  if (NEVER_DRIVABLE.has(highway) || EXCLUDED_BY_JUDGEMENT.has(highway)) return NOT_DRIVABLE;

  // An unknown highway value is excluded rather than guessed. New OSM values appear over time
  // and admitting them by default would put a car on whatever gets invented next.
  const classDefault = CLASS_SPEED_KMH[highway];
  if (classDefault === undefined) return NOT_DRIVABLE;

  const access = accessOf(tags);
  if (access === 'denied') return NOT_DRIVABLE;

  const tagged = parseMaxspeed(tags.get('maxspeed'));
  const { forward, backward, roundabout } = directionOf(tags, highway);

  return {
    drivable: true,
    highway,
    access,
    forward,
    backward,
    speedKmh: tagged ?? classDefault,
    speedTagged: tagged !== undefined,
    classRank: CLASS_RANK[highway] ?? 5,
    roundabout,
  };
}
