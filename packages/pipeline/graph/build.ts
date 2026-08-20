/**
 * Builds the routing graph from the clipped subset: vertices, directed edges, CSR adjacency,
 * and largest-SCC filtering.
 *
 * VERTICES EXIST ONLY AT WAY ENDPOINTS AND INTERSECTIONS. Intermediate shape points live in
 * packed edge geometry and are never vertices. This is what makes charter item 1 (the route
 * line lies exactly on the drawn road) structural rather than something the renderer has to
 * remember, and it is also the reason the vertex count is far below the node count. The
 * CH-relevant number is vertices after SCC filtering, which is what this reports.
 *
 * SCC is iterative Tarjan, not recursive. At this scale a recursive implementation overflows
 * the stack, and it does so on the largest component, which is exactly the input that matters.
 */
import { haversineM } from '../../shared/geo.ts';
import { attributeTollRamps, classifyWay, tollGateKindOf, tollRoadOf } from './profile.ts';
import { computeEpeChainage, epeSegmentOf } from './epe.ts';
import { EPE_SEGMENT_NONE, NAME_NONE } from '../../shared/graphfile.ts';
import { TOLL_ROADS } from '../../../config/city.ts';
import type { Clipped } from '../clip/clip.ts';

const COORD_SCALE = 1e7;

export interface GraphStats {
  readonly clippedNodes: number;
  readonly clippedWays: number;
  readonly drivableWays: number;
  readonly waysSkippedNotDrivable: number;
  readonly waysSkippedTooShort: number;
  /** Way refs pointing at a node absent from the clip. Real in OSM near extract boundaries. */
  readonly missingNodeRefs: number;
  readonly waysWithMissingRefs: number;
  readonly verticesBeforeScc: number;
  readonly edgesBeforeScc: number;
  readonly verticesAfterScc: number;
  readonly edgesAfterScc: number;
  readonly sccCount: number;
  readonly largestSccShare: number;
  readonly shapePoints: number;
  readonly onewayEdges: number;
  readonly bidirectionalWays: number;
  readonly speedFromTag: number;
  readonly speedFromClassDefault: number;
  readonly privateAccessWays: number;
  readonly totalLengthKm: number;
  readonly buildSeconds: number;
  readonly peakRssBytes: number;
}

export interface Graph {
  /** Vertex coordinates, degrees. */
  readonly vertexLat: Float64Array;
  readonly vertexLon: Float64Array;
  /** OSM node id per vertex, kept so spot checks can be traced back to raw OSM. */
  readonly vertexNodeId: Float64Array;

  /** CSR adjacency: outgoing edge indices for vertex v are csrEdge[csrOffset[v]..[v+1]]. */
  readonly csrOffset: Int32Array;
  readonly csrEdge: Int32Array;

  readonly edgeFrom: Int32Array;
  readonly edgeTo: Int32Array;
  readonly edgeLengthM: Float64Array;
  readonly edgeSpeedKmh: Uint8Array;
  readonly edgeWayId: Float64Array;
  /** Index into the shape table. Two directed edges of one segment share a shape. */
  readonly edgeShape: Int32Array;
  /** 1 when the edge traverses its shape in reverse. */
  readonly edgeReversed: Uint8Array;
  /** 1 when the underlying way is access=private. Routable, but only as a last resort. */
  readonly edgePrivate: Uint8Array;
  /** `CLASS_RANK` of the underlying way. 0 is the biggest road. Read only by the turn cost model. */
  readonly edgeClassRank: Uint8Array;
  /** 1 when the underlying way charges a toll. Priced by the objective, never by the graph. */
  readonly edgeToll: Uint8Array;
  /**
   * WHICH toll road charges this edge, as an id into `TOLL_ROADS`, 0 for none. The graph records
   * which road, never how much: mechanisms, rates and confidence live in `config/city.ts`.
   */
  readonly edgeTollRoad: Uint8Array;
  /**
   * What kind of toll point this edge CONTAINS: 0 none, 1 a mainline barrier, 2 a ramp booth.
   * See `tollGateKindOf`. Both kinds are marked, and they bill differently.
   */
  readonly edgeTollGate: Uint8Array;

