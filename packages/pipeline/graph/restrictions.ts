/**
 * Turn restrictions, resolved against the built graph into a via-node turn table.
 *
 * WHY A TURN TABLE AND NOT EDGE-BASED EXPANSION: full edge-based expansion makes every turn a
 * vertex, which multiplies the graph by average degree, for a city where restrictions are
 * demonstrably sparse (55 inside the build area). A via-node table plus incoming-edge tracking
 * in the search costs memory only where a restriction actually exists. The tradeoff is that the
 * search must carry which edge it arrived on, which is a real constraint on the router.
 *
 * NOTHING IS SILENTLY DROPPED, and the report distinguishes two very different things:
 *
 *   CORRECTLY IGNORED  the restriction does not apply to car routing at all, so not honouring
 *                      it cannot permit an illegal turn. A restriction on a footpath, or one
 *                      whose roads are not drivable, is in this class.
 *   NOT HONOURED       the restriction IS real for a car on drivable roads, and we failed to
 *                      apply it. Every one of these is a potentially permitted illegal turn,
 *                      which is charter item 7. These must be counted, listed, and driven to
 *                      zero or explicitly accepted with a reason.
 *
 * Collapsing those two into one "unresolved" number is what makes a legality gap invisible.
 */
import type { Graph } from './build.ts';
import type { Clipped, ClippedRelation } from '../clip/clip.ts';

/** `no_*` bans the listed turn. `only_*` bans every other turn from the same approach. */
const NO_TYPES = new Set([
  'no_left_turn', 'no_right_turn', 'no_straight_on', 'no_u_turn', 'no_entry', 'no_exit',
]);
const ONLY_TYPES = new Set(['only_left_turn', 'only_right_turn', 'only_straight_on', 'only_u_turn']);

export type Verdict = 'resolved' | 'correctly-ignored' | 'not-honoured';

export type FailureReason =
  | 'conditional'
  | 'unknown-restriction-value'
  | 'malformed-roles'
  | 'via-way-chain-unsupported'
  | 'via-node-outside-clip'
  | 'via-node-not-an-intersection'
  | 'via-node-dropped-by-scc'
  | 'member-way-outside-clip'
  | 'member-way-not-drivable'
  | 'member-way-dropped-by-scc'
  | 'member-way-wrong-direction-at-via';

export interface UnresolvedRestriction {
  readonly relationId: number;
  readonly kind: string;
  readonly reason: FailureReason;
  readonly verdict: Exclude<Verdict, 'resolved'>;
  /** Human-readable specifics: which member, and what was true of it. */
  readonly detail: string;
}

export interface RestrictionStats {
  readonly relationsSeen: number;
  readonly resolved: number;
  readonly bannedTurnPairs: number;
  /** Restrictions enforced as a (from, to) pair at a via node. */
  readonly enforcedByPair: number;
  /** Restrictions enforced as an ordered (from, via, to) triple across a via way. */
  readonly enforcedBySequence: number;
  readonly bannedSequenceTriples: number;
  readonly correctlyIgnored: number;
  /** Real restrictions on drivable roads that we failed to apply. Charter item 7. */
  readonly notHonoured: number;
  readonly byReason: Readonly<Record<string, number>>;
  readonly unresolved: readonly UnresolvedRestriction[];
  readonly exceptTagsSeen: number;
}

/** One banned ordered triple, keyed elsewhere by its middle (via) edge. */
export interface BannedSequence {
  readonly fromEdge: number;
  readonly toEdge: number;
}

export interface TurnTable {
  /**
   * Banned (fromEdge, toEdge) pairs for via-NODE restrictions, keyed by the incoming edge.
   * The search has that edge in hand when it reaches the vertex, so this is a single lookup.
   */
  readonly banned: ReadonlyMap<number, ReadonlySet<number>>;
  /**
   * Banned ordered triples for via-WAY restrictions, keyed by the MIDDLE edge.
   *
   * Keyed by the via edge rather than the from edge because that is the edge the search is
   * standing on when it must decide: relaxing out of edge `v`, it knows `v` and the candidate
   * `to`, and it can read its own predecessor to recover `from`. Keying by `from` would force a
   * lookahead the search does not have.
   */
  readonly bannedSequences: ReadonlyMap<number, readonly BannedSequence[]>;
  /**
   * 1 where an edge is a key in EITHER table. This is the hot-path guard: the search reads one
   * byte per expansion and only touches a Map when it is set. With 52 restricted edges out of
   * 532,951, the branch is predicted false essentially always, so restriction support costs one
   * array read per expansion rather than a Map lookup.
   */
  readonly edgeRestricted: Uint8Array;
  readonly stats: RestrictionStats;
}

