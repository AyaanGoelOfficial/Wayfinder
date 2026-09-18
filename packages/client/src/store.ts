/**
 * All client state and every decision that acts on it. Components render this and dispatch intent.
 *
 * `packages/client/CLAUDE.md`: ZERO business logic in components. That rule is what makes a later
 * visual overhaul a change to markup and CSS only, and it only holds if the rules a view might be
 * tempted to inline live here instead: which response is stale, when a query is worth sending, how
 * a toll figure may be worded, what an empty result means.
 *
 * SUPERSESSION IS ENFORCED IN TWO PLACES AND BOTH ARE NEEDED. Charter item 6: the network is not
 * ordered, so a slow answer to "par" can arrive after a fast answer to "pari chowk". `AbortController`
 * stops the request that is already in flight, and a monotonic sequence number discards anything
 * that still lands. Aborting alone leaves a race, because a response can be in the microtask queue
 * when abort is called.
 */
import { create } from 'zustand';
// Relative, because the client has no path alias and `packages/CLAUDE.md` allows exactly two
// sources here: `config/` and `shared/`. A bare specifier would need an alias whose only job is to
// make it look like a package, which is how an accidental `engine/` import gets in later.
import type {
  ApiError,
  Fix,
  Approach,
  Instruction,
  LngLat,
  Route,
  SearchHit,
  TollDisplay,
  TrackingSnapshot,
} from '../../shared/index.ts';
import { tollDisplayOf } from '../../shared/toll.ts';
import { TrackingController } from './tracking/controller.ts';
import type { CoarseState } from './tracking/controller.ts';

/** Milliseconds of quiet before a keystroke becomes a request. */
const DEBOUNCE_MS = 90;

export interface SearchState {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  /** Server-reported search time for the most recent answer, in ms. Null before the first one. */
  readonly latencyMs: number | null;
  /** Round-trip as the browser measured it, which is what the user actually waited. */
  readonly roundTripMs: number | null;
  readonly indexed: boolean;
  readonly searching: boolean;
  /** Set only when the query returned nothing, so an empty box and a miss look different. */
  readonly missed: boolean;
  /** Corpus size, read from /health. Never hardcoded: it changes every time the city is rebuilt. */
  readonly corpus: number | null;
}

export interface RouteView {
  readonly id: number;
  readonly km: number;
  readonly driveMinutes: number;
  readonly geometry: readonly LngLat[];
  readonly instructions: readonly Instruction[];
  readonly tollRupees: number;
  readonly tollDisplay: TollDisplay;
  readonly tollKm: number;
  /** The walking gap at each end, when the point is far enough from its road. Never driven. */
  readonly originApproach: Approach | null;
  readonly destinationApproach: Approach | null;
}

/**
 * The tracking slice. COARSE ONLY, on purpose.
 *
 * The animated dot and the chase camera are NOT here: they are driven imperatively into MapLibre
 * from the frame loop in `tracking/controller.ts`. Putting a 60 Hz position in the store would
 * re-render the entire rail on every frame, and the target device is a mid-range Android under
 * throttle. What lives here is what a person reads, which changes a few times a minute.
 */
export interface TrackingView {
  readonly active: boolean;
  readonly source: 'simulator' | 'device' | null;
  readonly phase: TrackingSnapshot['phase'];
  readonly quality: TrackingSnapshot['quality'];
  /** Index into `route.instructions`, or -1 when there is no progress yet. */
  readonly instructionIndex: number;
  readonly metresToManeuver: number;
  readonly remainingM: number;
  readonly remainingS: number;
  readonly accuracyM: number;
  readonly speedMps: number;
  /** Follow mode. A manual pan drops it and the re-centre control appears. */
  readonly following: boolean;
  /** Fix accounting, shown in the dev panel so a filtered stream is never invisible. */
  readonly accepted: number;
  readonly rejectedTotal: number;
  /** How many times the engine has asked for a new route this trip. */
  readonly reroutes: number;
  /** Simulator controls. Dev only; absent from a production build's UI. */
  readonly simSpeedMps: number;
  readonly simNoiseSigmaM: number;
  readonly simDropout: number;
  readonly deviating: boolean;
}

