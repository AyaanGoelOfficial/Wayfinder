/**
 * The route summary and its turn-by-turn list.
 *
 * THE TOLL FIGURE IS RENDERED FROM `tollDisplay` AND NOTHING ELSE. `shared/CLAUDE.md` forbids a
 * view deciding for itself whether a rupee amount may be stated bare, and this is the view that
 * would be tempted. The three tiers, and why they are three:
 *
 *   exact      a figure alone. Reserved for a fare we can defend to its source: an EPE pair read
 *              from the Gazette matrix, or a Yamuna mainline crossing at a plaza fee photographed
 *              in person.
 *   estimated  the word Tolls, then the amount labelled an estimate. Everything we priced from a
 *              per-kilometre basis rather than a published fare for that journey.
 *   none       nothing at all. A toll-free route says nothing about tolls.
 *
 * This is deliberately unlike the mainstream tools, which show one estimate for everything and
 * never say which figures they stand behind. Two tiers cost a line of CSS and tell the driver
 * something true.
 *
 * ZERO LOGIC HERE, per `packages/client/CLAUDE.md`: the tier was decided in `shared/toll.ts` and
 * checked in the store. This file chooses words and markup.
 */
import type { ReactElement } from 'react';
import { useStore } from './store.ts';
import type { Instruction, ManeuverType } from '../../shared/index.ts';

/**
 * What each manoeuvre is called on screen.
 *
 * Governed by `rules/copy.md`: no em dash, no en dash, no interpunct anywhere in this table. The
 * roundabout wording is completed at the call site because it carries an exit number.
 */
const PHRASE: Record<ManeuverType, string> = {
  depart: 'Start on',
  'turn-left': 'Turn left onto',
  'turn-right': 'Turn right onto',
  'turn-slight-left': 'Bear left onto',
  'turn-slight-right': 'Bear right onto',
  'turn-sharp-left': 'Sharp left onto',
  'turn-sharp-right': 'Sharp right onto',
  straight: 'Continue onto',
  'roundabout-enter': 'Enter the roundabout',
  'roundabout-exit': 'Leave the roundabout onto',
  merge: 'Merge onto',
  'fork-left': 'Keep left onto',
  'fork-right': 'Keep right onto',
  'u-turn': 'Make a U turn onto',
  arrive: 'Arrive at your destination',
};

/** The arrow shown beside each step. Text, not an icon set, so it survives at any zoom. */
const GLYPH: Record<ManeuverType, string> = {
  depart: '●',
  'turn-left': '←',
  'turn-right': '→',
  'turn-slight-left': '↖',
  'turn-slight-right': '↗',
  'turn-sharp-left': '↙',
  'turn-sharp-right': '↘',
  straight: '↑',
  'roundabout-enter': '↻',
  'roundabout-exit': '↱',
  merge: '↗',
  'fork-left': '↖',
  'fork-right': '↗',
  'u-turn': '↶',
  arrive: '■',
};

function stepText(step: Instruction): string {
  if (step.type === 'arrive') return PHRASE.arrive;
  if (step.type === 'roundabout-enter') return PHRASE['roundabout-enter'];
  if (step.type === 'roundabout-exit') {
    const nth = step.roundaboutExit ?? 1;
    const where = step.roadName === undefined ? '' : ` onto ${step.roadName}`;
    return `Take exit ${nth}${where}`;
  }
  // An unnamed road is the common case in this city, not an error, so it must read as a sentence
  // rather than as a missing value.
  if (step.roadName === undefined) {
    return step.type === 'depart' ? 'Start out' : PHRASE[step.type].replace(/ onto$/, '');
  }
  return `${PHRASE[step.type]} ${step.roadName}`;
}

function distance(m: number): string {
  if (m < 950) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

export function RoutePanel(): ReactElement | null {
  const route = useStore((s) => s.route);
  const routeError = useStore((s) => s.routeError);
  const routing = useStore((s) => s.routing);
  const destination = useStore((s) => s.destination);
  const origin = useStore((s) => s.origin);
  const clearRoute = useStore((s) => s.clearRoute);

  if (routeError !== null) {
    return (
      <section className="panel" data-state="error" role="alert">
        <h2 className="panel-title">No route to show</h2>
        <p className="panel-note">{routeError}</p>
        <button type="button" className="panel-action" onClick={clearRoute}>
          Start again
        </button>
      </section>
    );
  }

  if (routing) {
    return (
      <section className="panel" role="status">
        <h2 className="panel-title">Finding a route</h2>
        <p className="panel-note">Searching the road network.</p>
      </section>
    );
  }

  if (route === null) {
    if (destination === null) return null;
    return (
      <section className="panel" role="status">
        <h2 className="panel-title">{destination.name}</h2>
        <p className="panel-note">Now pick where you are starting from.</p>
        <button type="button" className="panel-action" onClick={clearRoute}>
          Clear
        </button>
      </section>
    );
  }

  return (
    <section className="panel" aria-label="Route">
      <h2 className="panel-title">
        {`${route.km.toFixed(1)} km, ${Math.round(route.driveMinutes)} min`}
      </h2>
      <p className="panel-note">
        {origin === null || destination === null ? 'Route' : `${origin.name} to ${destination.name}`}
      </p>

      {route.tollDisplay === 'exact' && (
        <p className="toll" data-tier="exact">
          <span className="toll-amount">{`₹${Math.round(route.tollRupees)}`}</span>
        </p>
      )}
      {route.tollDisplay === 'estimated' && (
        <p className="toll" data-tier="estimated">
          <span className="toll-label">Tolls</span>
          <span className="toll-amount">{`Estimated cost: ₹${Math.round(route.tollRupees)}`}</span>
        </p>
      )}

      <ol className="steps">
        {route.instructions.map((step, i) => (
          <li className="step" key={`${step.geometryIndex}-${i}`}>
            <span className="step-glyph" aria-hidden="true">{GLYPH[step.type]}</span>
            <span className="step-text">{stepText(step)}</span>
            {i > 0 && <span className="step-distance">{distance(step.distanceM)}</span>}
          </li>
        ))}
      </ol>

      <button type="button" className="panel-action" onClick={clearRoute}>
        Clear
      </button>
    </section>
  );
}
