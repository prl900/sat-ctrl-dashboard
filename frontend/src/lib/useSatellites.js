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
    return () => {
      cancelled = true
      clearInterval(id)
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
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

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
        if (p) next[sat.norad_id] = p
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
