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
import type { ApiError, Instruction, LngLat, Route, SearchHit, TollDisplay } from '../../shared/index.ts';
import { tollDisplayOf } from '../../shared/toll.ts';

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

  setQuery: (q: string) => void;
  setIndexed: (on: boolean) => void;
  setCentre: (c: LngLat) => void;
  choose: (hit: SearchHit) => void;
  clearRoute: () => void;
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

  setCentre: (c) => set({ centre: c }),

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

  clearRoute: () =>
    set((s) => ({
      origin: null,
      destination: null,
      route: null,
      routeError: null,
      search: { ...s.search, query: '', hits: [], missed: false },
    })),
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
      },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    if (seq !== routeSeq) return;
    set({ routing: false, route: null, routeError: err instanceof Error ? err.message : String(err) });
  }
}
