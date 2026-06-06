import { useState } from 'react'
import TopBar from './components/TopBar'
import MapView from './components/MapView'
import SatellitePanel from './components/SatellitePanel'
import { useSatellites } from './lib/useSatellites'

export default function App() {
  const [selected, setSelected] = useState(null)
  const { satellites, positions, tracks, status } = useSatellites(selected)

  const nextSync = status?.next_sync_in_s
    ? `T-${new Date(status.next_sync_in_s * 1000).toISOString().slice(11, 19)}`
    : '——'

  return (
    <div className="app">
      <TopBar status={status} />

      <div className="main">
        <MapView
          satellites={satellites}
          positions={positions}
          tracks={tracks}
          selected={selected}
          onSelect={setSelected}
          cloudsMeta={status?.clouds}
        />
        <SatellitePanel
          satellites={satellites}
          positions={positions}
          selected={selected}
          onSelect={setSelected}
        />
      </div>

      <footer className="statusbar">
        <span>
          SOURCE <b>{status?.source ?? '——'}</b>
        </span>
        <span>
          NEXT SYNC <b>{nextSync}</b>
        </span>
        <span>
          OBJECTS <b>{status?.satellites_tracked ?? 0}</b>
        </span>
        {status?.clouds && (
          <span>
            CLOUDS <b>IFS tcc +{status.clouds.step_h}h VALID{' '}
            {status.clouds.valid_time.slice(11, 16)}Z</b>
          </span>
        )}
        <span className={status?.last_error ? 'err' : 'ok'}>
          {status?.last_error ? `⚠ ${status.last_error}` : '● NOMINAL'}
        </span>
      </footer>

      <div className="crt-overlay" />
    </div>
  )
}
