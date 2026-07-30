/**
 * Turn restrictions, resolved against the built graph into a via-node turn table.
 *
 * WHY A TURN TABLE AND NOT EDGE-BASED EXPANSION: full edge-based expansion makes every turn a
 * vertex, which multiplies the graph by average degree, for a city where restrictions are
 * demonstrably sparse (365 `type=restriction` relations across BOTH entire zone extracts,
 * before clipping). A via-node table plus incoming-edge tracking in the search costs memory
 * only where a restriction actually exists. The tradeoff is that the search must carry which
 * edge it arrived on, which is a real constraint on the router and is why it is written here.
 *
 * NOTHING IS SILENTLY DROPPED. Every relation that cannot be resolved is counted by reason.
 * A restriction quietly discarded is an illegal turn the router will happily take, and it will
 * look like a routing bug months later rather than a data-handling one here.
 */
import type { Graph } from './build.ts';
import type { ClippedRelation } from '../clip/clip.ts';

/** `no_*` bans the listed turn. `only_*` bans every other turn from the same approach. */
const NO_TYPES = new Set([
  'no_left_turn', 'no_right_turn', 'no_straight_on', 'no_u_turn', 'no_entry', 'no_exit',
]);
const ONLY_TYPES = new Set(['only_left_turn', 'only_right_turn', 'only_straight_on', 'only_u_turn']);

export interface RestrictionStats {
  readonly relationsSeen: number;
  readonly resolved: number;
  readonly bannedTurnPairs: number;
  /** Counted, never ignored. Each is a restriction the router will not be able to honour. */
  readonly unresolved: {
    readonly viaWayUnsupported: number;
    readonly missingRole: number;
    readonly unknownRestrictionValue: number;
    readonly viaNodeNotAVertex: number;
    readonly fromWayNotInGraph: number;
    readonly toWayNotInGraph: number;
    readonly conditionalIgnored: number;
  };
  readonly exceptTagsSeen: number;
}

export interface TurnTable {
  /**
   * Banned (fromEdge, toEdge) pairs. Keyed by the incoming edge, because that is what the
   * search has in hand when it reaches a vertex.
   */
  readonly banned: ReadonlyMap<number, ReadonlySet<number>>;
  readonly stats: RestrictionStats;
}

export function buildTurnTable(
  graph: Graph,
  relations: readonly ClippedRelation[],
  vertexOfNodeId: ReadonlyMap<number, number>,
): TurnTable {
  // wayId to its directed edges. One way yields many edges once split at intersections.
  const edgesOfWay = new Map<number, number[]>();
  for (let e = 0; e < graph.edgeWayId.length; e++) {
    const id = graph.edgeWayId[e] as number;
    const list = edgesOfWay.get(id);
    if (list) list.push(e);
    else edgesOfWay.set(id, [e]);
  }

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

  let relationsSeen = 0;
  let resolved = 0;
  let bannedTurnPairs = 0;
  let exceptTagsSeen = 0;
  const unresolved = {
    viaWayUnsupported: 0,
    missingRole: 0,
    unknownRestrictionValue: 0,
    viaNodeNotAVertex: 0,
    fromWayNotInGraph: 0,
    toWayNotInGraph: 0,
    conditionalIgnored: 0,
  };

  for (const rel of relations) {
    if (rel.tags.get('type') !== 'restriction') continue;
    relationsSeen++;

    // `restriction:conditional` and time-qualified variants are not honoured. Counted rather
    // than applied, because applying a time restriction as if it were permanent would send a
    // driver the long way round at 3am, and ignoring it silently would hide that choice.
    if (rel.tags.has('restriction:conditional')) {
      unresolved.conditionalIgnored++;
      continue;
    }
    if (rel.tags.has('except')) exceptTagsSeen++;

    const kind =
      rel.tags.get('restriction') ??
      rel.tags.get('restriction:motorcar') ??
      rel.tags.get('restriction:motor_vehicle');
    if (kind === undefined) {
      unresolved.missingRole++;
      continue;
    }
    // A value may be qualified, e.g. "no_left_turn @ (Mo-Fr 07:00-10:00)". Take the head and
    // treat the qualifier as a conditional, which is not honoured.
    const head = (kind.split('@')[0] ?? '').trim();
    const isNo = NO_TYPES.has(head);
    const isOnly = ONLY_TYPES.has(head);
    if (!isNo && !isOnly) {
      unresolved.unknownRestrictionValue++;
      continue;
    }
    if (kind.includes('@')) {
      unresolved.conditionalIgnored++;
      continue;
    }

    let fromWay: number | undefined;
    let toWay: number | undefined;
    let viaNode: number | undefined;
    let viaWayCount = 0;
    for (const m of rel.members) {
      if (m.role === 'from' && m.type === 'way') fromWay = m.ref;
      else if (m.role === 'to' && m.type === 'way') toWay = m.ref;
      else if (m.role === 'via') {
        if (m.type === 'node') viaNode = m.ref;
        else if (m.type === 'way') viaWayCount++;
      }
    }

    if (viaWayCount > 0 && viaNode === undefined) {
      unresolved.viaWayUnsupported++;
      continue;
    }
    if (fromWay === undefined || toWay === undefined || viaNode === undefined) {
      unresolved.missingRole++;
      continue;
    }

    const viaVertex = vertexOfNodeId.get(viaNode);
    if (viaVertex === undefined) {
      // The via node is not a vertex in the largest SCC. Either it fell outside the area, or
      // it is on a way that is not drivable, or it was pruned by SCC filtering.
      unresolved.viaNodeNotAVertex++;
      continue;
    }

    const fromCandidates = edgesOfWay.get(fromWay);
    if (!fromCandidates) {
      unresolved.fromWayNotInGraph++;
      continue;
    }
    const toCandidates = edgesOfWay.get(toWay);
    if (!toCandidates) {
      unresolved.toWayNotInGraph++;
      continue;
    }

    // The restriction applies to edges that ARRIVE at the via vertex from the "from" way, and
    // edges that LEAVE it along the "to" way. Direction matters: an edge of the from way that
    // leaves the vertex is the wrong one, and banning it would forbid a legal turn.
    const arriving = fromCandidates.filter((e) => (graph.edgeTo[e] as number) === viaVertex);
    const leaving = toCandidates.filter((e) => (graph.edgeFrom[e] as number) === viaVertex);
    if (arriving.length === 0) {
      unresolved.fromWayNotInGraph++;
      continue;
    }
    if (leaving.length === 0) {
      unresolved.toWayNotInGraph++;
      continue;
    }

    let added = 0;
    if (isNo) {
      for (const f of arriving) {
        for (const t of leaving) {
          if (ban(f, t)) added++;
        }
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

    if (added > 0) {
      resolved++;
      bannedTurnPairs += added;
    } else {
      // Every candidate pair was already banned by another relation. Duplicated tagging is
      // common in OSM and is not a failure, but it must not be counted as a new resolution.
      resolved++;
    }
  }

  return {
    banned,
    stats: {
      relationsSeen,
      resolved,
      bannedTurnPairs,
      unresolved,
      exceptTagsSeen,
    },
  };
}
