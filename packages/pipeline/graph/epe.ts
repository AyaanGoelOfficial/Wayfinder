/**
 * WHERE ALONG THE EASTERN PERIPHERAL EXPRESSWAY IS THIS, in the Gazette's own chainage.
 *
 * EPE is a CLOSED tolling system: the fare is a function of the entry and exit interchange, not of
 * distance driven and not of plazas crossed. Gazette S.O. 613(E) gives the fare as a matrix over 11
 * plazas identified by CHAINAGE. So to price a route we have to answer, for every EPE edge, which
 * inter-plaza span it lies in. That is a fact about the road, so it is computed here and stored in
 * the artifact, exactly like a speed or a class rank. The MONEY stays in `config/city.ts`.
 *
 * CHAINAGE IS MEASURED, NOT MATCHED BY NAME. OSM names three of the eleven plazas, and the villages
 * it does carry sit up to 18 km off the road. Position along the carriageway is a measurement;
 * "the nearest village is called Fatehpur" is an inference that reads like one. `npm run
 * calibrate:epe` is the derivation that justifies the anchor below and re-checks it after any
 * re-clip.
 */
import { EPE_PLAZAS, EPE_CHAINAGE_AT_CLIP_SOUTH_END_KM } from '../../../config/city.ts';
import { scaledToDeg } from '../clip/clip.ts';
import { EPE_SEGMENT_NONE } from '../../shared/graphfile.ts';
import { haversineM } from '../../shared/geo.ts';

/** Name or ref that identifies EPE. Both are checked; neither is assumed to be present. */
const EPE_NAME = /eastern[\s-]*peripheral/i;
const EPE_REF = /\bNE-?2\b/i;

export function isEpeTagged(tags: ReadonlyMap<string, string>): boolean {
  return EPE_NAME.test(tags.get('name') ?? '') || EPE_REF.test(tags.get('ref') ?? '');
}

/** The minimum a clip must contain before its chainage is trusted. Below this the run is refused. */
export const EPE_MIN_CHAIN_KM = 20;

/** The slice of the clip this needs. Latitudes and longitudes are SCALED, as the clip stores them. */
export interface ClipLike {
  readonly ways: readonly { readonly id: number; readonly refs: readonly number[]; readonly tags: ReadonlyMap<string, string> }[];
  readonly nodeIndex: { get(id: number): number };
  readonly nodeLat: ArrayLike<number>;
  readonly nodeLon: ArrayLike<number>;
}

export interface EpeChainage {
  /**
   * Distance north from the southern terminus, in km, for every EPE mainline node in the clip.
   *
   * SEPARATE FROM CHAINAGE ON PURPOSE. This is OUR measurement and owes nothing to the Gazette;
   * `chainageKmOf` is that measurement plus the anchor. Keeping them apart is what lets
   * `npm run calibrate:epe` FIT the anchor rather than assume it, and then check the fit against
   * plazas it never saw.
   */
  readonly kmFromSouthOf: ReadonlyMap<number, number>;
  /** Gazette chainage in km for every EPE mainline node in the clip. */
  readonly chainageKmOf: ReadonlyMap<number, number>;
  /** Every node of an EPE-tagged way, mainline or ramp. */
  readonly epeNodes: ReadonlySet<number>;
  /** Node ids on the mainline carriageways only. */
  readonly mainlineNodes: ReadonlySet<number>;
  /** One entry per carriageway run found, longest first, in km. */
  readonly runKm: readonly number[];
  /** True when the clip holds enough continuous mainline for the chainage to mean anything. */
  readonly usable: boolean;
}

/**
 * Chains the mainline carriageways and assigns each node a Gazette chainage.
 *
 * ANCHORED AT THE SOUTH TERMINUS, not fitted per build. EPE's chainage runs from the NH-44 tie-in
 * near Sonepat southward to the NH-19 tie-in at Palwal, and the southern terminus is a physical end
 * of the road rather than an artefact of our clip, so it is stable across re-clips in a way that a
 * bbox edge is not. Each carriageway is anchored at its OWN southern end, because the two differ in
 * length by a few hundred metres and forcing them onto one origin would smear that difference
 * across every interchange.
 *
 * MAINLINE ONLY. A `motorway_link` is a ramp; its length is not chainage, and chaining one in would
 * displace every position north of that interchange.
 */
