/**
 * The shell: a full-bleed map, one column of chrome down the left, one status chip.
 *
 * Still deliberately sparse. ui.md wants a focal surface 70 to 90 percent empty, and here the map
 * IS the content, so everything else has to earn its pixels. What gate 7 added is one column: the
 * search field, its results, and the route panel. Nothing else, and no second column.
 *
 * The status chip moved to the RIGHT at gate 7. It had shared the top-left corner with nothing;
 * now the search field owns that corner, which is where a person looks first, and the map readout
 * is the least important thing on screen.
 */
import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { MapView } from './map/MapView.tsx';
import type { MapStatus, RouteState } from './map/MapView.tsx';
import { SearchBox } from './SearchBox.tsx';
import { RoutePanel } from './RoutePanel.tsx';
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
      <div className="rail">
        <SearchBox />
        <RoutePanel />
      </div>
      <StatusChip status={status} route={route} />
    </div>
  );
}