  /**
   * For a closed-system road, which inter-plaza span this edge lies in; 255 when not applicable.
   *
   * `s` means "between plaza s and plaza s+1" in `EPE_PLAZAS` order. A route occupying spans a..b
   * entered at plaza a and left at plaza b+1, which is the pair the fare matrix is indexed by. This
   * is what lets an entry-exit fare be priced from the graph without the engine knowing what a
   * plaza is.
   */
  readonly edgeTollSegment: Uint8Array;

  /**
   * Index into `roadNames`, or `NAME_NONE` when the way has no usable name.
   *
   * INTERNED, not stored per edge, because names repeat enormously: one arterial is hundreds of
   * edges carrying one string. Stored at all because turn-by-turn cannot be derived without it and
   * a name is a FACT about the road, so it belongs here rather than being fetched separately and
   * risking a second copy that disagrees.
   */
  readonly edgeNameId: Int32Array;

  /**
   * 1 when the underlying way is `junction=roundabout` or `junction=circular`.
   *
   * Needed because "take the third exit" is a statement about the circle, not about any one turn:
   * the exit has to be COUNTED while traversing, and nothing else in the artifact identifies which
   * edges form the circle. The same tag already implies a one-way in `classifyWay`, so this stores
   * a fact the build has and the engine otherwise cannot recover.
   */
  readonly edgeRoundabout: Uint8Array;

  /** The interned name table. `edgeNameId` indexes it. */
  readonly roadNames: readonly string[];

  /** Packed shape points, scaled by 1e7. Shape s spans shapeOffset[s]..shapeOffset[s+1]. */
  readonly shapeOffset: Int32Array;
  readonly shapeLat: Int32Array;
  readonly shapeLon: Int32Array;

  /**
   * Way ids that passed the profile filter, BEFORE SCC pruning. Kept so an unresolved turn
   * restriction can be told apart: a member way absent here was never drivable, while one
   * present here but with no surviving edges was dropped by SCC filtering. Those are different
   * findings and only one of them is benign.
   */
  readonly drivableWayIds: ReadonlySet<number>;
  /** Node ids that became vertices before SCC pruning, for the same diagnostic reason. */
  readonly vertexNodeIdsBeforeScc: ReadonlySet<number>;

  readonly stats: GraphStats;
}

type Progress = (message: string) => void;

