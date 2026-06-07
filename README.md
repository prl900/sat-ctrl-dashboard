# SAT-CTRL — Real-Time EO Satellite Tracking Dashboard

**Live at [satctrl.live](https://satctrl.live)**

Mission-control style dashboard tracking **Sentinel-2A/B/C** and **Landsat 8/9** in real time: live positions, ground tracks, sensor footprints, current cloud cover and TLE-derived telemetry on a dark ops-room map.

## How it works

```
CelesTrak (every 6 h) ──► FastAPI backend ──► GET /api/satellites  (TLEs + metadata)
                           in-mem + JSON cache       │
                                                     ▼
                                        React frontend (refreshes TLEs every 30 min)
                                        satellite.js propagates SGP4 client-side at
                                        1 Hz → MapLibre map + telemetry panel
```

- **Data source**: [CelesTrak GP API](https://celestrak.org/NORAD/elements/) (`GROUP=resource`) — free, no auth, USSPACECOM-sourced element sets, refreshed ~daily. One request per 6 h sync; TLEs are cached to `backend/data/tle_cache.json` so the app survives restarts and CelesTrak outages.
- **Cloud overlay**: [ECMWF IFS open data](https://www.ecmwf.int/en/forecasts/datasets/open-data) (0.25°, CC-BY-4.0). Every 30 min the backend finds the newest published cycle, byte-range-downloads only the `tcc` (total cloud cover) GRIB message for the 3-hourly step nearest to now (~1–2 MB via the `.index` file), and renders it to a Web-Mercator translucent PNG served at `/api/clouds.png`. Toggleable on the map (`☁ CLOUDS`).
- **No database** — no historical data is kept; the freshest TLE per satellite lives in memory.
- **All real-time math runs in the browser** (satellite.js SGP4): positions, ground tracks (±1 orbit, antimeridian-safe), speed, sunlit/eclipse state, sensor footprint.

| Satellite | NORAD ID | Sensor | Swath |
|---|---|---|---|
| Sentinel-2A | 40697 | MSI | 290 km |
| Sentinel-2B | 42063 | MSI | 290 km |
| Sentinel-2C | 60989 | MSI | 290 km |
| Landsat 8 | 39084 | OLI + TIRS | 185 km |
| Landsat 9 | 49260 | OLI-2 + TIRS-2 | 185 km |

## Running

### Backend (FastAPI, Python ≥3.11)

```bash
cd backend
uv sync                                # or: pip install -e .
uv run uvicorn app.main:app --port 8000
```

- `GET /api/satellites` — catalog + latest TLE + derived orbit constants
- `GET /api/status` — sync health (used by the top-bar uplink indicator)

### Frontend (React + Vite)

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173 (proxies /api to :8000)
```

### Production

`npm run build` produces `frontend/dist`; the backend serves it automatically at `/` when present — single-process deploy:

```bash
cd backend && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## UI

- **Top bar** — UTC mission clock with day-of-year, TLE uplink status, LIVE indicator.
- **Map** — self-rendered basemap from bundled [Natural Earth](https://www.naturalearthdata.com/) vectors (public domain: slate land, coastlines, country borders over navy ocean — no tile service or API key), 30° graticule, per-satellite past track (dashed) and future track (solid + glow), pulsing markers. Click a marker or card to select: the map flies to the satellite and shows its sensor-swath footprint.
- **Telemetry panel** — per satellite: LAT / LON / ALT / VEL at 1 Hz, ☀ SUNLIT / ☾ ECLIPSE state, orbital period, inclination, sensor, swath, TLE age (amber when >48 h stale).
- **Status strip** — data source, next-sync countdown, tracked object count, system state.

## Extending

Add a satellite by appending one entry to `backend/app/catalog.py` (NORAD ID + metadata). If it isn't in CelesTrak's `resource` group, widen the query in `backend/app/tle_sync.py`.

If you ever need multi-instance deployment or historical tracks: swap the in-memory store for Redis (shared cache) or add SQLite/TimescaleDB for history — the `TLEStore` interface in `tle_sync.py` is the only thing to change.

## Contributing

Contributions are very welcome! Some ideas:

- More satellites (anything in CelesTrak's `resource` group is a one-entry change in `backend/app/catalog.py`)
- Pass predictions ("next overpass of <location>"), acquisition-plan overlays
- Higher-resolution clouds when ECMWF's 9 km open data lands, or NASA GIBS true-color imagery as an alternative layer
- 3D globe view (CesiumJS), mobile layout, accessibility

Open an issue to discuss bigger changes, or just send a PR for fixes and small improvements. Keep the mission-control aesthetic — dark, monospace, calm.

## License

[MIT](LICENSE) — free to use, modify and redistribute. Data sources retain their own terms: ECMWF open data is CC-BY-4.0, Natural Earth is public domain, CelesTrak GP data is publicly released by 18 SDS.