interface AppState {
  readonly search: SearchState;
  readonly origin: SearchHit | null;
  readonly destination: SearchHit | null;
  readonly route: RouteView | null;
  readonly routeError: string | null;
  readonly routing: boolean;
  /** Map centre, fed in by the adapter. Used only to bias search ranking. */
  readonly centre: LngLat | null;
  readonly tracking: TrackingView;

  setQuery: (q: string) => void;
  setIndexed: (on: boolean) => void;
  setCentre: (c: LngLat) => void;
  choose: (hit: SearchHit) => void;
  clearRoute: () => void;

  startTracking: (source: 'simulator' | 'device') => void;
  stopTracking: () => void;
  setFollowing: (on: boolean) => void;
  setSimSpeed: (mps: number) => void;
  setSimNoise: (sigmaM: number) => void;
  setSimDropout: (p: number) => void;
  toggleDeviate: () => void;
}

/**
 * Monotonic request counters, one per channel.
 *
 * Module scope rather than store state on purpose: they are not rendered, and putting them in the
 * store would make every keystroke publish a state change that no component reads.
 */
let searchSeq = 0;
let routeSeq = 0;
let searchAbort: AbortController | null = null;
let routeAbort: AbortController | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as ApiError | null;
  // The server's own message carries the remedy. Inventing one here would drop it.
  return body?.message ?? `The request failed with status ${res.status}.`;
}

/**
 * THE FULL ROUTE, kept beside the view model.
 *
 * `RouteView` is shaped for rendering: kilometres, minutes, a display tier. The tracking engine
 * needs the CONTRACT object, because it matches against `geometry` and derives progress from
 * `instructions`. Deriving one from the other would mean two representations of the same route
 * that can disagree, which is the whole failure `shared/` exists to prevent.
 */
let rawRoute: Route | null = null;

/**
 * The per-frame channel, deliberately NOT in the store.
 *
 * MapView subscribes to this and writes the dot and the camera straight into MapLibre. A store
 * write at display rate would re-render the search field and the route panel sixty times a second
 * to say exactly what they already said.
 */
type FrameListener = (s: TrackingSnapshot) => void;
const frameListeners = new Set<FrameListener>();
export function onTrackingFrame(fn: FrameListener): () => void {
  frameListeners.add(fn);
  return () => frameListeners.delete(fn);
}

const controller = new TrackingController({
  onFrame: (s) => {
    for (const fn of frameListeners) fn(s);
  },
  onCoarse: (c: CoarseState) => {
    useStore.setState((s) => ({
      tracking: {
        ...s.tracking,
        phase: c.phase,
        quality: c.quality,
        instructionIndex: c.instructionIndex,
        metresToManeuver: c.metresToManeuver,
        remainingM: c.remainingM,
        remainingS: c.remainingS,
        accuracyM: c.accuracyM,
        speedMps: c.speedMps,
        accepted: c.accepted,
        rejectedTotal: c.rejectedTotal,
        deviating: controller.deviating,
      },
    }));
  },
  /**
   * The driver has left the route. Ask for a replacement FROM WHERE THEY ACTUALLY ARE.
   *
   * Goes through the same `runRoute` as every other request, so it inherits the supersession
   * machinery unchanged: a monotonic sequence number and an `AbortController`. Charter item 6.
   * A separate re-route path would be a second place for a stale answer to win.
   */
  onReroute: (from) => {
    const dest = useStore.getState().destination;
    if (dest === null) return;
    useStore.setState((s) => ({ tracking: { ...s.tracking, reroutes: s.tracking.reroutes + 1 } }));
    void runRoute(from, dest.point, useStore.setState);
  },
});