export function buildGraph(clipped: Clipped, log: Progress = () => {}): Graph {
  const t0 = performance.now();
  let peakRss = 0;
  const sampleRss = (): void => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  };

  const nodeCount = clipped.nodeIds.length;
  const { nodeIndex, nodeLat, nodeLon, nodeIds } = clipped;

  // ---- Pass A: classify ways, count node usage, find vertices ----
  const useCount = new Int32Array(nodeCount);
  const isVertex = new Uint8Array(nodeCount);

  interface Kept {
    readonly wayIndex: number;
    readonly idx: Int32Array; // dense node indices, gaps already removed
    readonly speedKmh: number;
    readonly classRank: number;
    readonly toll: boolean;
    /** Filled by the toll attribution pass below, once every named road's nodes are known. */
    tollRoad: number;
    readonly highway: string;
    readonly forward: boolean;
    readonly backward: boolean;
    readonly isPrivate: boolean;
    readonly nameId: number;
    readonly roundabout: boolean;
  }
  const kept: Kept[] = [];

  /**
   * The name intern table, built as ways are kept.
   *
   * `name` first, then `ref`. A driver is told "turn onto Vikas Marg" if the road has a name and
   * "join NH334DD" if all it has is a number, and a numbered road with no name is common here. An
   * empty string is not a name and never enters the table, or unnamed edges would all share index 0
   * and read as a road actually called "".
   */
  const roadNames: string[] = [];
  const nameIdOf = new Map<string, number>();
  const internName = (tags: ReadonlyMap<string, string>): number => {
    const raw = tags.get('name') ?? tags.get('ref') ?? '';
    // OSM joins multiple values with a semicolon, so a road carrying two national numbers is tagged
    // `NH34;NH334C`. That is a data encoding, not a name, and it reached the turn-by-turn list as
    // "Continue onto NH34;NH334C". Only two names in the whole table carry it, which is exactly why
    // it would have survived review: it is rare enough to miss and user-facing when it appears.
    // The first value is what a sign leads with.
    const n = (raw.split(';')[0] ?? '').trim();
    if (n === '') return NAME_NONE;
    const seen = nameIdOf.get(n);
    if (seen !== undefined) return seen;
    const id = roadNames.length;
    roadNames.push(n);
    nameIdOf.set(n, id);
    return id;
  };

  let waysSkippedNotDrivable = 0;
  let waysSkippedTooShort = 0;
  let missingNodeRefs = 0;
  let waysWithMissingRefs = 0;
  let speedFromTag = 0;
  let speedFromClassDefault = 0;
  let privateAccessWays = 0;
  let bidirectionalWays = 0;

  for (let w = 0; w < clipped.ways.length; w++) {
    const way = clipped.ways[w] as (typeof clipped.ways)[number];
    const cls = classifyWay(way.tags);
    if (!cls.drivable) {
      waysSkippedNotDrivable++;
      continue;
    }

    // Resolve refs to dense indices, dropping refs absent from the clip. A gap does not
    // discard the way: OSM extracts genuinely have dangling refs near their own boundary, and
    // discarding the whole road would sever a corridor that is otherwise complete.
    const resolved: number[] = [];
    let hadMissing = false;
    for (const ref of way.refs) {
      const i = nodeIndex.get(ref);
      if (i < 0) {
        missingNodeRefs++;
        hadMissing = true;
        continue;
      }
      // Consecutive duplicate refs contribute no length and would create zero-length edges.
      if (resolved.length > 0 && resolved[resolved.length - 1] === i) continue;
      resolved.push(i);
    }
    if (hadMissing) waysWithMissingRefs++;
    if (resolved.length < 2) {
      waysSkippedTooShort++;
      continue;
    }

    if (cls.speedTagged) speedFromTag++;
    else speedFromClassDefault++;
    if (cls.access === 'private') privateAccessWays++;
    if (cls.forward && cls.backward) bidirectionalWays++;

    const idx = new Int32Array(resolved);
    kept.push({
      wayIndex: w,
      idx,
      speedKmh: Math.max(1, Math.min(255, Math.round(cls.speedKmh))),
      classRank: cls.classRank,
      toll: cls.toll,
      tollRoad: 0, // resolved after this pass, once every named toll road's nodes are known
      highway: way.tags.get('highway') ?? '',
      forward: cls.forward,
      backward: cls.backward,
      isPrivate: cls.access === 'private',
      nameId: internName(way.tags),
      roundabout: cls.roundabout,
    });

    // Endpoints are always vertices. Interior nodes become vertices when a second way uses
    // them, or when this way visits them twice (a closed loop or a self-touching way).
    isVertex[idx[0] as number] = 1;
    isVertex[idx[idx.length - 1] as number] = 1;
    const seenHere = new Set<number>();
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k] as number;
      useCount[i] = (useCount[i] as number) + 1;
      if (seenHere.has(i)) isVertex[i] = 1;
      else seenHere.add(i);
    }
  }
  sampleRss();
  log(`  classified ${clipped.ways.length.toLocaleString('en-US')} ways, ${kept.length.toLocaleString('en-US')} drivable`);

  // ---- Toll attribution: which road charges each way, ramps resolved by geometry ----
  //
  // Two steps, and the order matters. Names first, so every named toll road's node set is complete;
  // then geometry, so an unnamed ramp can be recognised as belonging to the road it joins. Doing it
  // the other way round would let a ramp claim a road that had not been seen yet.
  const unpricedId = TOLL_ROADS.find((r) => r.key === 'unpriced')?.id ?? 0;
  const byName = new Map<number, number>();
  for (const k of kept) {
    const way = clipped.ways[k.wayIndex] as (typeof clipped.ways)[number];
    byName.set(way.id, tollRoadOf(way.id, way.tags));
  }
  const ramps = attributeTollRamps(clipped.ways, byName, unpricedId);
  let tolledWays = 0;
  for (const k of kept) {
    const way = clipped.ways[k.wayIndex] as (typeof clipped.ways)[number];
    k.tollRoad = ramps.reassigned.get(way.id) ?? byName.get(way.id) ?? 0;
    if (k.tollRoad !== 0) tolledWays++;
  }
  {
    const per = new Map<number, number>();
    for (const [, road] of ramps.reassigned) per.set(road, (per.get(road) ?? 0) + 1);
    const summary = [...per]
      .map(([road, n]) => `${TOLL_ROADS.find((r) => r.id === road)?.key ?? road} ${n}`)
      .join(', ');
    const stillUnpriced = kept.filter((k) => k.tollRoad === unpricedId).length;
    log(
      `  toll ways: ${tolledWays.toLocaleString('en-US')}; ${ramps.reassigned.size} unnamed ramp way(s) ` +
        `attached by geometry in ${ramps.rounds} round(s)${summary === '' ? '' : ` (${summary})`}; ` +
        `${stillUnpriced} way(s) remain unpriced`,
    );
  }

  // ---- EPE chainage, so a closed-system fare can be looked up by entry and exit plaza ----
  const epe = computeEpeChainage(clipped);
  log(
    `  EPE mainline: ${epe.runKm.length} carriageway(s), longest ${(epe.runKm[0] ?? 0).toFixed(3)} km, ` +
      `${epe.chainageKmOf.size} node(s) with chainage${epe.usable ? '' : ' (TOO SHORT, spans not assigned)'}`,
  );

  for (let i = 0; i < nodeCount; i++) {
    if ((useCount[i] as number) >= 2) isVertex[i] = 1;
  }

  // Dense vertex numbering.
  const vertexOf = new Int32Array(nodeCount).fill(-1);
  let vCount = 0;
  for (let i = 0; i < nodeCount; i++) {
    if (isVertex[i] === 1) vertexOf[i] = vCount++;
  }
  log(`  vertices before SCC: ${vCount.toLocaleString('en-US')} of ${nodeCount.toLocaleString('en-US')} clipped nodes`);
  sampleRss();

  // ---- Pass B: split ways at vertices into edges, packing shape geometry ----
  const edgeFrom: number[] = [];
  const edgeTo: number[] = [];
  const edgeLengthM: number[] = [];
  const edgeSpeedKmh: number[] = [];
  const edgeWayId: number[] = [];
  const edgeShape: number[] = [];
  const edgeReversed: number[] = [];
  const edgePrivate: number[] = [];
  const edgeClassRank: number[] = [];
  const edgeToll: number[] = [];
  const edgeTollRoad: number[] = [];
  const edgeTollGate: number[] = [];
  const edgeTollSegment: number[] = [];
  const edgeNameId: number[] = [];
  const edgeRoundabout: number[] = [];

  const shapeOffset: number[] = [0];
  const shapeLat: number[] = [];
  const shapeLon: number[] = [];

  let onewayEdges = 0;
  let totalLengthM = 0;

  for (const k of kept) {
    const way = clipped.ways[k.wayIndex] as (typeof clipped.ways)[number];
    let segStart = 0;
    for (let p = 1; p < k.idx.length; p++) {
      const nodeI = k.idx[p] as number;
      const isEnd = p === k.idx.length - 1;
      if (isVertex[nodeI] !== 1 && !isEnd) continue;

      const a = vertexOf[k.idx[segStart] as number] as number;
      const b = vertexOf[nodeI] as number;
      if (a < 0 || b < 0) {
        // Both ends of a segment are vertices by construction, so this cannot happen. Left as
        // an explicit guard because a silent wrong edge here is unrecoverable downstream.
        throw new Error(`segment endpoint is not a vertex (way ${way.id})`);
      }

      // Geometry and length over every shape point in the segment, inclusive of both ends.
      const shapeId = shapeOffset.length - 1;
      let len = 0;
      for (let q = segStart; q <= p; q++) {
        const i = k.idx[q] as number;
        shapeLat.push(nodeLat[i] as number);
        shapeLon.push(nodeLon[i] as number);
        if (q > segStart) {
          const prev = k.idx[q - 1] as number;
          len += haversineM(
            (nodeLat[prev] as number) / COORD_SCALE,
            (nodeLon[prev] as number) / COORD_SCALE,
            (nodeLat[i] as number) / COORD_SCALE,
            (nodeLon[i] as number) / COORD_SCALE,
          );
        }
      }
      shapeOffset.push(shapeLat.length);

      if (a !== b && len > 0) {
        totalLengthM += len;
        // Does this segment contain a mainline toll plaza? Checked over the node range the
        // segment actually covers, endpoints included, because a plaza sits at a point on the way
        // and the edge covering that point is the one a crossing must traverse.
        let gate = 0;
        if (k.tollRoad !== 0) {
          for (let q = segStart; q <= p; q++) {
            const ni = k.idx[q] as number;
            const kind = tollGateKindOf(clipped.nodeTags.get(nodeIds[ni] as number), k.highway);
            // A mainline barrier outranks a ramp booth on the same edge: it is the larger charge
            // and the one whose flat fee must not be replaced by a per-km one.
            if (kind > gate) gate = kind;
          }
        }

        // Which inter-plaza span does this edge lie in, for a closed-system fare? Taken at the
        // segment MIDPOINT rather than an endpoint, so an edge that straddles a plaza cannot be
        // attributed to the wrong side of it by an arbitrary choice of end.
        let segment = EPE_SEGMENT_NONE;
        if (k.tollRoad !== 0 && epe.usable) {
          const aKm = epe.chainageKmOf.get(nodeIds[k.idx[segStart] as number] as number);
          const bKm = epe.chainageKmOf.get(nodeIds[nodeI] as number);
          if (aKm !== undefined && bKm !== undefined) segment = epeSegmentOf((aKm + bKm) / 2);
        }
        if (k.forward) {
          edgeFrom.push(a); edgeTo.push(b); edgeLengthM.push(len);
          edgeSpeedKmh.push(k.speedKmh); edgeWayId.push(way.id);
          edgeShape.push(shapeId); edgeReversed.push(0);
          edgePrivate.push(k.isPrivate ? 1 : 0);
          edgeClassRank.push(k.classRank);
          edgeToll.push(k.toll ? 1 : 0);
          edgeTollRoad.push(k.tollRoad);
          edgeTollGate.push(gate);
          edgeTollSegment.push(segment);
          edgeNameId.push(k.nameId);
          edgeRoundabout.push(k.roundabout ? 1 : 0);
        }
        if (k.backward) {
          edgeFrom.push(b); edgeTo.push(a); edgeLengthM.push(len);
          edgeSpeedKmh.push(k.speedKmh); edgeWayId.push(way.id);
          edgeShape.push(shapeId); edgeReversed.push(1);
          edgePrivate.push(k.isPrivate ? 1 : 0);
          edgeClassRank.push(k.classRank);
          edgeToll.push(k.toll ? 1 : 0);
          edgeTollRoad.push(k.tollRoad);
          edgeTollGate.push(gate);
          edgeTollSegment.push(segment);
          edgeNameId.push(k.nameId);
          edgeRoundabout.push(k.roundabout ? 1 : 0);
        }
        if (k.forward !== k.backward) onewayEdges++;
      }
      segStart = p;
    }
  }
  sampleRss();
  log(
    `  edges before SCC: ${edgeFrom.length.toLocaleString('en-US')}, ` +
      `shape points ${shapeLat.length.toLocaleString('en-US')}`,
  );

  // ---- CSR over the pre-SCC graph, needed by Tarjan ----
  const csr = buildCsr(vCount, edgeFrom);

  // ---- Largest SCC ----
  const comp = tarjanScc(vCount, csr.offset, csr.edge, edgeTo);
  let sccCount = 0;
  for (const c of comp) if (c + 1 > sccCount) sccCount = c + 1;
  const compSize = new Int32Array(sccCount);
  for (const c of comp) compSize[c] = (compSize[c] as number) + 1;
  let biggest = 0;
  for (let c = 1; c < sccCount; c++) {
    if ((compSize[c] as number) > (compSize[biggest] as number)) biggest = c;
  }
  const largestSize = compSize[biggest] as number;
  log(
    `  SCC: ${sccCount.toLocaleString('en-US')} components, largest holds ` +
      `${largestSize.toLocaleString('en-US')} vertices (${((largestSize / vCount) * 100).toFixed(2)}%)`,
  );
  sampleRss();

  // ---- Keep only the largest component, renumbering vertices and edges ----
  const newVertexOf = new Int32Array(vCount).fill(-1);
  let keptV = 0;
  for (let v = 0; v < vCount; v++) {
    if (comp[v] === biggest) newVertexOf[v] = keptV++;
  }

  // Map dense node index back to its vertex, so vertex coordinates can be recovered.
  const nodeOfVertex = new Int32Array(vCount);
  for (let i = 0; i < nodeCount; i++) {
    const v = vertexOf[i] as number;
    if (v >= 0) nodeOfVertex[v] = i;
  }

  const vertexLat = new Float64Array(keptV);
  const vertexLon = new Float64Array(keptV);
  const vertexNodeId = new Float64Array(keptV);
  for (let v = 0; v < vCount; v++) {
    const nv = newVertexOf[v] as number;
    if (nv < 0) continue;
    const i = nodeOfVertex[v] as number;
    vertexLat[nv] = (nodeLat[i] as number) / COORD_SCALE;
    vertexLon[nv] = (nodeLon[i] as number) / COORD_SCALE;
    vertexNodeId[nv] = nodeIds[i] as number;
  }

  const fFrom: number[] = [];
  const fTo: number[] = [];
  const fLen: number[] = [];
  const fSpeed: number[] = [];
  const fWay: number[] = [];
  const fShape: number[] = [];
  const fRev: number[] = [];
  const fPriv: number[] = [];
  const fRank: number[] = [];
  const fToll: number[] = [];
  const fTollRoad: number[] = [];
  const fTollGate: number[] = [];
  const fTollSegment: number[] = [];
  const fNameId: number[] = [];
  const fRoundabout: number[] = [];
  let keptLengthM = 0;
  for (let e = 0; e < edgeFrom.length; e++) {
    const a = newVertexOf[edgeFrom[e] as number] as number;
    const b = newVertexOf[edgeTo[e] as number] as number;
    if (a < 0 || b < 0) continue;
    fFrom.push(a); fTo.push(b);
    fLen.push(edgeLengthM[e] as number);
    fSpeed.push(edgeSpeedKmh[e] as number);
    fWay.push(edgeWayId[e] as number);
    fShape.push(edgeShape[e] as number);
    fRev.push(edgeReversed[e] as number);
    fPriv.push(edgePrivate[e] as number);
    fRank.push(edgeClassRank[e] as number);
    fToll.push(edgeToll[e] as number);
    fTollRoad.push(edgeTollRoad[e] as number);
    fTollGate.push(edgeTollGate[e] as number);
    fTollSegment.push(edgeTollSegment[e] as number);
    fNameId.push(edgeNameId[e] as number);
    fRoundabout.push(edgeRoundabout[e] as number);
    keptLengthM += edgeLengthM[e] as number;
  }

  const finalCsr = buildCsr(keptV, fFrom);
  sampleRss();

  const drivableWayIds = new Set<number>();
  for (const k of kept) drivableWayIds.add((clipped.ways[k.wayIndex] as (typeof clipped.ways)[number]).id);
  const vertexNodeIdsBeforeScc = new Set<number>();
  for (let i = 0; i < nodeCount; i++) {
    if (isVertex[i] === 1) vertexNodeIdsBeforeScc.add(nodeIds[i] as number);
  }

  const buildSeconds = (performance.now() - t0) / 1000;
  const stats: GraphStats = {
    clippedNodes: nodeCount,
    clippedWays: clipped.ways.length,
    drivableWays: kept.length,
    waysSkippedNotDrivable,
    waysSkippedTooShort,
    missingNodeRefs,
    waysWithMissingRefs,
    verticesBeforeScc: vCount,
    edgesBeforeScc: edgeFrom.length,
    verticesAfterScc: keptV,
    edgesAfterScc: fFrom.length,
    sccCount,
    largestSccShare: vCount === 0 ? 0 : largestSize / vCount,
    shapePoints: shapeLat.length,
    onewayEdges,
    bidirectionalWays,
    speedFromTag,
    speedFromClassDefault,
    privateAccessWays,
    totalLengthKm: keptLengthM / 1000,
    buildSeconds: Number(buildSeconds.toFixed(1)),
    peakRssBytes: peakRss,
  };

  return {
    vertexLat,
    vertexLon,
    vertexNodeId,
    csrOffset: finalCsr.offset,
    csrEdge: finalCsr.edge,
    edgeFrom: new Int32Array(fFrom),
    edgeTo: new Int32Array(fTo),
    edgeLengthM: new Float64Array(fLen),
    edgeSpeedKmh: new Uint8Array(fSpeed),
    edgeWayId: new Float64Array(fWay),
    edgeShape: new Int32Array(fShape),
    edgeReversed: new Uint8Array(fRev),
    edgePrivate: new Uint8Array(fPriv),
    edgeClassRank: new Uint8Array(fRank),
    edgeToll: new Uint8Array(fToll),
    edgeTollRoad: new Uint8Array(fTollRoad),
    edgeTollGate: new Uint8Array(fTollGate),
    edgeTollSegment: new Uint8Array(fTollSegment),
    edgeNameId: new Int32Array(fNameId),
    edgeRoundabout: new Uint8Array(fRoundabout),
    roadNames,
    shapeOffset: new Int32Array(shapeOffset),
    shapeLat: new Int32Array(shapeLat),
    shapeLon: new Int32Array(shapeLon),
    drivableWayIds,
    vertexNodeIdsBeforeScc,
    stats,
  };
}

