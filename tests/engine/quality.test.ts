/**
 * The road quality weights: does a rough kilometre cost more, WITHOUT flattening the hierarchy?
 *
 * WHY THIS SUITE EXISTS. A flat distance preference implements the exchange rate correctly and has
 * one unintended consequence: a constant per-km cost is a larger FRACTION of a fast road's cost
 * than a slow one's, so it compresses the class hierarchy. Measured at a flat 24 s/km, motorway to
 * tertiary fell from 2.571 to 1.982 and the tertiary-and-below share of route distance over the 56
 * validation pairs rose from 26.8% to 34.4%. The intent was to decline detours, never to prefer
 * village roads.
 *
 * THE INVARIANT IS THE POINT, and it is asserted here rather than checked by eye. Weighting must
 * leave every slower class at least as expensive RELATIVE to every faster one as pure time made
 * it. Writing that out: with effective cost per km `c = t + k*q`, preservation between a faster
 * class i and a slower class j means
 *
 *     (t_j + k*q_j) / (t_i + k*q_i)  >=  t_j / t_i
 *
 * which rearranges to `q_j / t_j >= q_i / t_i`. So the whole invariant is: **`quality` divided by
 * seconds-per-km never DECREASES as roads get smaller.** That is one comparison per class pair and
 * it is what the first test walks.
 *
 * THIS IS A STRUCTURAL CHECK, NOT A CALIBRATION. Nothing here looks at the 56 pairs, at OSRM, or
 * at any divergence number. It asks only whether the stated judgement in `config/city.ts` is
 * internally consistent with the thing it claims to fix. `npm run experiment:objective` answers
 * the separate question of what the weights do to real routes.
 */
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../packages/pipeline/graph/build.ts';
import { buildTurnTable } from '../../packages/pipeline/graph/restrictions.ts';
import { Router } from '../../packages/engine/dijkstra.ts';
import { IdMap } from '../../packages/pipeline/clip/idset.ts';
import { OBJECTIVE } from '../../config/city.ts';
import { CLASS_RANK, CLASS_SPEED_KMH } from '../../packages/pipeline/graph/profile.ts';
import type { ObjectiveConfig } from '../../packages/shared/index.ts';
import type { Clipped, ClipStats, ClippedWay } from '../../packages/pipeline/clip/clip.ts';

const SCALE = 1e7;
const QUALITY = OBJECTIVE.qualityByRank;

/** Seconds to cover one km at this class's default speed. The `t` in the invariant above. */
const secPerKm = (cls: string): number => 3600 / (CLASS_SPEED_KMH[cls] as number);
/** Effective seconds per km once the weighted distance preference is added. The `c`. */
const effective = (cls: string): number =>
  secPerKm(cls) + OBJECTIVE.secondsPerKm * (QUALITY[CLASS_RANK[cls] as number] as number);

/**
 * One representative class per rank, biggest road first.
 *
 * LINKS ARE DELIBERATELY EXCLUDED from the ordering tests, and the reason is not convenience. A
 * `*_link` ranks WITH its parent by design, so that leaving a motorway by the only means a
 * motorway provides is not charged as a demotion. But a `motorway_link` defaults to 45 km/h while
 * a `primary` defaults to 50, so once links are included, rank order and speed order genuinely
 * disagree and no per-rank weight can satisfy the invariant across both. That is accepted: a link
 * is a short connector, not an alternative corridor, and the separate test below asserts the thing
 * that would actually be a bug, which is a link becoming cheaper to drive than the road it serves.
 */
const BY_RANK = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service'];

