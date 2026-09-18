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
import { GLYPH, distance, stepText } from './maneuvers.ts';

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

      {(route.originApproach !== null || route.destinationApproach !== null) && (
        <p className="approach" role="note">
          {route.originApproach !== null && (
            <span className="approach-leg">{`${distance(route.originApproach.metres)} on foot to the road`}</span>
          )}
          {route.destinationApproach !== null && (
            <span className="approach-leg">{`Then ${distance(route.destinationApproach.metres)} on foot`}</span>
          )}
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