export function buildTurnTable(
  graph: Graph,
  relations: readonly ClippedRelation[],
  vertexOfNodeId: ReadonlyMap<number, number>,
  clip: Clipped,
): TurnTable {
  const edgesOfWay = new Map<number, number[]>();
  for (let e = 0; e < graph.edgeWayId.length; e++) {
    const id = graph.edgeWayId[e] as number;
    const list = edgesOfWay.get(id);
    if (list) list.push(e);
    else edgesOfWay.set(id, [e]);
  }
  const clippedWayIds = new Set<number>();
  for (const w of clip.ways) clippedWayIds.add(w.id);

  const banned = new Map<number, Set<number>>();
  const ban = (from: number, to: number): boolean => {
    let set = banned.get(from);
    if (!set) {
      set = new Set();
      banned.set(from, set);
    }
    if (set.has(to)) return false;
    set.add(to);
    return true;
  };

  const bannedSequences = new Map<number, BannedSequence[]>();
  const banSeq = (fromEdge: number, viaEdge: number, toEdge: number): boolean => {
    const list = bannedSequences.get(viaEdge);
    if (list === undefined) {
      bannedSequences.set(viaEdge, [{ fromEdge, toEdge }]);
      return true;
    }
    if (list.some((s) => s.fromEdge === fromEdge && s.toEdge === toEdge)) return false;
    list.push({ fromEdge, toEdge });
    return true;
  };

  let relationsSeen = 0;
  let resolved = 0;
  let bannedTurnPairs = 0;
  let enforcedByPair = 0;
  let enforcedBySequence = 0;
  let bannedSequenceTriples = 0;
  let exceptTagsSeen = 0;
  const unresolved: UnresolvedRestriction[] = [];

  const fail = (
    relationId: number,
    kind: string,
    reason: FailureReason,
    verdict: Exclude<Verdict, 'resolved'>,
    detail: string,
  ): void => {
    unresolved.push({ relationId, kind, reason, verdict, detail });
  };

  /**
   * Why a member way produced no usable edges. The distinction matters: "not drivable" means
   * the restriction never applied to a car, while "dropped by SCC" means it did and we lost it.
   */
  const classifyWay = (wayId: number, role: string): { reason: FailureReason; verdict: Exclude<Verdict, 'resolved'>; detail: string } => {
    if (!clippedWayIds.has(wayId)) {
      return {
        reason: 'member-way-outside-clip',
        verdict: 'correctly-ignored',
        detail: `${role} way ${wayId} is not in the clip, so the restriction sits outside BUILD_AREA`,
      };
    }
    if (!graph.drivableWayIds.has(wayId)) {
      return {
        reason: 'member-way-not-drivable',
        verdict: 'correctly-ignored',
        detail: `${role} way ${wayId} is in the clip but failed the car profile, so no car can make this turn anyway`,
      };
    }
    if (!edgesOfWay.has(wayId)) {
      return {
        reason: 'member-way-dropped-by-scc',
        verdict: 'not-honoured',
        detail: `${role} way ${wayId} is drivable but every edge was pruned by largest-SCC filtering`,
      };
    }
    return {
      reason: 'member-way-wrong-direction-at-via',
      verdict: 'not-honoured',
      detail: `${role} way ${wayId} has edges but none ${role === 'from' ? 'arriving at' : 'leaving'} the via node`,
    };
  };

  for (const rel of relations) {
    if (rel.tags.get('type') !== 'restriction') continue;
    relationsSeen++;

    const kindRaw =
      rel.tags.get('restriction') ??
      rel.tags.get('restriction:motorcar') ??
      rel.tags.get('restriction:motor_vehicle') ??
      '';
    if (rel.tags.has('except')) exceptTagsSeen++;

    if (rel.tags.has('restriction:conditional') || kindRaw.includes('@')) {
      // Applying a time-qualified restriction as permanent would send a driver the long way at
      // 3am. Not honouring it is the deliberate choice, so it is correctly ignored rather than
      // lost, but it is still listed so the choice stays visible.
      fail(rel.id, kindRaw, 'conditional', 'correctly-ignored', 'time-qualified; honouring it as permanent would be wrong');
      continue;
    }
    if (kindRaw === '') {
      fail(rel.id, '(none)', 'malformed-roles', 'correctly-ignored', 'relation has no restriction value at all');
      continue;
    }
    const kind = kindRaw.trim();
    const isNo = NO_TYPES.has(kind);
    const isOnly = ONLY_TYPES.has(kind);
    if (!isNo && !isOnly) {
      fail(rel.id, kind, 'unknown-restriction-value', 'correctly-ignored', `restriction value "${kind}" is not a turn prohibition this profile understands`);
      continue;
    }

    let fromWay: number | undefined;
    let toWay: number | undefined;
    let viaNode: number | undefined;
    const viaWayRefs: number[] = [];
    for (const m of rel.members) {
      if (m.role === 'from' && m.type === 'way') fromWay = m.ref;
      else if (m.role === 'to' && m.type === 'way') toWay = m.ref;
      else if (m.role === 'via') {
        if (m.type === 'node') viaNode = m.ref;
        else if (m.type === 'way') viaWayRefs.push(m.ref);
      }
    }

    // ---- VIA-WAY: enforced as an ordered triple, not a pair ----
    if (viaWayRefs.length > 0 && viaNode === undefined) {
      if (fromWay === undefined || toWay === undefined) {
        fail(rel.id, kind, 'malformed-roles', 'correctly-ignored', 'via-way restriction missing a from or to way');
        continue;
      }
      // A chain of SEVERAL via ways needs a sequence longer than three edges, which the search
      // cannot check with one predecessor. None exist in this build area; counted rather than
      // quietly treated as a single-via case, which would ban the wrong turn.
      if (viaWayRefs.length > 1) {
        fail(rel.id, kind, 'via-way-chain-unsupported', 'not-honoured', `via is a chain of ${viaWayRefs.length} ways; only a single via way is supported`);
        continue;
      }
      const viaWay = viaWayRefs[0] as number;
      const viaCandidates = edgesOfWay.get(viaWay);
      if (viaCandidates === undefined) {
        const c = classifyWay(viaWay, 'via');
        fail(rel.id, kind, c.reason, c.verdict, c.detail);
        continue;
      }
      const fromCand = edgesOfWay.get(fromWay);
      if (fromCand === undefined) {
        const c = classifyWay(fromWay, 'from');
        fail(rel.id, kind, c.reason, c.verdict, c.detail);
        continue;
      }
      const toCand = edgesOfWay.get(toWay);
      if (toCand === undefined) {
        const c = classifyWay(toWay, 'to');
        fail(rel.id, kind, c.reason, c.verdict, c.detail);
        continue;
      }

      // A via way is bidirectional in the graph, so it yields two directed edges. Only the one
      // whose direction actually links a from-arrival to a to-departure is the manoeuvre being
      // banned; banning both would forbid the legal traversal in the opposite direction.
      let added = 0;
      for (const ve of viaCandidates) {
        const v1 = graph.edgeFrom[ve] as number;
        const v2 = graph.edgeTo[ve] as number;
        const arriving = fromCand.filter((e) => (graph.edgeTo[e] as number) === v1);
        if (arriving.length === 0) continue;
        if (isNo) {
          const leaving = toCand.filter((e) => (graph.edgeFrom[e] as number) === v2);
          for (const a of arriving) {
            for (const l of leaving) if (banSeq(a, ve, l)) added++;
          }
        } else {
          // only_*: from this approach, across this via way, everything leaving the far end is
          // banned except the permitted way.
          const allowed = new Set(toCand.filter((e) => (graph.edgeFrom[e] as number) === v2));
          const start = graph.csrOffset[v2] as number;
          const end = graph.csrOffset[v2 + 1] as number;
          for (const a of arriving) {
            for (let i = start; i < end; i++) {
              const t = graph.csrEdge[i] as number;
              if (allowed.has(t)) continue;
              if ((graph.edgeWayId[t] as number) === viaWay) continue; // reversing along the via way
              if (banSeq(a, ve, t)) added++;
            }
          }
        }
      }
      if (added === 0) {
        fail(rel.id, kind, 'member-way-wrong-direction-at-via', 'not-honoured', `no directed traversal of via way ${viaWay} links from ${fromWay} to ${toWay}`);
        continue;
      }
      resolved++;
      enforcedBySequence++;
      bannedSequenceTriples += added;
      continue;
    }

    if (fromWay === undefined || toWay === undefined || viaNode === undefined) {
      const missing = [
        fromWay === undefined ? 'from' : null,
        viaNode === undefined ? 'via' : null,
        toWay === undefined ? 'to' : null,
      ].filter(Boolean).join(', ');
      fail(rel.id, kind, 'malformed-roles', 'correctly-ignored', `missing or wrongly typed role(s): ${missing}`);
      continue;
    }

    const viaVertex = vertexOfNodeId.get(viaNode);
    if (viaVertex === undefined) {
      if (clip.nodeIndex.get(viaNode) < 0) {
        fail(rel.id, kind, 'via-node-outside-clip', 'correctly-ignored', `via node ${viaNode} is not in the clip`);
      } else if (!graph.vertexNodeIdsBeforeScc.has(viaNode)) {
        fail(rel.id, kind, 'via-node-not-an-intersection', 'correctly-ignored', `via node ${viaNode} is in the clip but is not an endpoint or intersection of any drivable way`);
      } else {
        fail(rel.id, kind, 'via-node-dropped-by-scc', 'not-honoured', `via node ${viaNode} was a vertex but its component was pruned by SCC filtering`);
      }
      continue;
    }

    const fromEdges = edgesOfWay.get(fromWay);
    const toEdges = edgesOfWay.get(toWay);
    if (!fromEdges) {
      const c = classifyWay(fromWay, 'from');
      fail(rel.id, kind, c.reason, c.verdict, c.detail);
      continue;
    }
    if (!toEdges) {
      const c = classifyWay(toWay, 'to');
      fail(rel.id, kind, c.reason, c.verdict, c.detail);
      continue;
    }

    // Direction matters: an edge of the from way that LEAVES the via vertex is the wrong one,
    // and banning it would forbid a legal turn.
    const arriving = fromEdges.filter((e) => (graph.edgeTo[e] as number) === viaVertex);
    const leaving = toEdges.filter((e) => (graph.edgeFrom[e] as number) === viaVertex);
    if (arriving.length === 0) {
      fail(rel.id, kind, 'member-way-wrong-direction-at-via', 'not-honoured', `from way ${fromWay} has edges but none arriving at via node ${viaNode}`);
      continue;
    }
    if (leaving.length === 0) {
      fail(rel.id, kind, 'member-way-wrong-direction-at-via', 'not-honoured', `to way ${toWay} has edges but none leaving via node ${viaNode}`);
      continue;
    }

    let added = 0;
    if (isNo) {
      for (const f of arriving) {
        for (const t of leaving) if (ban(f, t)) added++;
      }
    } else {
      // only_*: everything leaving the via vertex is banned from this approach except the
      // permitted way. The U-turn back onto the from way is left alone; OSM models that with a
      // separate no_u_turn, and inferring it here would ban legal manoeuvres.
      const allowed = new Set(leaving);
      const start = graph.csrOffset[viaVertex] as number;
      const end = graph.csrOffset[viaVertex + 1] as number;
      for (const f of arriving) {
        for (let i = start; i < end; i++) {
          const t = graph.csrEdge[i] as number;
          if (allowed.has(t)) continue;
          if ((graph.edgeWayId[t] as number) === fromWay) continue;
          if (ban(f, t)) added++;
        }
      }
    }
    resolved++;
    enforcedByPair++;
    bannedTurnPairs += added;
  }

  // Hot-path guard, built once. An edge is flagged if it is a key in either table, so the search
  // does one array read per expansion and only touches a Map when it hits.
  const edgeRestricted = new Uint8Array(graph.edgeWayId.length);
  for (const e of banned.keys()) edgeRestricted[e] = 1;
  for (const e of bannedSequences.keys()) edgeRestricted[e] = 1;

  const byReason: Record<string, number> = {};
  for (const u of unresolved) byReason[u.reason] = (byReason[u.reason] ?? 0) + 1;

  return {
    banned,
    bannedSequences,
    edgeRestricted,
    stats: {
      relationsSeen,
      resolved,
      bannedTurnPairs,
      enforcedByPair,
      enforcedBySequence,
      bannedSequenceTriples,
      correctlyIgnored: unresolved.filter((u) => u.verdict === 'correctly-ignored').length,
      notHonoured: unresolved.filter((u) => u.verdict === 'not-honoured').length,
      byReason,
      unresolved,
      exceptTagsSeen,
    },
  };
}