export const useStore = create<AppState>()((set, get) => ({
  search: {
    query: '',
    hits: [],
    latencyMs: null,
    roundTripMs: null,
    indexed: true,
    searching: false,
    missed: false,
    corpus: null,
  },
  origin: null,
  destination: null,
  route: null,
  routeError: null,
  routing: false,
  centre: null,
  tracking: {
    active: false,
    source: null,
    phase: 'idle',
    quality: 'lost',
    instructionIndex: -1,
    metresToManeuver: 0,
    remainingM: 0,
    remainingS: 0,
    accuracyM: 0,
    speedMps: 0,
    following: true,
    accepted: 0,
    rejectedTotal: 0,
    reroutes: 0,
    simSpeedMps: 14,
    simNoiseSigmaM: 8,
    simDropout: 0,
    deviating: false,
  },

  setCentre: (c) => set({ centre: c }),

  startTracking: (source) => {
    const r = get().route;
    if (source === 'simulator' && r === null) return; // nothing to replay
    set((s) => ({
      tracking: { ...s.tracking, active: true, source, following: true, reroutes: 0, deviating: false },
    }));
    controller.setRoute(rawRoute);
    controller.start(source);
  },

  stopTracking: () => {
    controller.stop();
    set((s) => ({
      tracking: {
        ...s.tracking,
        active: false,
        source: null,
        phase: 'idle',
        quality: 'lost',
        instructionIndex: -1,
        deviating: false,
      },
    }));
  },

  setFollowing: (on) => set((s) => ({ tracking: { ...s.tracking, following: on } })),

  setSimSpeed: (mps) => {
    controller.setSimulatorOptions({ speedMps: mps });
    set((s) => ({ tracking: { ...s.tracking, simSpeedMps: mps } }));
  },
  setSimNoise: (sigmaM) => {
    controller.setSimulatorOptions({ noiseSigmaM: sigmaM });
    set((s) => ({ tracking: { ...s.tracking, simNoiseSigmaM: sigmaM } }));
  },
  setSimDropout: (p) => {
    controller.setSimulatorOptions({ dropoutProbability: p });
    set((s) => ({ tracking: { ...s.tracking, simDropout: p } }));
  },
  toggleDeviate: () => {
    const on = !get().tracking.deviating;
    if (on) controller.deviate();
    else controller.rejoin();
    set((s) => ({ tracking: { ...s.tracking, deviating: on } }));
  },

  setIndexed: (on) => {
    set((s) => ({ search: { ...s.search, indexed: on } }));
    // Re-run immediately rather than waiting for the next keystroke: the whole point of the switch
    // is to watch the number move on the SAME query.
    const q = get().search.query;
    if (q.trim() !== '') void runSearch(q, set, get);
  },

  setQuery: (q) => {
    set((s) => ({ search: { ...s.search, query: q, missed: false } }));
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    if (q.trim() === '') {
      searchAbort?.abort();
      set((s) => ({ search: { ...s.search, hits: [], searching: false, missed: false } }));
      return;
    }
    set((s) => ({ search: { ...s.search, searching: true } }));
    debounceTimer = setTimeout(() => void runSearch(q, set, get), DEBOUNCE_MS);
  },

  choose: (hit) => {
    const s = get();
    // First pick is the destination, not the origin. A driver almost always knows where they are
    // and is looking for where they are going, so asking for the start first is one extra step on
    // the common path. The second pick becomes the start.
    if (s.destination === null) {
      set({ destination: hit, search: { ...s.search, query: '', hits: [], missed: false } });
      return;
    }
    set({ origin: hit, search: { ...s.search, query: '', hits: [], missed: false } });
    void runRoute(hit.point, s.destination.point, set);
  },

  clearRoute: () => {
    // Tracking without a route is free drive, not navigation, and leaving a chase camera locked
    // to a dot after the route is cleared strands the user pointing at nothing.
    controller.stop();
    controller.setRoute(null);
    rawRoute = null;
    set((s) => ({
      origin: null,
      destination: null,
      route: null,
      routeError: null,
      search: { ...s.search, query: '', hits: [], missed: false },
      tracking: {
        ...s.tracking,
        active: false,
        source: null,
        phase: 'idle',
        quality: 'lost',
        instructionIndex: -1,
        deviating: false,
        reroutes: 0,
      },
    }));
  },
}));