describe('the road quality weights', () => {
  it('has exactly one weight per class rank, all non-negative', () => {
    const ranks = new Set(Object.values(CLASS_RANK));
    expect(QUALITY).toHaveLength(ranks.size);
    for (const q of QUALITY) expect(q).toBeGreaterThanOrEqual(0);
  });

  it('states the exchange rate about a NEUTRAL class, so the sentence has one number in it', () => {
    // The preference reads "a minute is worth 2.5 km on an ordinary road". That sentence is only
    // true if some class actually carries weight 1.0, and it must be the ordinary one.
    expect(QUALITY[CLASS_RANK['tertiary'] as number]).toBe(1);
  });

  it('NEVER COMPRESSES the hierarchy: quality over seconds-per-km never decreases down the ranks', () => {
    // The whole invariant, walked pair by pair. A failure names the two classes that broke it.
    for (let i = 0; i < BY_RANK.length; i++) {
      for (let j = i + 1; j < BY_RANK.length; j++) {
        const fast = BY_RANK[i] as string;
        const slow = BY_RANK[j] as string;
        // The representative classes must genuinely be ordered by speed, or the test is vacuous.
        expect(secPerKm(slow)).toBeGreaterThan(secPerKm(fast));

        const ratioTimeOnly = secPerKm(slow) / secPerKm(fast);
        const ratioWeighted = effective(slow) / effective(fast);
        expect(
          ratioWeighted,
          `${fast} to ${slow} compressed: ${ratioTimeOnly.toFixed(3)} became ${ratioWeighted.toFixed(3)}`,
        ).toBeGreaterThanOrEqual(ratioTimeOnly - 1e-9);
      }
    }
  });

  it('EXPANDS motorway against tertiary, the pair a flat rate compressed from 2.571 to 1.982', () => {
    const timeOnly = secPerKm('tertiary') / secPerKm('motorway');
    const weighted = effective('tertiary') / effective('motorway');
    expect(timeOnly).toBeCloseTo(2.571, 3);
    // The number that motivated the whole change. Strictly better than doing nothing, not merely
    // no worse, or the weights would be an elaborate way to reach zero.
    expect(weighted).toBeGreaterThan(timeOnly);
    expect(weighted).toBeGreaterThanOrEqual(2.671);
  });

  it('keeps effective cost per km monotone: a smaller road is never cheaper to drive', () => {
    for (let i = 1; i < BY_RANK.length; i++) {
      const prev = BY_RANK[i - 1] as string;
      const cur = BY_RANK[i] as string;
      expect(effective(cur), `${cur} cheaper than ${prev}`).toBeGreaterThan(effective(prev));
    }
  });

  it('never makes a link cheaper per km than the road it serves', () => {
    // The real risk from exempting links: a chain of slip roads becoming a cheap corridor.
    for (const link of Object.keys(CLASS_SPEED_KMH).filter((c) => c.endsWith('_link'))) {
      const parent = link.slice(0, -'_link'.length);
      expect(CLASS_RANK[link], `${link} must rank with ${parent}`).toBe(CLASS_RANK[parent]);
      expect(effective(link), `${link} cheaper than ${parent}`).toBeGreaterThan(effective(parent));
    }
  });

  it('WITHIN a rank the weight cannot separate two classes, and that limit is stated not hidden', () => {
    // `unclassified` and `road` share rank 5; `living_street` and `service` share rank 7. They get
    // the same weight by construction, so a speed difference inside a rank IS still compressed.
    // Keying on class rather than on speed is deliberate: a residential street posted at 60 is
    // still a residential street. This test exists so the limitation is visible in the suite
    // rather than discovered later as a surprise.
    expect(CLASS_RANK['unclassified']).toBe(CLASS_RANK['road']);
    expect(CLASS_RANK['living_street']).toBe(CLASS_RANK['service']);
    const sameRankCompresses = effective('road') / effective('unclassified') < secPerKm('road') / secPerKm('unclassified');
    expect(sameRankCompresses).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Does the router actually behave differently? Toy graph, one variable at a time.
// ---------------------------------------------------------------------------

const EMPTY_STATS: ClipStats = {
  perFile: [], nodesInAreaSummed: 0, nodesInAreaUnion: 0, seamOverlapNodes: 0,
  duplicates: { nodes: 0, ways: 0, relations: 0 },
  sampleDuplicateWayIds: [], sampleDuplicateNodeIds: [],
  keptNodes: 0, keptWays: 0, keptWaysWithHighway: 0, keptRelations: 0, keptRestrictions: 0,
  relationsOutsideArea: 0, nestedRelationMembers: 0, extraNodesForCompleteWays: 0,
  pass1Seconds: 0, pass2Seconds: 0, writeSeconds: 0, peakRssBytes: 0, cacheBytes: 0,
};

interface N { id: number; lat: number; lon: number }
interface W { id: number; refs: number[]; tags: Record<string, string> }

function build(nodes: readonly N[], ways: readonly W[]) {
  const nodeIndex = new IdMap(1024);
  const nodeIds = new Float64Array(nodes.length);
  const nodeLat = new Int32Array(nodes.length);
  const nodeLon = new Int32Array(nodes.length);
  nodes.forEach((nd, i) => {
    nodeIndex.set(nd.id, i);
    nodeIds[i] = nd.id;
    nodeLat[i] = Math.round(nd.lat * SCALE);
    nodeLon[i] = Math.round(nd.lon * SCALE);
  });
  const built: ClippedWay[] = ways.map((w) => ({ id: w.id, refs: w.refs, tags: new Map(Object.entries(w.tags)) }));
  const clipped: Clipped = {
    nodeIds, nodeLat, nodeLon, nodeTags: new Map(), ways: built, relations: [], stats: EMPTY_STATS, nodeIndex,
  };
  const graph = buildGraph(clipped);
  const vertexOfNodeId = new Map<number, number>();
  for (let v = 0; v < graph.vertexNodeId.length; v++) vertexOfNodeId.set(graph.vertexNodeId[v] as number, v);
  const turns = buildTurnTable(graph, [], vertexOfNodeId, clipped);
  return { graph, turns, vertexOfNodeId };
}

function edgeOf(
  graph: ReturnType<typeof buildGraph>,
  vertexOfNodeId: Map<number, number>,
  wayId: number,
  fromNode: number,
  toNode: number,
): number {
  const a = vertexOfNodeId.get(fromNode);
  const b = vertexOfNodeId.get(toNode);
  for (let e = 0; e < graph.edgeWayId.length; e++) {
    if ((graph.edgeWayId[e] as number) !== wayId) continue;
    if ((graph.edgeFrom[e] as number) === a && (graph.edgeTo[e] as number) === b) return e;
  }
  throw new Error(`no edge on way ${wayId} from ${fromNode} to ${toNode}`);
}

const NO_PREF: ObjectiveConfig = { secondsPerKm: 0, secondsPerRupee: 0, avoidTollsByDefault: false };

const APPROACH = 10;
const EXIT = 20;
const ROUGH = 100;
const SMOOTH = 200;

/**
 * A short ROUGH road against a longer SMOOTH one, at IDENTICAL speed.
 *
 * The equal `maxspeed` is what makes this a test of quality and nothing else. With speeds equal,
 * drive time is proportional to length, so the short road wins on time AND on any flat distance
 * preference. Only a per-class weight can flip it, which means a flip here cannot come from
 * anywhere else in the objective.
 */
function roughVsSmooth() {
  return build(
    [
      { id: 5, lat: 28.495, lon: 77.500 },
      { id: 1, lat: 28.500, lon: 77.500 },
      { id: 2, lat: 28.550, lon: 77.500 },
      { id: 3, lat: 28.525, lon: 77.52135 },
      { id: 4, lat: 28.555, lon: 77.500 },
    ],
    [
      { id: APPROACH, refs: [5, 1], tags: { highway: 'trunk', maxspeed: '40' } },
      { id: EXIT, refs: [2, 4], tags: { highway: 'trunk', maxspeed: '40' } },
      { id: ROUGH, refs: [1, 2], tags: { highway: 'residential', maxspeed: '40' } },
      { id: SMOOTH, refs: [1, 3, 2], tags: { highway: 'trunk', maxspeed: '40' } },
    ],
  );
}

const waysOf = (graph: ReturnType<typeof buildGraph>, edges: readonly number[]): number[] =>
  edges.map((e) => graph.edgeWayId[e] as number);

describe('the router under road quality weights', () => {
  it('takes the longer SMOOTH road, where time alone and a flat rate both take the rough one', () => {
    const { graph, turns, vertexOfNodeId } = roughVsSmooth();
    const start = edgeOf(graph, vertexOfNodeId, APPROACH, 5, 1);
    const end = edgeOf(graph, vertexOfNodeId, EXIT, 2, 4);
    const rough = edgeOf(graph, vertexOfNodeId, ROUGH, 1, 2);
    const smooth = edgeOf(graph, vertexOfNodeId, SMOOTH, 1, 2);

    const lenRough = graph.edgeLengthM[rough] as number;
    const lenSmooth = graph.edgeLengthM[smooth] as number;
    // The setup must be the shape claimed: smooth is genuinely longer, and speeds are equal so
    // nothing but length and class can separate them.
    expect(lenSmooth).toBeGreaterThan(lenRough);
    expect(graph.edgeSpeedKmh[smooth]).toBe(graph.edgeSpeedKmh[rough]);

    // The window in which quality flips it, DERIVED from this graph rather than hardcoded.
    const t = 3600 / (graph.edgeSpeedKmh[rough] as number);
    const qRough = QUALITY[CLASS_RANK['residential'] as number] as number;
    const qSmooth = QUALITY[CLASS_RANK['trunk'] as number] as number;
    const flipsBelow = (t + OBJECTIVE.secondsPerKm * qRough) / (t + OBJECTIVE.secondsPerKm * qSmooth);
    expect(lenSmooth / lenRough).toBeLessThan(flipsBelow);

    const pick = (cfg: ObjectiveConfig): number => {
      const res = new Router(graph, turns, undefined, cfg).route(start, 0, end, 1);
      expect(res).not.toBeNull();
      const ways = waysOf(graph, (res as NonNullable<typeof res>).edges);
      return ways.includes(SMOOTH) ? SMOOTH : ROUGH;
    };

    // TWO POSITIVE CONTROLS. Without them, "the smooth road won" would also pass against a router
    // that simply could not find the short one.
    expect(pick(NO_PREF)).toBe(ROUGH);
    expect(pick({ ...NO_PREF, secondsPerKm: OBJECTIVE.secondsPerKm })).toBe(ROUGH);
    // Only with the weights does the smoother, longer road win.
    expect(pick(OBJECTIVE)).toBe(SMOOTH);
  });

  it('charges the weighted rate, not the flat one, and reports it as distanceSeconds', () => {
    const { graph, turns, vertexOfNodeId } = roughVsSmooth();
    // Node 3 is an INTERIOR shape point of way 200 and is therefore never a vertex, so the edge
    // runs 1 to 2. Vertices exist only at way endpoints and intersections.
    const start = edgeOf(graph, vertexOfNodeId, SMOOTH, 1, 2);
    const res = new Router(graph, turns, undefined, OBJECTIVE).route(start, 0, start, 1);
    expect(res).not.toBeNull();
    const x = res as NonNullable<typeof res>;
    const q = QUALITY[CLASS_RANK['trunk'] as number] as number;
    expect(x.distanceSeconds).toBeCloseTo((x.metres / 1000) * OBJECTIVE.secondsPerKm * q, 6);
    // And it is genuinely not the flat charge, or this test would pass with the weights ignored.
    expect(x.distanceSeconds).not.toBeCloseTo((x.metres / 1000) * OBJECTIVE.secondsPerKm, 6);
  });

  it('falls back to a flat rate when no weights are given, so toy graphs are unaffected', () => {
    const { graph, turns, vertexOfNodeId } = roughVsSmooth();
    // Node 3 is an INTERIOR shape point of way 200 and is therefore never a vertex, so the edge
    // runs 1 to 2. Vertices exist only at way endpoints and intersections.
    const start = edgeOf(graph, vertexOfNodeId, SMOOTH, 1, 2);
    const flat = { ...NO_PREF, secondsPerKm: 24 };
    const res = new Router(graph, turns, undefined, flat).route(start, 0, start, 1);
    expect(res).not.toBeNull();
    const x = res as NonNullable<typeof res>;
    expect(x.distanceSeconds).toBeCloseTo((x.metres / 1000) * 24, 6);
  });

  it('REFUSES a negative weight rather than silently breaking A* admissibility', () => {
    const { graph, turns } = roughVsSmooth();
    expect(
      () => new Router(graph, turns, undefined, { ...OBJECTIVE, qualityByRank: [0.3, -0.1, 1, 1, 1, 1, 1, 1] }),
    ).toThrow(/admissible/);
  });
});