/** Counting sort of edge indices by source vertex. O(V + E), no comparison sort needed. */
function buildCsr(vertexCount: number, from: readonly number[]): { offset: Int32Array; edge: Int32Array } {
  const offset = new Int32Array(vertexCount + 1);
  for (const v of from) offset[v + 1] = (offset[v + 1] as number) + 1;
  for (let v = 0; v < vertexCount; v++) {
    offset[v + 1] = (offset[v + 1] as number) + (offset[v] as number);
  }
  const cursor = Int32Array.from(offset.subarray(0, vertexCount));
  const edge = new Int32Array(from.length);
  for (let e = 0; e < from.length; e++) {
    const v = from[e] as number;
    edge[cursor[v] as number] = e;
    cursor[v] = (cursor[v] as number) + 1;
  }
  return { offset, edge };
}

/**
 * Iterative Tarjan. Returns a component id per vertex.
 *
 * Explicit stacks, because recursion overflows at this scale and it does so on the largest
 * component, which is the only one that matters. `frame` holds the vertex, `iter` holds how
 * far through that vertex's adjacency the frame has progressed.
 */
function tarjanScc(
  vertexCount: number,
  csrOffset: Int32Array,
  csrEdge: Int32Array,
  edgeTo: readonly number[],
): Int32Array {
  const index = new Int32Array(vertexCount).fill(-1);
  const low = new Int32Array(vertexCount);
  const onStack = new Uint8Array(vertexCount);
  const comp = new Int32Array(vertexCount).fill(-1);
  const sccStack = new Int32Array(vertexCount);
  let sccTop = 0;

  const frame = new Int32Array(vertexCount + 1);
  const iter = new Int32Array(vertexCount + 1);
  let nextIndex = 0;
  let nextComp = 0;

  for (let root = 0; root < vertexCount; root++) {
    if ((index[root] as number) !== -1) continue;

    let top = 0;
    frame[0] = root;
    iter[0] = csrOffset[root] as number;
    index[root] = nextIndex;
    low[root] = nextIndex;
    nextIndex++;
    sccStack[sccTop++] = root;
    onStack[root] = 1;

    while (top >= 0) {
      const v = frame[top] as number;
      const end = csrOffset[v + 1] as number;
      let i = iter[top] as number;

      if (i < end) {
        iter[top] = i + 1;
        const w = edgeTo[csrEdge[i] as number] as number;
        if ((index[w] as number) === -1) {
          index[w] = nextIndex;
          low[w] = nextIndex;
          nextIndex++;
          sccStack[sccTop++] = w;
          onStack[w] = 1;
          top++;
          frame[top] = w;
          iter[top] = csrOffset[w] as number;
        } else if (onStack[w] === 1) {
          const iw = index[w] as number;
          if (iw < (low[v] as number)) low[v] = iw;
        }
        continue;
      }

      // v is finished. Close a component, or propagate low to the parent.
      if ((low[v] as number) === (index[v] as number)) {
        for (;;) {
          const w = sccStack[--sccTop] as number;
          onStack[w] = 0;
          comp[w] = nextComp;
          if (w === v) break;
        }
        nextComp++;
      }
      top--;
      if (top >= 0) {
        const parent = frame[top] as number;
        if ((low[v] as number) < (low[parent] as number)) low[parent] = low[v] as number;
      }
    }
  }
  return comp;
}
