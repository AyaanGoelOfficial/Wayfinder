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

import { TOLL_ROADS, TOLL_TAGGING_ERRORS } from '../../../config/city.ts';
import { TOLL_GATE_MAINLINE, TOLL_GATE_NONE, TOLL_GATE_RAMP } from '../../shared/graphfile.ts';

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

/**
 * Whether a way charges a toll.
 *
 * MEASURED, not guessed at: across the 121,084 drivable ways in this clip the ONLY toll-ish key
 * present is `toll`, and its only value is `yes`, on 920 ways. There is no `toll=no` and no
 * `toll:motorcar`. The extra accepted spellings below cost nothing and mean a re-clip that starts
 * carrying them does not silently stop tolling a road.
 *
 * This is a FACT about the way, not a cost. What a toll is worth belongs to the objective in
 * `config/city.ts`, because it is a preference and preferences do not belong in the graph.
 */
export function tollOf(tags: ReadonlyMap<string, string>): boolean {
  const v = tags.get('toll') ?? tags.get('toll:motorcar');
  return v === 'yes' || v === 'true' || v === '1';
}

/**
 * WHICH toll road charges this way, as an id into `TOLL_ROADS`. 0 means no toll at all.
 *
 * A FACT ABOUT THE WAY, never a price. What each road charges, how it charges it, and how
 * confident we are all live in `config/city.ts`, so a tariff revision changes a constant and never
 * requires a graph rebuild.
 *
 * Ways listed in `TOLL_TAGGING_ERRORS` return 0 even though they carry `toll=yes`. That is a
 * deliberate override of the data and it is justified beside the list: three residential and
 * unclassified ways, two tags each, no name and no operator, clustered within 2 km, are one bad
 * edit rather than three toll roads. Charging a residential street would push routes off ordinary
 * streets for a fee that does not exist.
 *
 * Anything tolled that no NAMED entry claims falls through to the `unpriced` entry, never to 0. A
 * road whose tariff we have not established is not a free road.
 */
export function tollRoadOf(wayId: number, tags: ReadonlyMap<string, string>): number {
  if (!tollOf(tags)) return 0;
  if ((TOLL_TAGGING_ERRORS as readonly number[]).includes(wayId)) return 0;
  const name = tags.get('name') ?? '';
  const ref = tags.get('ref') ?? '';
  for (const r of TOLL_ROADS) {
    if (r.match === null) continue;
    if (r.match.test(name) || r.match.test(ref)) return r.id;
  }
  const fallback = TOLL_ROADS.find((r) => r.key === 'unpriced');
  return fallback === undefined ? 0 : fallback.id;
}

/**
 * Is this node a toll plaza, and is it a MAINLINE barrier or a RAMP booth?
 *
 * BOTH KINDS ARE MARKED, and that is a correction. Until gate 6 only mainline barriers were
 * recorded, on the reasoning that billing every booth would charge one plaza several times for a
 * single crossing. That reasoning was right about double billing and wrong about the consequence:
 * with ramps unmarked, leaving a gate-charged expressway at one interchange and rejoining past the
 * barrier cost nothing, so the router did exactly that. It was measured on the Yamuna Expressway,
 * where a route crossed 22.0 km of the road and zero barriers.
 *
 * Distinguishing the two rather than merging them is what avoids the original double-billing
 * problem: `config/city.ts` bills a mainline crossing at a flat fee and a ramp by distance, so
 * three ramp booths at one interchange still produce one interchange's charge.
 */
export function tollGateKindOf(
  nodeTags: ReadonlyMap<string, string> | undefined,
  wayHighway: string,
): number {
  if (nodeTags === undefined) return TOLL_GATE_NONE;
  if (nodeTags.get('barrier') !== 'toll_booth' && nodeTags.get('highway') !== 'toll_gantry') {
    return TOLL_GATE_NONE;
  }
  return wayHighway === 'motorway' || wayHighway === 'trunk' ? TOLL_GATE_MAINLINE : TOLL_GATE_RAMP;
}

