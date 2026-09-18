/**
 * Navigation chrome: the maneuver banner, the trip strip, and the honest failure states.
 *
 * ZERO LOGIC HERE, per `packages/client/CLAUDE.md`. Every number on screen was decided in the
 * store or in `shared/tracking.ts`: the ETA already passed through its hysteresis, the distance
 * to the maneuver was already rounded to what changes the text. This file picks words and markup.
 *
 * THE BANNER IS THE ONE THING READ AT SPEED, so it is the largest text in the product and it
 * carries exactly two facts: what to do, and how far away it is. Everything else about the trip
 * lives in the strip below it, which is read at rest.
 *
 * Governed by `rules/copy.md`: no em dash, no en dash, no interpunct in any string here.
 */
import type { ReactElement } from 'react';
import { useStore } from './store.ts';
import { GLYPH, distance, duration, stepText } from './maneuvers.ts';

/**
 * What each degraded state says, and what the person can DO about it. Charter item 10.
 *
 * A state with no remedy is a state that reads as a bug. "Waiting for GPS" is a fact; "hold still
 * for a moment, or check that location is on for this site" is something to act on.
 */
function qualityNotice(quality: string): { title: string; remedy: string } | null {
  if (quality === 'denied') {
    return {
      title: 'Location is blocked',
      remedy: 'Allow location for this site in your browser settings, then start tracking again.',
    };
  }
  if (quality === 'lost') {
    return {
      title: 'No position yet',
      remedy: 'Waiting for a fix. Move somewhere with a clear view of the sky.',
    };
  }
  if (quality === 'poor') {
    return {
      title: 'Weak position',
      remedy: 'The dot may drift until the signal improves.',
    };
  }
  return null;
}

/** Clock time of arrival, from the remaining seconds. Local time, as a driver reads a clock. */
function arrivalClock(remainingS: number): string {
  const at = new Date(Date.now() + remainingS * 1000);
  const h = at.getHours();
  const m = at.getMinutes();
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function NavPanel(): ReactElement | null {
  const tracking = useStore((s) => s.tracking);
  const route = useStore((s) => s.route);
  const setFollowing = useStore((s) => s.setFollowing);
  const stopTracking = useStore((s) => s.stopTracking);

  if (!tracking.active) return null;

  const notice = qualityNotice(tracking.quality);
  const step =
    route === null || tracking.instructionIndex < 0
      ? null
      : (route.instructions[tracking.instructionIndex] ?? null);

  return (
    <>
      {step !== null && (
        <div className="banner" role="status" aria-live="polite" data-phase={tracking.phase}>
          <span className="banner-glyph" aria-hidden="true">{GLYPH[step.type]}</span>
          <span className="banner-body">
            <span className="banner-distance">{distance(tracking.metresToManeuver)}</span>
            <span className="banner-text">{stepText(step)}</span>
          </span>
        </div>
      )}

      {tracking.phase === 'rerouting' && (
        <div className="banner" role="status" data-phase="rerouting">
          <span className="banner-glyph" aria-hidden="true">↻</span>
          <span className="banner-body">
            <span className="banner-text">Off route, finding a new one</span>
          </span>
        </div>
      )}

      {notice !== null && (
        <div className="notice" role="alert" data-quality={tracking.quality}>
          <strong>{notice.title}</strong>
          {notice.remedy}
        </div>
      )}

      <div className="trip" role="status">
        <span className="trip-eta">{duration(tracking.remainingS)}</span>
        <span className="trip-rest">
          {`${distance(tracking.remainingM)}, arriving ${arrivalClock(tracking.remainingS)}`}
        </span>
        {!tracking.following && (
          <button type="button" className="trip-recentre" onClick={() => setFollowing(true)}>
            Re centre
          </button>
        )}
        <button type="button" className="trip-stop" onClick={stopTracking}>
          Stop
        </button>
      </div>
    </>
  );
}

/**
 * The simulator controls. DEV ONLY, and stripped from a production bundle by `import.meta.env.DEV`.
 *
 * This is the instrument, not a toy: all tracking development and the five browser scenarios run
 * against it, and the phone is for final verification only. It is exposed in the UI because a
 * simulator you have to edit code to reconfigure is a simulator nobody varies.
 */
export function SimPanel(): ReactElement | null {
  const tracking = useStore((s) => s.tracking);
  const route = useStore((s) => s.route);
  const startTracking = useStore((s) => s.startTracking);
  const stopTracking = useStore((s) => s.stopTracking);
  const setSimSpeed = useStore((s) => s.setSimSpeed);
  const setSimNoise = useStore((s) => s.setSimNoise);
  const setSimDropout = useStore((s) => s.setSimDropout);
  const toggleDeviate = useStore((s) => s.toggleDeviate);

  if (!import.meta.env.DEV) return null;
  if (route === null) return null;

  return (
    <section className="sim" aria-label="Tracking simulator">
      <h2 className="panel-title">Simulator</h2>
      {!tracking.active ? (
        <div className="sim-row">
          <button type="button" className="panel-action" onClick={() => startTracking('simulator')}>
            Drive this route
          </button>
          <button type="button" className="sim-secondary" onClick={() => startTracking('device')}>
            Use real GPS
          </button>
        </div>
      ) : (
        <div className="sim-row">
          <button type="button" className="panel-action" onClick={stopTracking}>
            Stop
          </button>
          <button
            type="button"
            className="sim-secondary"
            data-on={tracking.deviating ? 'yes' : 'no'}
            onClick={toggleDeviate}
          >
            {tracking.deviating ? 'Rejoin route' : 'Drive off route'}
          </button>
        </div>
      )}

      <label className="sim-field">
        <span>{`Speed ${tracking.simSpeedMps} m/s`}</span>
        <input
          type="range"
          min={2}
          max={33}
          step={1}
          value={tracking.simSpeedMps}
          onChange={(e) => setSimSpeed(Number(e.target.value))}
        />
      </label>
      <label className="sim-field">
        <span>{`Noise ${tracking.simNoiseSigmaM} m`}</span>
        <input
          type="range"
          min={0}
          max={30}
          step={1}
          value={tracking.simNoiseSigmaM}
          onChange={(e) => setSimNoise(Number(e.target.value))}
        />
      </label>
      <label className="sim-field">
        <span>{`Dropouts ${Math.round(tracking.simDropout * 100)}%`}</span>
        <input
          type="range"
          min={0}
          max={80}
          step={5}
          value={Math.round(tracking.simDropout * 100)}
          onChange={(e) => setSimDropout(Number(e.target.value) / 100)}
        />
      </label>

      <p className="sim-stats">
        {`${tracking.accepted} fixes accepted, ${tracking.rejectedTotal} rejected, ${tracking.reroutes} reroutes`}
      </p>
      <p className="sim-stats">
        {`accuracy ${tracking.accuracyM} m, ${tracking.quality}, ${tracking.phase}`}
      </p>
    </section>
  );
}
