import { useEffect, useState } from 'react'

function pad(n) {
  return String(n).padStart(2, '0')
}

function dayOfYear(d) {
  return Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000)
}

export default function TopBar({ status }) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 250)
    return () => clearInterval(id)
  }, [])

  const syncOk = status && !status.last_error && status.satellites_tracked > 0
  const lastSync = status?.last_sync
    ? new Date(status.last_sync).toISOString().slice(11, 19) + 'Z'
    : '--:--:--'

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <div className="brand-mark" />
        <div>
          <div className="brand-text">
            SAT-<em>CTRL</em>
          </div>
          <div className="brand-sub">EARTH OBSERVATION // ORBIT TRACKING</div>
        </div>
      </div>

      <div className="topbar-clock">
        <div className="clock-time">
          {pad(now.getUTCHours())}:{pad(now.getUTCMinutes())}:{pad(now.getUTCSeconds())} UTC
        </div>
        <div className="clock-date">
          {now.toISOString().slice(0, 10)} // DOY {pad(dayOfYear(now))}
        </div>
      </div>

      <div className="topbar-status">
        <div className="sync-block">
          <span className="sync-label">TLE UPLINK</span>
          <span className={`sync-value ${syncOk ? 'ok' : 'err'}`}>
            {syncOk ? `SYNC ${lastSync}` : status ? 'DEGRADED' : 'ACQUIRING'}
          </span>
        </div>
        <div className="live-chip">
          <span className="live-dot" />
          LIVE
        </div>
      </div>
    </header>
  )
}
