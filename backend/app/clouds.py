"""Live total-cloud-cover overlay from ECMWF IFS open data.

Every REFRESH_S we locate the newest published forecast cycle, pick the
3-hourly step closest to "now", and byte-range-download only the `tcc`
GRIB message (~1-2 MB) using the .index file — never the full forecast
file. The field is rendered to a Web-Mercator-projected translucent PNG
served at /api/clouds.png, which the frontend drapes over the basemap.
Like TLEs, only the latest field is kept (no history).
"""

import asyncio
import io
import json
import logging
from datetime import datetime, timedelta, timezone

import eccodes
import httpx
import numpy as np
from PIL import Image

logger = logging.getLogger("sat-ctrl.clouds")

BASE = "https://data.ecmwf.int/forecasts"
REFRESH_S = 30 * 60
RETRY_S = 10 * 60
MERC_LAT = 85.05112878  # Web Mercator latitude limit
OUT_W, OUT_H = 1440, 1080  # overlay resolution (source grid is 1440x721)


class CloudStore:
    def __init__(self):
        self.png: bytes | None = None
        self.meta: dict | None = None
        self.last_error: str | None = None
        # 0.5° uint8 cover-percent grid (row 0 = 90°N, col 0 = 180°W) for
        # client-side sampling at satellite subpoints
        self.grid: bytes | None = None
        self.grid_w = 0
        self.grid_h = 0

    async def sync(self) -> None:
        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
            cycle, step, entry = await self._find_latest(client)
            url = (
                f"{BASE}/{cycle:%Y%m%d}/{cycle:%H}z/ifs/0p25/oper/"
                f"{cycle:%Y%m%d%H}0000-{step}h-oper-fc.grib2"
            )
            start = entry["_offset"]
            end = start + entry["_length"] - 1
            resp = await client.get(url, headers={"Range": f"bytes={start}-{end}"})
            resp.raise_for_status()

        png, grid, grid_w, grid_h = await asyncio.to_thread(self._render, resp.content)
        self.png = png
        self.grid, self.grid_w, self.grid_h = grid, grid_w, grid_h
        self.meta = {
            "source": "ECMWF IFS 0.25° open data",
            "param": "tcc",
            "cycle": cycle.isoformat(),
            "step_h": step,
            "valid_time": (cycle + timedelta(hours=step)).isoformat(),
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }
        self.last_error = None
        logger.info(
            "Clouds updated: cycle %s +%dh (%d kB png)", cycle.isoformat(), step, len(png) // 1024
        )

    async def _find_latest(self, client: httpx.AsyncClient):
        """Newest cycle whose index is published, with the step nearest to now."""
        now = datetime.now(timezone.utc)
        latest = now.replace(minute=0, second=0, microsecond=0, tzinfo=timezone.utc)
        latest -= timedelta(hours=latest.hour % 6)
        for i in range(6):  # look back up to 36 h of cycles
            cycle = latest - timedelta(hours=6 * i)
            step = round((now - cycle).total_seconds() / 3600 / 3) * 3
            step = max(0, min(step, 144))
            idx_url = (
                f"{BASE}/{cycle:%Y%m%d}/{cycle:%H}z/ifs/0p25/oper/"
                f"{cycle:%Y%m%d%H}0000-{step}h-oper-fc.index"
            )
            resp = await client.get(idx_url)
            if resp.status_code != 200:
                continue
            for line in resp.text.splitlines():
                entry = json.loads(line)
                if entry.get("param") == "tcc":
                    return cycle, step, entry
        raise RuntimeError("no published ECMWF cycle with tcc found")

    def _render(self, grib: bytes) -> tuple[bytes, bytes, int, int]:
        """GRIB tcc message -> (Web-Mercator translucent PNG, sampling grid)."""
        gid = eccodes.codes_new_from_message(grib)
        try:
            ni = eccodes.codes_get(gid, "Ni")
            nj = eccodes.codes_get(gid, "Nj")
            values = eccodes.codes_get_values(gid).reshape(nj, ni)
        finally:
            eccodes.codes_release(gid)

        if np.nanmax(values) > 1.5:  # field in % rather than fraction
            values = values / 100.0
        values = np.nan_to_num(np.clip(values, 0.0, 1.0))
        values = np.roll(values, ni // 2, axis=1)  # lon 0..360 -> -180..180

        # downsampled raw-percent grid (no display threshold) for subpoint sampling
        sub = np.ascontiguousarray(values[::2, ::2])
        grid = (sub * 100).round().astype(np.uint8)

        # equirectangular rows (lat 90..-90) -> mercator rows
        y_max = np.log(np.tan(np.pi / 4 + np.radians(MERC_LAT) / 2))
        y = np.linspace(y_max, -y_max, OUT_H)
        lat = np.degrees(np.arctan(np.sinh(y)))
        rows = np.clip(np.round((90.0 - lat) / 180.0 * (nj - 1)).astype(int), 0, nj - 1)
        cols = np.clip(np.round(np.linspace(0, ni - 1, OUT_W)).astype(int), 0, ni - 1)
        cover = values[rows][:, cols]

        rgba = np.zeros((OUT_H, OUT_W, 4), np.uint8)
        rgba[..., 0], rgba[..., 1], rgba[..., 2] = 208, 224, 240  # pale blue-white
        # ignore cover below 45% so only solid decks and fronts show;
        # tcc is rarely zero anywhere, which otherwise reads as global haze
        significant = np.clip((cover - 0.45) / 0.55, 0.0, 1.0)
        rgba[..., 3] = (np.power(significant, 1.6) * 170).astype(np.uint8)

        buf = io.BytesIO()
        Image.fromarray(rgba, "RGBA").save(buf, "PNG", optimize=True)
        return buf.getvalue(), grid.tobytes(), grid.shape[1], grid.shape[0]

    async def run_forever(self) -> None:
        while True:
            try:
                await self.sync()
                delay = REFRESH_S
            except Exception as exc:  # keep the previous overlay on failure
                self.last_error = f"{type(exc).__name__}: {exc}"
                delay = RETRY_S
                logger.error("Cloud sync failed (%s), retrying in %ds", self.last_error, delay)
            await asyncio.sleep(delay)


store = CloudStore()