type Setter = (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void;

/**
 * Corpus size, fetched once at start-up.
 *
 * Fire and forget: the search box has a sentence to show either way, so a failed health check
 * degrades the copy rather than the feature. A search UI that will not render because it does not
 * know how many places exist would be the wrong trade.
 */
void (async (): Promise<void> => {
  try {
    const res = await fetch('/health');
    if (!res.ok) return;
    const body = (await res.json()) as { places?: number };
    if (typeof body.places === 'number') {
      useStore.setState((s) => ({ search: { ...s.search, corpus: body.places as number } }));
    }
  } catch {
    // No corpus figure, no message about the corpus. Nothing else depends on it.
  }
})();

/**
 * A route asked for in the URL, as `?from=lon,lat&to=lon,lat`.
 *
 * MOVED HERE FROM MapView AT GATE 8, and the move fixed a real defect rather than tidying one.
 * The map adapter used to fetch and draw this route itself, which meant the app had TWO route
 * paths: one through the store and one around it. Anything that reads `store.route`, which is now
 * the route panel, the tracking engine, the simulator and the covered line, saw nothing at all
 * when the route arrived by link. The link is how every reproducible screenshot and every browser
 * gate scenario is set up, so the bypassed path was the one under test.
 *
 * A synthetic destination is recorded alongside it because RE-ROUTING NEEDS A TARGET. Without it
 * a driver who deviates on a link-opened route triggers `onReroute` and nothing happens.
 */
function pointFromParam(raw: string | null): LngLat | null {
  if (raw === null) return null;
  const parts = raw.split(',');
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  if (parts.length !== 2 || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return [lon, lat];
}

function syntheticHit(name: string, point: LngLat): SearchHit {
  return {
    id: -1,
    name,
    kind: 'place',
    category: 'url',
    point,
    importance: 0,
    matchType: 'prefix',
    score: 0,
  };
}

void (function routeFromUrl(): void {
  const q = new URLSearchParams(window.location.search);
  const from = pointFromParam(q.get('from'));
  const to = pointFromParam(q.get('to'));
  if (from === null || to === null) return;
  useStore.setState({
    origin: syntheticHit('Start', from),
    destination: syntheticHit('Destination', to),
  });
  void runRoute(from, to, useStore.setState);
})();

/**
 * DEV ONLY test surface, for `npm run verify:browser`.
 *
 * The five GPS scenarios must be DETERMINISTIC, and neither fix source can give that. The device
 * source needs a real receiver; the simulator runs on wall-clock timers, so a scenario driven
 * through it would assert against whatever the machine happened to schedule, which is precisely
 * the timer unreliability recorded at gate 0. This hook lets the gate push a scripted trace with
 * exact timestamps and read the engine's answer back.
 *
 * Same pattern and same reason as `window.__map` in the map adapter: a browser gate has to be able
 * to tell "the engine refused to match" apart from "the dot did not draw", and those two are
 * indistinguishable from a screenshot. Stripped from production builds by the DEV guard.
 */
if (import.meta.env.DEV) {
  (window as unknown as { __tracking?: unknown }).__tracking = {
    /**
     * Begin a scripted run. No fix source is started, so nothing competes with the script.
     *
     * `freeDrive` runs it with NO route, which is the only way to exercise the server-side
     * matcher from a gate: the device source needs a real receiver and headless Chrome denies
     * geolocation outright.
     */
    beginScripted(freeDrive = false): void {
      controller.beginScripted(freeDrive ? null : rawRoute);
      useStore.setState((s) => ({
        tracking: { ...s.tracking, active: true, source: null, following: true, reroutes: 0 },
      }));
    },
    injectFix(fix: Fix): void {
      controller.injectFix(fix);
    },
    /** Advance the animation by an exact elapsed time, with no dependence on rAF scheduling. */
    step(nowMs: number, dtMs: number): TrackingSnapshot {
      return controller.stepScripted(nowMs, dtMs);
    },
    snapshot(): TrackingSnapshot {
      return controller.stepScripted(controller.lastScriptedNowMs, 0);
    },
    state(): TrackingView {
      return useStore.getState().tracking;
    },
    routeGeometry(): readonly LngLat[] {
      return rawRoute?.geometry ?? [];
    },
    stop(): void {
      useStore.getState().stopTracking();
    },
  };
}

async function runSearch(q: string, set: Setter, get: () => AppState): Promise<void> {
  const seq = ++searchSeq;
  searchAbort?.abort();
  const ctl = new AbortController();
  searchAbort = ctl;

  const { centre, search } = get();
  const params = new URLSearchParams({ q, limit: '8' });
  if (centre !== null) params.set('near', `${centre[0]},${centre[1]}`);
  if (!search.indexed) params.set('index', 'off');

  const t0 = performance.now();
  try {
    const res = await fetch(`/search?${params.toString()}`, { signal: ctl.signal });
    if (seq !== searchSeq) return;
    if (!res.ok) {
      set((s) => ({ search: { ...s.search, hits: [], searching: false, missed: true } }));
      return;
    }
    const body = (await res.json()) as { hits: SearchHit[]; timingMs: { search: number } };
    if (seq !== searchSeq) return;
    set((s) => ({
      search: {
        ...s.search,
        hits: body.hits,
        latencyMs: body.timingMs.search,
        roundTripMs: Number((performance.now() - t0).toFixed(1)),
        searching: false,
        missed: body.hits.length === 0,
      },
    }));
  } catch (err) {
    // An abort is the expected outcome of typing quickly, not a failure to report.
    if (err instanceof DOMException && err.name === 'AbortError') return;
    if (seq !== searchSeq) return;
    set((s) => ({ search: { ...s.search, hits: [], searching: false, missed: true } }));
  }
}

/**
 * Which display tier to render, with the shared rule as the arbiter rather than the wire value.
 *
 * The server sends `tollDisplay`, and `shared/CLAUDE.md` forbids a view deciding the tier for
 * itself. That is not the same as trusting the field blindly: it is computed from two other fields
 * that travel in the same object, so a disagreement means one of them was mangled in transit or by
 * a version skew between server and bundle. Recomputing costs nothing and turns a silent
 * disagreement into a visible one.
 *
 * DISAGREEMENT RESOLVES DOWNWARD, to `estimated`, never up. An estimate shown as a fact is
 * indistinguishable from a fact, which is the exact failure the whole confidence model exists to
 * prevent; a fact shown as an estimate merely understates what we know.
 */
function agreedDisplay(r: Route): TollDisplay {
  const derived = tollDisplayOf(r.tollConfidence, r.tollMetres);
  if (derived === r.tollDisplay) return derived;
  console.warn(
    `toll display disagreement: server said ${r.tollDisplay}, ` +
      `${r.tollConfidence} over ${r.tollMetres} m derives ${derived}. Showing the weaker claim.`,
  );
  return derived === 'none' || r.tollDisplay === 'none' ? 'none' : 'estimated';
}

async function runRoute(from: LngLat, to: LngLat, set: Setter): Promise<void> {
  const seq = ++routeSeq;
  routeAbort?.abort();
  const ctl = new AbortController();
  routeAbort = ctl;
  set({ routing: true, routeError: null });

  const params = new URLSearchParams({ from: `${from[0]},${from[1]}`, to: `${to[0]},${to[1]}` });
  try {
    const res = await fetch(`/route?${params.toString()}`, { signal: ctl.signal });
    if (seq !== routeSeq) return;
    if (!res.ok) {
      set({ routing: false, route: null, routeError: await readError(res) });
      return;
    }
    const body = (await res.json()) as { route: Route };
    if (seq !== routeSeq) return;
    const r = body.route;
    // The contract object is kept as it arrived, for the tracking engine. Everything below is a
    // VIEW of it, never a replacement.
    rawRoute = r;
    controller.setRoute(r);
    set({
      routing: false,
      routeError: null,
      route: {
        id: r.id,
        km: r.distanceM / 1000,
        // `durationS` is the modelled COST, not a drive time, so the panel derives its minutes from
        // the instruction legs, which are summed from per-edge speeds. See `engine/CLAUDE.md`.
        driveMinutes: r.instructions.reduce((a, i) => a + i.durationS, 0) / 60,
        geometry: r.geometry,
        instructions: r.instructions,
        tollRupees: r.tollCost,
        tollDisplay: agreedDisplay(r),
        tollKm: r.tollMetres / 1000,
        // Normalised to null here so components never branch on undefined. The server omits the
        // key entirely when the gap is under the threshold, which is the common case.
        originApproach: r.originApproach ?? null,
        destinationApproach: r.destinationApproach ?? null,
      },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    if (seq !== routeSeq) return;
    set({ routing: false, route: null, routeError: err instanceof Error ? err.message : String(err) });
  }
}
