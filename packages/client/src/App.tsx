/**
 * Gate 2 shell: the map, plus one status chip.
 *
 * Deliberately almost empty. ui.md: a focal surface should be 70 to 90 percent empty, and here
 * the map IS the content, so anything else has to earn its pixels. Search, route entry and the
 * navigation panel arrive at the gates that need them, not before.
 */
import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { MapView } from './map/MapView.tsx';
import type { MapStatus, RouteState } from './map/MapView.tsx';
import './index.css';

/**
 * Precedence, deliberate: a failure outranks a route, and a route outranks the map readout.
 *
 * A map failure comes first because nothing else is usable without tiles. A route failure comes
 * next, and says so in its own words rather than borrowing the map's heading. A route summary
 * outranks the zoom readout, and survives panning, which it did not when the two shared a channel.
 */
function StatusChip({
  status,
  route,
}: {
  readonly status: MapStatus;
  readonly route: RouteState | null;
}): ReactElement {
  if (status.kind === 'error') {
    return (
      <div className="status" data-state="error" role="alert">
        <strong>The map could not load</strong>
        {status.message}
      </div>
    );
  }
  if (route !== null && route.kind === 'error') {
    return (
      <div className="status" data-state="error" role="alert">
        <strong>No route to show</strong>
        {route.message}
      </div>
    );
  }
  if (route !== null) {
    return (
      <div className="status" data-state="ready" role="status">
        <strong>{`${route.km.toFixed(1)} km, ${Math.round(route.minutes)} min`}</strong>
        {`${route.points.toLocaleString('en-US')} shape points on the line`}
      </div>
    );
  }
  if (status.kind === 'loading') {
    return (
      <div className="status" data-state="loading" role="status">
        <strong>Loading the map</strong>
        Reading tiles from the local archive.
      </div>
    );
  }
  return (
    <div className="status" data-state="ready" role="status">
      <strong>Wayfinder GN</strong>
      {`zoom ${status.zoom.toFixed(2)} at ${status.center[1].toFixed(4)}, ${status.center[0].toFixed(4)}`}
    </div>
  );
}

export function App(): ReactElement {
  const [status, setStatus] = useState<MapStatus>({ kind: 'loading' });
  const [route, setRoute] = useState<RouteState | null>(null);
  // Stable identity: MapView's effect depends on both, and a fresh closure each render would
  // tear the map down and rebuild it on every status update.
  const onStatus = useCallback((s: MapStatus) => setStatus(s), []);
  const onRoute = useCallback((r: RouteState) => setRoute(r), []);
  return (
    <div className="app">
      <MapView onStatus={onStatus} onRoute={onRoute} />
      <StatusChip status={status} route={route} />
    </div>
  );
}
