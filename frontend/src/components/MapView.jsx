import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { footprintRing, nightPolygon } from '../lib/propagation'

const BASEMAP_STYLE = {
  version: 8,
  sources: {
    carto: {
      type: 'raster',
      tiles: ['a', 'b', 'c', 'd'].map(
        (s) => `https://${s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png`,
      ),
      tileSize: 256,
      attribution:
        '© OpenStreetMap contributors © CARTO · Clouds: ECMWF Open Data (CC-BY-4.0)',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#05080e' } },
    {
      id: 'carto',
      type: 'raster',
      source: 'carto',
      // lifted brightness/contrast so landmasses stay readable under clouds
      paint: {
        'raster-opacity': 1,
        'raster-saturation': -0.3,
        'raster-contrast': 0.25,
        'raster-brightness-max': 1,
        'raster-brightness-min': 0.05,
      },
    },
  ],
}

function graticule(stepDeg = 30) {
  const lines = []
  for (let lon = -180; lon <= 180; lon += stepDeg) {
    lines.push([
      [lon, -85],
      [lon, 85],
    ])
  }
  for (let lat = -60; lat <= 60; lat += stepDeg) {
    lines.push([
      [-180, lat],
      [180, lat],
    ])
  }
  return {
    type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates: lines },
  }
}

const EMPTY_FC = { type: 'FeatureCollection', features: [] }

function footprintFeature(sat, p) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [footprintRing(p.lat, p.lon, sat.swath_km / 2)],
    },
  }
}

const MERC_LAT = 85.05112878
// one quad is enough: image sources repeat across world copies like tiles
const CLOUD_CORNERS = [
  [-180, MERC_LAT],
  [180, MERC_LAT],
  [180, -MERC_LAT],
  [-180, -MERC_LAT],
]

// Pacific-centred frame: camera locked to one 360° span from the mid-Atlantic
// (Africa on the left edge, Americas on the right, Pacific in the middle).
const VIEW_WEST = -25
const wrapLon = (lon) => (lon < VIEW_WEST ? lon + 360 : lon)

