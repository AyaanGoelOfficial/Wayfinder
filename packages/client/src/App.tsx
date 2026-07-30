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
import type { MapStatus } from './map/MapView.tsx';
import './index.css';

function StatusChip({ status }: { readonly status: MapStatus }): ReactElement {
  if (status.kind === 'loading') {
    return (
      <div className="status" data-state="loading" role="status">
        <strong>Loading the map</strong>
        Reading tiles from the local archive.
      </div>
    );
  }
  if (status.kind === 'error') {
    return (
      <div className="status" data-state="error" role="alert">
        <strong>The map could not load</strong>
        {status.message}
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
  // Stable identity: MapView's effect depends on this, and a fresh closure each render would
  // tear the map down and rebuild it on every status update.
  const onStatus = useCallback((s: MapStatus) => setStatus(s), []);
  return (
    <div className="app">
      <MapView onStatus={onStatus} />
      <StatusChip status={status} />
    </div>
  );
}
