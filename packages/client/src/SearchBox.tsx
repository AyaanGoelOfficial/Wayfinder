/**
 * Search as you type, with the latency it cost shown beside it.
 *
 * THE READOUT IS A DESIGNED ELEMENT, not debug output. This whole product is one city built from
 * raw data with nothing bought in, and the search index is the clearest place a user can watch that
 * choice pay: flip the switch and the same query over the same 7,675 places goes from tens of
 * milliseconds to a fraction of one. Hiding that would be hiding the most interesting thing the
 * search does. It is placed quietly, in caption type, under the results, so it informs without
 * competing with them.
 *
 * ZERO LOGIC HERE, per `packages/client/CLAUDE.md`. Debouncing, supersession, ranking and what an
 * empty result means all live in the store. This file renders state and dispatches intent.
 */
import type { ReactElement } from 'react';
import { useStore } from './store.ts';
import type { SearchHit } from '../../shared/index.ts';

/** What each result says under its name. Kind and category are OSM's words, made readable. */
function subtitle(hit: SearchHit): string {
  const where = hit.distanceM === undefined ? '' : `${(hit.distanceM / 1000).toFixed(1)} km away`;
  const what = hit.category.replace(/_/g, ' ');
  return where === '' ? what : `${what}, ${where}`;
}

export function SearchBox(): ReactElement {
  const search = useStore((s) => s.search);
  const setQuery = useStore((s) => s.setQuery);
  const setIndexed = useStore((s) => s.setIndexed);
  const choose = useStore((s) => s.choose);
  const destination = useStore((s) => s.destination);

  const asking = destination === null ? 'Where to?' : 'Starting from?';
  // Falls back to a sentence that needs no number, so a failed health check degrades the copy
  // rather than printing "null places".
  const corpus = search.corpus === null ? 'every place in the city' : `${search.corpus.toLocaleString('en-IN')} places`;

  return (
    <div className="search">
      <label className="search-field">
        <span className="visually-hidden">{asking}</span>
        <input
          className="search-input"
          type="search"
          value={search.query}
          placeholder={asking}
          autoComplete="off"
          spellCheck={false}
          aria-label={asking}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      {search.hits.length > 0 && (
        <ul className="results" role="listbox" aria-label="Search results">
          {search.hits.map((hit, i) => (
            <li key={`${hit.id}-${hit.kind}`}>
              <button
                type="button"
                className="result"
                role="option"
                aria-selected={false}
                /* Entrance stagger, 45 ms a row, inside the 40 to 80 ms band in ui.md. `backwards`
                   and never `both`: a filled animation's last keyframe outranks the hover rule. */
                style={{ animationDelay: `${Math.min(i, 7) * 45}ms` }}
                onClick={() => choose(hit)}
              >
                <span className="result-name">{hit.name}</span>
                <span className="result-meta">{subtitle(hit)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {search.missed && search.query.trim() !== '' && (
        <p className="results-empty" role="status">
          Nothing here by that name. Check the spelling, or try a nearby landmark.
        </p>
      )}

      <p className="latency" role="status">
        <label className="latency-switch">
          <input
            type="checkbox"
            checked={search.indexed}
            onChange={(e) => setIndexed(e.target.checked)}
          />
          <span>Index</span>
        </label>
        <span className="latency-figure">
          {search.latencyMs === null
            ? `Type to search ${corpus}`
            : `${search.latencyMs.toFixed(search.latencyMs < 10 ? 2 : 1)} ms to search ${corpus}`}
        </span>
      </p>
    </div>
  );
}
