"""TLE ingestion from CelesTrak.

One request every SYNC_INTERVAL fetches the whole 'resource' group (Earth
resources satellites) and we keep only the NORAD IDs in our catalog. TLEs
are held in memory and mirrored to a JSON file so restarts (or CelesTrak
outages) don't leave the dashboard empty. No historical data is kept —
each sync overwrites the previous element set.
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import httpx
from sgp4.api import Satrec

from .catalog import NORAD_IDS

logger = logging.getLogger("sat-ctrl.tle")

CELESTRAK_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=resource&FORMAT=tle"
SYNC_INTERVAL = 6 * 3600  # CelesTrak updates ~daily and firewalls aggressive pollers
RETRY_BACKOFF = [600, 1800, 3600]  # 10 min -> 30 min -> 1 h, then stay at 1 h
CACHE_FILE = Path(__file__).resolve().parent.parent / "data" / "tle_cache.json"


class TLEStore:
    """In-memory TLE store with JSON file persistence."""

    def __init__(self):
        self.tles: dict[int, dict] = {}  # norad_id -> {line1, line2, epoch, fetched_at}
        self.last_sync: str | None = None
        self.last_error: str | None = None

    # -- persistence ---------------------------------------------------

    def load_cache(self) -> None:
        if not CACHE_FILE.exists():
            return
        try:
            data = json.loads(CACHE_FILE.read_text())
            self.tles = {int(k): v for k, v in data["tles"].items()}
            self.last_sync = data.get("last_sync")
            logger.info("Loaded %d TLEs from cache (last sync %s)", len(self.tles), self.last_sync)
        except (json.JSONDecodeError, KeyError, ValueError) as exc:
            logger.warning("Could not read TLE cache: %s", exc)

    def save_cache(self) -> None:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        CACHE_FILE.write_text(json.dumps({"last_sync": self.last_sync, "tles": self.tles}, indent=2))

    # -- sync ------------------------------------------------------------

    async def sync(self) -> None:
        """Fetch the resource group from CelesTrak and keep our satellites."""
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(CELESTRAK_URL)
            resp.raise_for_status()

        now = datetime.now(timezone.utc).isoformat()
        found = 0
        lines = resp.text.strip().splitlines()
        for i in range(0, len(lines) - 2, 3):
            name, line1, line2 = lines[i].strip(), lines[i + 1].strip(), lines[i + 2].strip()
            if not (line1.startswith("1 ") and line2.startswith("2 ")):
                continue
            norad_id = int(line1[2:7])
            if norad_id not in NORAD_IDS:
                continue
            satrec = Satrec.twoline2rv(line1, line2)  # validates + gives epoch
            self.tles[norad_id] = {
                "name": name,
                "line1": line1,
                "line2": line2,
                "epoch": _sat_epoch_iso(satrec),
                "fetched_at": now,
            }
            found += 1

        if found < len(NORAD_IDS):
            missing = NORAD_IDS - set(self.tles)
            logger.warning("Sync found %d/%d satellites; missing: %s", found, len(NORAD_IDS), missing)

        self.last_sync = now
        self.last_error = None
        self.save_cache()
        logger.info("TLE sync complete: %d satellites updated", found)

    async def run_forever(self) -> None:
        """Background loop: sync immediately, then every SYNC_INTERVAL with backoff on errors."""
        failures = 0
        while True:
            try:
                await self.sync()
                failures = 0
                delay = SYNC_INTERVAL
            except Exception as exc:  # network/HTTP errors — keep stale TLEs and retry
                self.last_error = f"{type(exc).__name__}: {exc}"
                delay = RETRY_BACKOFF[min(failures, len(RETRY_BACKOFF) - 1)]
                failures += 1
                logger.error("TLE sync failed (%s), retrying in %ds", self.last_error, delay)
            await asyncio.sleep(delay)


def _sat_epoch_iso(satrec: Satrec) -> str:
    """TLE epoch as ISO-8601 UTC, from sgp4's julian date fields."""
    jd = satrec.jdsatepoch + satrec.jdsatepochF
    # Julian date -> unix seconds (JD 2440587.5 == 1970-01-01T00:00:00Z)
    unix = (jd - 2440587.5) * 86400.0
    return datetime.fromtimestamp(unix, tz=timezone.utc).isoformat()


store = TLEStore()
