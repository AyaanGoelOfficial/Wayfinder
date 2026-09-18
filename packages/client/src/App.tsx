/**
 * The shell: a full-bleed map, one column of chrome down the left, one status chip.
 *
 * Still deliberately sparse. ui.md wants a focal surface 70 to 90 percent empty, and here the map
 * IS the content, so everything else has to earn its pixels. What gate 7 added is one column: the
 * search field, its results, and the route panel. Gate 8 adds the navigation chrome, which is not
 * a second column: it is a banner and a strip that appear only while the vehicle is moving, and
 * the rail recedes to make room for them.
 *
 * The status chip moved to the RIGHT at gate 7. It had shared the top-left corner with nothing;
 * now the search field owns that corner, which is where a person looks first, and the map readout
 * is the least important thing on screen.
 */
import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { MapView } from './map/MapView.tsx';
import type { MapStatus } from './map/MapView.tsx';
import { SearchBox } from './SearchBox.tsx';
import { RoutePanel } from './RoutePanel.tsx';
import { NavPanel, SimPanel } from './NavPanel.tsx';
import { useStore } from './store.ts';
import './index.css';

/**
 * One chip, and it reads the STORE rather than a channel of its own.
 *
 * Precedence, deliberate: a map failure outranks a route failure, which outranks a route summary,
 * which outranks the zoom readout. A map failure comes first because nothing else is usable
 * without tiles, and a route failure says so in its own words rather than borrowing the map's
 * heading.
 *
 * READING THE STORE IS THE GATE 8 CHANGE, and it closed a real disagreement. The summary used to
 * arrive on a callback from the map adapter, the same bypass that left `store.route` empty for a
 * route opened by link. A verification screenshot caught the consequence: the chip said 9 min
 * while the panel below it said 7 min for one route, because the two read different fields.
 *
 * The panel's figure is the correct one, and it is now the only one. `Route.durationS` is the
 * modelled COST and is not a drive time, so minutes come from summing the instruction legs, which
 * are built from per-edge speeds. See `engine/CLAUDE.md`.
 */
function StatusChip({ status }: { readonly status: MapStatus }): ReactElement {
  const route = useStore((s) => s.route);
  const routeError = useStore((s) => s.routeError);

  if (status.kind === 'error') {
    return (
      <div className="status" data-state="error" role="alert">
        <strong>The map could not load</strong>
        {status.message}
      </div>
    );
  }
  if (routeError !== null) {
    return (
      <div className="status" data-state="error" role="alert">
        <strong>No route to show</strong>
        {routeError}
      </div>
    );
  }
  if (route !== null) {
    return (
      <div className="status" data-state="ready" role="status">
        <strong>{`${route.km.toFixed(1)} km, ${Math.round(route.driveMinutes)} min`}</strong>
        {`${route.geometry.length.toLocaleString('en-US')} shape points on the line`}
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
  // Stable identity: MapView's effect depends on it, and a fresh closure each render would tear
  // the map down and rebuild it on every status update.
  const onStatus = useCallback((s: MapStatus) => setStatus(s), []);
  const navigating = useStore((s) => s.tracking.active);
  return (
    <div className="app" data-navigating={navigating ? 'yes' : 'no'}>
      <MapView onStatus={onStatus} />
      {/*
        The rail RECEDES during navigation rather than being replaced by a second layout.
        A driver needs the banner, the trip strip and the map; a search field and a
        seventeen step list are chrome competing with the road. `data-navigating` on the
        root is the only switch, so the two modes cannot drift into two layouts, and the
        rail comes back on hover or focus rather than becoming unreachable.
      */}
      <div className="rail">
        <SearchBox />
        <RoutePanel />
        <SimPanel />
      </div>
      <NavPanel />
      {/* The chip and the trip strip would both be bottom-right chrome. Only one at a time. */}
      {!navigating && <StatusChip status={status} />}
    </div>
  );
}
