"""SAT-CTRL backend.

Serves the satellite catalog enriched with the latest TLEs synced from
CelesTrak. All real-time propagation happens client-side (satellite.js);
this API only provides element sets, derived orbit constants and sync
status. In production it also serves the built frontend from
frontend/dist if present.
"""

import asyncio
import logging
import math
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sgp4.api import Satrec

from . import models
from .catalog import SATELLITES
from .clouds import store as cloud_store
from .tle_sync import SYNC_INTERVAL, store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

EARTH_RADIUS_KM = 6378.137
MU_KM3_S2 = 398600.4418  # Earth gravitational parameter

FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    store.load_cache()  # serve cached TLEs immediately while first sync runs
    sync_task = asyncio.create_task(store.run_forever())
    clouds_task = asyncio.create_task(cloud_store.run_forever())
    yield
    sync_task.cancel()
    clouds_task.cancel()


app = FastAPI(title="SAT-CTRL", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


def _orbit_from_tle(line1: str, line2: str) -> models.Orbit:
    satrec = Satrec.twoline2rv(line1, line2)
    n_rad_s = satrec.no_kozai / 60.0  # sgp4 mean motion is rad/min
    a_km = (MU_KM3_S2 / n_rad_s**2) ** (1 / 3)
    return models.Orbit(
        period_min=2 * math.pi / n_rad_s / 60.0,
        inclination_deg=math.degrees(satrec.inclo),
        eccentricity=satrec.ecco,
        apogee_km=a_km * (1 + satrec.ecco) - EARTH_RADIUS_KM,
        perigee_km=a_km * (1 - satrec.ecco) - EARTH_RADIUS_KM,
    )


def _age_hours(epoch_iso: str) -> float:
    epoch = datetime.fromisoformat(epoch_iso)
    return (datetime.now(timezone.utc) - epoch).total_seconds() / 3600.0


@app.get("/api/satellites", response_model=list[models.Satellite])
def get_satellites():
    out = []
    for sat in SATELLITES:
        entry = models.Satellite(**sat)
        tle = store.tles.get(sat["norad_id"])
        if tle:
            entry.tle = models.TLE(
                line1=tle["line1"],
                line2=tle["line2"],
                epoch=tle["epoch"],
                age_hours=round(_age_hours(tle["epoch"]), 2),
            )
            entry.orbit = _orbit_from_tle(tle["line1"], tle["line2"])
        out.append(entry)
    return out


@app.get("/api/status", response_model=models.Status)
def get_status():
    next_sync_in_s = None
    if store.last_sync:
        elapsed = (datetime.now(timezone.utc) - datetime.fromisoformat(store.last_sync)).total_seconds()
        next_sync_in_s = max(0.0, SYNC_INTERVAL - elapsed)
    return models.Status(
        revision=os.environ.get("K_REVISION", "dev"),  # Cloud Run revision
        last_sync=store.last_sync,
        last_error=store.last_error,
        next_sync_in_s=next_sync_in_s,
        source="celestrak.org (GROUP=resource)",
        satellites_tracked=len(store.tles),
        tle_age_hours={t["name"]: round(_age_hours(t["epoch"]), 2) for t in store.tles.values()},
    )


@app.get("/api/clouds.png")
def get_clouds_png():
    if not cloud_store.png:
        raise HTTPException(404, "cloud overlay not available yet")
    return Response(
        cloud_store.png,
        media_type="image/png",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/api/clouds/meta")
def get_clouds_meta():
    return {"meta": cloud_store.meta, "error": cloud_store.last_error}


@app.get("/api/clouds/grid")
def get_clouds_grid():
    """Raw cover-percent grid (uint8, row 0 = 90°N, col 0 = 180°W)."""
    if not cloud_store.grid:
        raise HTTPException(404, "cloud grid not available yet")
    return Response(
        cloud_store.grid,
        media_type="application/octet-stream",
        headers={
            "X-Grid-Width": str(cloud_store.grid_w),
            "X-Grid-Height": str(cloud_store.grid_h),
            "Cache-Control": "no-cache",
            "Access-Control-Expose-Headers": "X-Grid-Width, X-Grid-Height",
        },
    )


# Serve the built frontend when it exists (production single-process deploy)
if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