export default function MapView({ satellites, positions, tracks, selected, onSelect, cloudsMeta }) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef({}) // norad_id -> {marker, el}
  const layersRef = useRef(new Set())
  const [mapReady, setMapReady] = useState(false)
  const [mapError, setMapError] = useState(null)

  // keep latest onSelect without rebinding marker listeners
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  // --- map init -------------------------------------------------------
  useEffect(() => {
    // optional initial view via URL: ?lon=..&lat=..&zoom=..
    const params = new URLSearchParams(window.location.search)
    let map
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: BASEMAP_STYLE,
        center: [wrapLon(Number(params.get('lon') ?? 155)), Number(params.get('lat') ?? 12)],
        zoom: Number(params.get('zoom') ?? 2),
        // copies let geometry draw across the dateline; the min-zoom lock set
        // on load keeps the viewport ≤ 360° wide, so panning freely (with
        // wrap-around) never shows the same location twice
        renderWorldCopies: true,
        attributionControl: { compact: true },
      })
    } catch (e) {
      // e.g. WebGL unavailable — keep the telemetry panel alive
      console.error('Map init failed:', e)
      setMapError(true)
      return undefined
    }
    map.on('load', () => {
      // fill the viewport width with exactly one world span (unless the
      // URL pins an explicit view), and forbid zooming out beyond it —
      // narrower-than-viewport worlds put the bounds constraint in a
      // degenerate state with markers landing off-screen
      if (!params.has('lon') && !params.has('zoom')) {
        map.fitBounds(
          [
            [VIEW_WEST, -60],
            [VIEW_WEST + 359.99, 60],
          ],
          { animate: false },
        )
      }
      map.setMinZoom(Math.min(map.getZoom(), 2.5))
      map.addSource('graticule', { type: 'geojson', data: graticule() })
      map.addLayer({
        id: 'graticule',
        type: 'line',
        source: 'graticule',
        paint: { 'line-color': '#1b2940', 'line-width': 0.6, 'line-opacity': 0.6 },
      })
      // day/night shading — sat tracks are added later so they draw on top
      map.addSource('night', { type: 'geojson', data: nightPolygon(new Date()) })
      map.addLayer({
        id: 'night',
        type: 'fill',
        source: 'night',
        paint: { 'fill-color': '#010409', 'fill-opacity': 0.5 },
      })
      map.addLayer({
        id: 'terminator',
        type: 'line',
        source: 'night',
        paint: {
          'line-color': '#4a6fa5',
          'line-width': 1,
          'line-opacity': 0.55,
          'line-dasharray': [3, 3],
        },
      })
      setMapReady(true)
    })
    mapRef.current = map
    window.__map = map // debugging hook
    return () => map.remove()
  }, [])

  // --- ECMWF cloud overlay: (re)load when a new field is valid -----------
  const [cloudsOn, setCloudsOn] = useState(true)
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !cloudsMeta?.valid_time) return
    const url = `/api/clouds.png?v=${encodeURIComponent(cloudsMeta.valid_time)}`
    const src = map.getSource('clouds')
    if (src) {
      src.updateImage({ url, coordinates: CLOUD_CORNERS })
    } else {
      map.addSource('clouds', { type: 'image', url, coordinates: CLOUD_CORNERS })
      // above the basemap, below graticule / night shading / tracks
      map.addLayer(
        {
          id: 'clouds',
          type: 'raster',
          source: 'clouds',
          paint: { 'raster-opacity': 0.15, 'raster-fade-duration': 0 },
        },
        'graticule',
      )
    }
  }, [mapReady, cloudsMeta?.valid_time])

  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map.getLayer('clouds')) return
    map.setLayoutProperty('clouds', 'visibility', cloudsOn ? 'visible' : 'none')
  }, [mapReady, cloudsOn, cloudsMeta?.valid_time])

  // --- day/night terminator refresh (moves ~0.25°/min) -------------------
  useEffect(() => {
    if (!mapReady) return
    const id = setInterval(() => {
      mapRef.current.getSource('night')?.setData(nightPolygon(new Date()))
    }, 60 * 1000)
    return () => clearInterval(id)
  }, [mapReady])

  // --- per-satellite track layers + markers ----------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !satellites.length) return

    for (const sat of satellites) {
      const id = sat.norad_id
      if (layersRef.current.has(id)) continue
      layersRef.current.add(id)

      map.addSource(`past-${id}`, { type: 'geojson', data: EMPTY_FC })
      map.addSource(`future-${id}`, { type: 'geojson', data: EMPTY_FC })
      map.addSource(`footprint-${id}`, { type: 'geojson', data: EMPTY_FC })

      // per-chunk `opacity` property tapers trails away from the satellite
      map.addLayer({
        id: `past-${id}`,
        type: 'line',
        source: `past-${id}`,
        paint: {
          'line-color': sat.color,
          'line-width': 1.2,
          'line-opacity': ['get', 'opacity'],
          'line-dasharray': [1.5, 2.5],
        },
      })
      // soft glow under the future track
      map.addLayer({
        id: `future-glow-${id}`,
        type: 'line',
        source: `future-${id}`,
        paint: {
          'line-color': sat.color,
          'line-width': 5,
          'line-opacity': ['*', 0.14, ['get', 'opacity']],
        },
      })
      map.addLayer({
        id: `future-${id}`,
        type: 'line',
        source: `future-${id}`,
        paint: {
          'line-color': sat.color,
          'line-width': 1.6,
          'line-opacity': ['get', 'opacity'],
        },
      })
      map.addLayer({
        id: `footprint-${id}`,
        type: 'fill',
        source: `footprint-${id}`,
        paint: { 'fill-color': sat.color, 'fill-opacity': 0.12, 'fill-outline-color': sat.color },
      })

      const el = document.createElement('div')
      el.className = 'sat-marker'
      el.style.setProperty('--sat-color', sat.color)
      el.innerHTML = `<span class="ring"></span><span class="dot"></span><span class="tag">${sat.name}</span>`
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        onSelectRef.current(id)
      })
      const marker = new maplibregl.Marker({ element: el }).setLngLat([0, 0]).addTo(map)
      markersRef.current[id] = { marker, el }
    }
  }, [mapReady, satellites])

  // --- live position updates + selected footprint tracking --------------
  useEffect(() => {
    if (!mapReady) return
    for (const [id, { marker, el }] of Object.entries(markersRef.current)) {
      const p = positions[id]
      if (!p) continue
      marker.setLngLat([p.lon, p.lat])
      el.classList.toggle('selected', Number(id) === selected)
    }
    const sat = satellites.find((s) => s.norad_id === selected)
    if (sat && positions[selected]) {
      mapRef.current
        .getSource(`footprint-${selected}`)
        ?.setData(footprintFeature(sat, positions[selected]))
    }
  }, [mapReady, positions, selected, satellites])

  // --- track updates ----------------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady) return
    for (const [id, t] of Object.entries(tracks)) {
      map.getSource(`past-${id}`)?.setData(t.past)
      map.getSource(`future-${id}`)?.setData(t.future)
    }
  }, [mapReady, tracks])

  // --- selection change: clear stale footprints, fly to target ----------
  useEffect(() => {
    const map = mapRef.current
    if (!mapReady) return
    for (const sat of satellites) {
      if (sat.norad_id !== selected) {
        map.getSource(`footprint-${sat.norad_id}`)?.setData(EMPTY_FC)
      }
    }
    if (selected && positions[selected]) {
      map.flyTo({
        center: [wrapLon(positions[selected].lon), positions[selected].lat],
        zoom: 3,
        speed: 0.9,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, selected])

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map-container" />
      {mapError && <div className="no-signal map-offline">MAP OFFLINE // WEBGL UNAVAILABLE</div>}
      <div className="map-frame">
        <i /><i /><i /><i />
      </div>
      <div className="map-watermark">GROUND TRACK PROJECTION // WGS84 · SGP4</div>
      {cloudsMeta && (
        <button
          className={`map-toggle ${cloudsOn ? 'on' : ''}`}
          onClick={() => setCloudsOn((v) => !v)}
          title={`ECMWF IFS tcc — valid ${cloudsMeta.valid_time}`}
        >
          ☁ CLOUDS {cloudsOn ? 'ON' : 'OFF'}
        </button>
      )}
    </div>
  )
}