/**
 * A ROAD'S OWN RAMPS BELONG TO IT, resolved by geometry rather than by name.
 *
 * THE DEFECT THIS FIXES. An interchange ramp is tagged `toll=yes` and, in this extract, usually
 * carries no `name` and no `ref` at all. `tollRoadOf` matches on those two tags, so every such ramp
 * fell through to the `unpriced` entry. Because route confidence is the weakest link across the
 * roads a route touches, 8.38 km of unnamed Eastern Peripheral slip road dragged EVERY EPE route to
 * `unpriced`: 0 of 9 EPE routes reported the confidence their road actually has. A road's own ramps
 * are not a different road.
 *
 * NODE SHARING, NOT A DISTANCE THRESHOLD. A ramp physically joins the carriageway, so it shares a
 * node with it, and shared identity is exact where a radius would need tuning. Ramps that reach the
 * mainline only through another ramp are picked up by iterating to a fixpoint. A ramp touching two
 * different toll roads, which is what an expressway-to-expressway interchange produces, goes to
 * whichever it shares more nodes with, and ties keep the lower road id so the result cannot depend
 * on way order in the PBF.
 *
 * ⛔ ONLY UNNAMED LINKS ARE ELIGIBLE, and that restriction is the whole safety of this pass. A first
 * cut let any `unpriced` way be claimed by geometry, and it absorbed two independent toll roads:
 * the Delhi Western Peripheral and NH148NA both meet EPE at an interchange, so both shared nodes
 * with it and both were silently re-billed as EPE. The symptom was an unpriced total of exactly
 * 0.00 km, which read as success. A way that carries a `name` or a `ref` is asserting an identity,
 * and geometry does not get to overrule it; only an anonymous `*_link` is a ramp of whatever it
 * joins.
 *
 * Anything still unclaimed stays `unpriced`, which is the correct answer for a genuinely
 * independent tolled road and is never silently free.
 */
export function attributeTollRamps(
  ways: readonly { readonly id: number; readonly refs: readonly number[]; readonly tags: ReadonlyMap<string, string> }[],
  tollRoadOfWay: ReadonlyMap<number, number>,
  unpricedId: number,
): { reassigned: Map<number, number>; rounds: number } {
  const nodesOfRoad = new Map<number, Set<number>>();
  const pending: { id: number; refs: readonly number[] }[] = [];
  for (const w of ways) {
    const road = tollRoadOfWay.get(w.id);
    if (road === undefined || road === 0) continue;
    if (road === unpricedId) {
      // Eligibility, per the ⛔ above: anonymous slip roads only. A named or ref'd way keeps its
      // own identity and stays `unpriced` however much geometry it shares with a neighbour.
      const anonymous = (w.tags.get('name') ?? '') === '' && (w.tags.get('ref') ?? '') === '';
      const isLink = (w.tags.get('highway') ?? '').endsWith('_link');
      if (anonymous && isLink) pending.push({ id: w.id, refs: w.refs });
      continue;
    }
    let s = nodesOfRoad.get(road);
    if (s === undefined) {
      s = new Set<number>();
      nodesOfRoad.set(road, s);
    }
    for (const r of w.refs) s.add(r);
  }

  const reassigned = new Map<number, number>();
  let rounds = 0;
  let remaining = pending;
  for (let round = 0; round < 8 && remaining.length > 0; round++) {
    const still: typeof remaining = [];
    let claimedThisRound = 0;
    for (const w of remaining) {
      let bestRoad = 0;
      let bestShared = 0;
      for (const [road, nodes] of nodesOfRoad) {
        let shared = 0;
        for (const r of w.refs) if (nodes.has(r)) shared++;
        // Strictly greater keeps the lowest road id on a tie, since Map iterates in insertion
        // order and `TOLL_ROADS` is inserted by ascending id.
        if (shared > bestShared) {
          bestShared = shared;
          bestRoad = road;
        }
      }
      if (bestShared === 0) {
        still.push(w);
        continue;
      }
      reassigned.set(w.id, bestRoad);
      claimedThisRound++;
      const s = nodesOfRoad.get(bestRoad);
      if (s !== undefined) for (const r of w.refs) s.add(r);
    }
    rounds = round + 1;
    if (claimedThisRound === 0) break;
    remaining = still;
  }
  return { reassigned, rounds };
}

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
  /** True when the way charges a toll. A fact about the road; its price is a preference. */
  readonly toll: boolean;
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
  toll: false,
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
    toll: tollOf(tags),
    roundabout,
  };
}
