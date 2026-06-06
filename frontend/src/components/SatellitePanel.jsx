function fmt(v, digits = 2) {
  return v === undefined || v === null ? '——' : v.toFixed(digits)
}

function SatCard({ sat, pos, selected, onSelect }) {
  const tleStale = sat.tle && sat.tle.age_hours > 48

  return (
    <div
      className={`sat-card ${selected ? 'selected' : ''} ${tleStale ? 'stale' : ''}`}
      style={{ '--sat-color': sat.color }}
      onClick={() => onSelect(selected ? null : sat.norad_id)}
    >
      <div className="sat-card-head">
        <span className="swatch" />
        <span className="name">{sat.name}</span>
        {pos && (
          <span className={`sun-badge ${pos.sunlit ? 'day' : 'night'}`}>
            {pos.sunlit ? '☀ SUNLIT' : '☾ ECLIPSE'}
          </span>
        )}
        <span className="agency">{sat.agency}</span>
      </div>

      <div className="readouts">
        <div className="readout">
          <div className="k">LAT</div>
          <div className="v">
            {fmt(pos?.lat)}
            <span className="u">°</span>
          </div>
        </div>
        <div className="readout">
          <div className="k">LON</div>
          <div className="v">
            {fmt(pos?.lon)}
            <span className="u">°</span>
          </div>
        </div>
        <div className="readout">
          <div className="k">ALT</div>
          <div className="v">
            {fmt(pos?.alt, 1)}
            <span className="u">km</span>
          </div>
        </div>
        <div className="readout">
          <div className="k">VEL</div>
          <div className="v">
            {fmt(pos?.velocity)}
            <span className="u">km/s</span>
          </div>
        </div>
      </div>

      <div className="sat-card-meta">
        {sat.orbit && (
          <>
            <span>
              PERIOD <b>{sat.orbit.period_min.toFixed(1)} min</b>
            </span>
            <span>
              INC <b>{sat.orbit.inclination_deg.toFixed(2)}°</b>
            </span>
          </>
        )}
        <span>
          SENSOR <b>{sat.sensor.split(' ')[0]}</b>
        </span>
        <span>
          SWATH <b>{sat.swath_km} km</b>
        </span>
        {sat.tle && (
          <span className="tle-age">
            TLE AGE <b>{sat.tle.age_hours.toFixed(1)} h</b>
          </span>
        )}
      </div>
    </div>
  )
}

export default function SatellitePanel({ satellites, positions, selected, onSelect }) {
  const tracking = satellites.filter((s) => s.tle).length

  return (
    <aside className="panel">
      <div className="panel-header">
        <span>TELEMETRY</span>
        <b>
          {tracking}/{satellites.length} TRK
        </b>
      </div>
      {satellites.length === 0 && <div className="no-signal">AWAITING UPLINK…</div>}
      {satellites.map((sat) => (
        <SatCard
          key={sat.norad_id}
          sat={sat}
          pos={positions[sat.norad_id]}
          selected={selected === sat.norad_id}
          onSelect={onSelect}
        />
      ))}
    </aside>
  )
}