export function computeEpeChainage(clipped: ClipLike): EpeChainage {
  const ll = (id: number): { lat: number; lon: number } | null => {
    const i = clipped.nodeIndex.get(id);
    if (i < 0) return null;
    const lat = clipped.nodeLat[i];
    const lon = clipped.nodeLon[i];
    if (lat === undefined || lon === undefined) return null;
    return { lat: scaledToDeg(lat), lon: scaledToDeg(lon) };
  };

  const epeNodes = new Set<number>();
  const mainlineNodes = new Set<number>();
  const mainWays: { id: number; refs: readonly number[] }[] = [];
  for (const w of clipped.ways) {
    if (!isEpeTagged(w.tags)) continue;
    const h = w.tags.get('highway');
    if (h === undefined) continue;
    for (const r of w.refs) epeNodes.add(r);
    if (h !== 'motorway') continue;
    mainWays.push({ id: w.id, refs: w.refs });
    for (const r of w.refs) mainlineNodes.add(r);
  }

  // Chain ways head to tail. A one-way dual carriageway yields one run per direction; the runs are
  // built from node adjacency rather than from way order, which a PBF does not guarantee.
  const byStart = new Map<number, { id: number; refs: readonly number[] }[]>();
  const isSomeoneseTail = new Set<number>();
  for (const w of mainWays) {
    const s = w.refs[0];
    const e = w.refs[w.refs.length - 1];
    if (s === undefined || e === undefined) continue;
    const list = byStart.get(s);
    if (list) list.push(w);
    else byStart.set(s, [w]);
    isSomeoneseTail.add(e);
  }
  const used = new Set<number>();
  const runs: number[][] = [];
  const walk = (seed: { id: number; refs: readonly number[] }): void => {
    const nodes: number[] = [];
    let cur: { id: number; refs: readonly number[] } | undefined = seed;
    while (cur !== undefined && !used.has(cur.id)) {
      used.add(cur.id);
      const from = nodes.length === 0 ? 0 : 1;
      for (let i = from; i < cur.refs.length; i++) {
        const r = cur.refs[i];
        if (r !== undefined) nodes.push(r);
      }
      const tail = nodes[nodes.length - 1];
      cur = tail === undefined ? undefined : byStart.get(tail)?.find((c) => !used.has(c.id));
    }
    if (nodes.length > 1) runs.push(nodes);
  };
  for (const w of mainWays) {
    const s = w.refs[0];
    if (used.has(w.id) || s === undefined || isSomeoneseTail.has(s)) continue;
    walk(w);
  }
  // Anything left is part of a cycle and has no natural head. Seeded arbitrarily rather than
  // dropped, so a re-clip that closes a loop degrades the fit visibly instead of losing the road.
  for (const w of mainWays) if (!used.has(w.id)) walk(w);

  const kmFromSouthOf = new Map<number, number>();
  const chainageKmOf = new Map<number, number>();
  const runKm: number[] = [];
  for (const run of runs) {
    const cum: number[] = [0];
    for (let i = 1; i < run.length; i++) {
      const a = ll(run[i - 1] as number);
      const b = ll(run[i] as number);
      const step = a !== null && b !== null ? haversineM(a.lat, a.lon, b.lat, b.lon) / 1000 : 0;
      cum.push((cum[i - 1] as number) + step);
    }
    const total = cum[cum.length - 1] as number;
    runKm.push(total);

    // Orient south-first. Chainage INCREASES southward on EPE, so the southern end of each run
    // carries the larger chainage and we count down from the terminus anchor.
    const head = ll(run[0] as number);
    const tail = ll(run[run.length - 1] as number);
    const headIsSouth = head !== null && tail !== null ? head.lat <= tail.lat : true;
    for (let i = 0; i < run.length; i++) {
      const fromSouth = headIsSouth ? (cum[i] as number) : total - (cum[i] as number);
      const node = run[i] as number;
      // First write wins where the carriageways share a node, which happens only at the termini.
      if (kmFromSouthOf.has(node)) continue;
      kmFromSouthOf.set(node, fromSouth);
      chainageKmOf.set(node, EPE_CHAINAGE_AT_CLIP_SOUTH_END_KM - fromSouth);
    }
  }
  runKm.sort((a, b) => b - a);

  return {
    kmFromSouthOf,
    chainageKmOf,
    epeNodes,
    mainlineNodes,
    runKm,
    usable: (runKm[0] ?? 0) >= EPE_MIN_CHAIN_KM,
  };
}

/**
 * Which inter-plaza span a chainage falls in: `i` means "between plaza i and plaza i+1".
 *
 * Returns 255 when the position is outside every span, which is what an out-of-range chainage
 * should produce rather than a silently clamped end segment. `EPE_PLAZAS` is in increasing
 * chainage order, so a route occupying spans a..b entered at plaza a and left at plaza b+1, and
 * that pair is the Table 5 lookup.
 */
export function epeSegmentOf(chainageKm: number): number {
  for (let i = 0; i + 1 < EPE_PLAZAS.length; i++) {
    const lo = EPE_PLAZAS[i]?.chainageKm;
    const hi = EPE_PLAZAS[i + 1]?.chainageKm;
    if (lo === undefined || hi === undefined) continue;
    if (chainageKm >= lo && chainageKm <= hi) return i;
  }
  return EPE_SEGMENT_NONE;
}
