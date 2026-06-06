// Data layer: fetch TLEs + metadata from the backend, then drive a 1 Hz
// propagation tick (positions) and a 30 s track recompute, all client-side.

import { useEffect, useRef, useState } from 'react'
import { makeSatrec, getPosition, getGroundTrack } from './propagation'

const TLE_REFRESH_MS = 30 * 60 * 1000 // backend syncs every 6 h; poll lightly
const STATUS_REFRESH_MS = 60 * 1000
const TRACK_REFRESH_MS = 30 * 1000

export function useSatellites(selected) {
  const [satellites, setSatellites] = useState([])
  const [status, setStatus] = useState(null)
  const [positions, setPositions] = useState({})
  const [tracks, setTracks] = useState({})
  const satrecs = useRef({})
  const cloudGrid = useRef(null) // {data: Uint8Array, w, h}

  // --- TLE + metadata fetch -------------------------------------------
  useEffect(() => {
    let cancelled = false
    async function fetchSats() {
      try {
        const res = await fetch('/api/satellites')
        const data = await res.json()
        if (cancelled) return
        const withTle = data.filter((s) => s.tle)
        satrecs.current = Object.fromEntries(
          withTle.map((s) => [s.norad_id, makeSatrec(s.tle)]),
        )
        setSatellites(data)
      } catch (e) {
        console.error('TLE fetch failed', e)
      }
    }
    fetchSats()
    const id = setInterval(fetchSats, TLE_REFRESH_MS)
    // kiosk mode: resync immediately when the display/tab becomes visible
    // again (browser timers are throttled while hidden)
    const onVisible = () => document.visibilityState === 'visible' && fetchSats()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // --- backend sync status ----------------------------------------------
  useEffect(() => {
    let cancelled = false
    async function fetchStatus() {
      try {
        const [stat, clouds] = await Promise.all([
          fetch('/api/status').then((r) => r.json()),
          fetch('/api/clouds/meta').then((r) => r.json()),
        ])
        if (!cancelled) setStatus({ ...stat, clouds: clouds.meta })
      } catch {
        if (!cancelled) setStatus((s) => (s ? { ...s, last_error: 'API unreachable' } : null))
      }
    }
    fetchStatus()
    const id = setInterval(fetchStatus, STATUS_REFRESH_MS)
    const onVisible = () => document.visibilityState === 'visible' && fetchStatus()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // --- kiosk self-healing: reload on new deploy, plus a daily safety reload
  const initialRevision = useRef(null)
  useEffect(() => {
    if (!status?.revision) return
    if (initialRevision.current === null) {
      initialRevision.current = status.revision
    } else if (status.revision !== initialRevision.current) {
      window.location.reload() // new backend/frontend revision deployed
    }
  }, [status?.revision])

  useEffect(() => {
    const id = setTimeout(() => window.location.reload(), 24 * 3600 * 1000)
    return () => clearTimeout(id)
  }, [])

  // --- raw cloud-cover grid for subpoint sampling (refetch per new field) --
  useEffect(() => {
    if (!status?.clouds?.valid_time) return
    let cancelled = false
    fetch(`/api/clouds/grid?v=${encodeURIComponent(status.clouds.valid_time)}`)
      .then(async (res) => {
        if (!res.ok) return
        const w = Number(res.headers.get('X-Grid-Width'))
        const h = Number(res.headers.get('X-Grid-Height'))
        const data = new Uint8Array(await res.arrayBuffer())
        if (!cancelled && w && h && data.length === w * h) {
          cloudGrid.current = { data, w, h }
        }
      })
      .catch(() => {}) // keep the previous grid on failure
    return () => {
      cancelled = true
    }
  }, [status?.clouds?.valid_time])

  // --- 1 Hz position tick -------------------------------------------------
  useEffect(() => {
    if (!satellites.length) return
    function tick() {
      const now = new Date()
      const next = {}
      for (const sat of satellites) {
        const rec = satrecs.current[sat.norad_id]
        if (!rec) continue
        const p = getPosition(rec, now)
        if (p) {
          p.cloudPct = sampleCloud(cloudGrid.current, p.lat, p.lon)
          next[sat.norad_id] = p
        }
      }
      setPositions(next)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [satellites])

  // --- ground tracks (cheap to recompute every 30 s) ---------------------
  // Selected satellite gets a full ±1-orbit track; the rest a short trail.
  useEffect(() => {
    if (!satellites.length) return
    function recompute() {
      const now = new Date()
      const next = {}
      for (const sat of satellites) {
        const rec = satrecs.current[sat.norad_id]
        if (!rec || !sat.orbit) continue
        next[sat.norad_id] = getGroundTrack(
          rec,
          now,
          sat.orbit.period_min,
          sat.norad_id === selected,
        )
      }
      setTracks(next)
    }
    recompute()
    const id = setInterval(recompute, TRACK_REFRESH_MS)
    return () => clearInterval(id)
  }, [satellites, selected])

  return { satellites, positions, tracks, status }
}

/** Nearest-cell lookup in the 0.5° cover grid (row 0 = 90°N, col 0 = 180°W). */
function sampleCloud(grid, lat, lon) {
  if (!grid) return null
  const row = Math.min(grid.h - 1, Math.max(0, Math.round(((90 - lat) / 180) * (grid.h - 1))))
  const col = Math.min(grid.w - 1, Math.max(0, Math.round(((lon + 180) / 360) * (grid.w - 1))))
  return grid.data[row * grid.w + col]
}
