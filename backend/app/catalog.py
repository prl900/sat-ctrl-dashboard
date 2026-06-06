"""Static catalog of the satellites tracked by SAT-CTRL.

Everything here is mission metadata that does not change at runtime.
Live orbital state comes from CelesTrak TLEs (see tle_sync.py).
"""

SATELLITES = [
    {
        "norad_id": 40697,
        "name": "SENTINEL-2A",
        "agency": "ESA",
        "program": "Copernicus",
        "sensor": "MSI (MultiSpectral Instrument)",
        "swath_km": 290,
        "launch_date": "2015-06-23",
        "revisit_days": 5,
        "color": "#2ee6ff",  # cyan
    },
    {
        "norad_id": 42063,
        "name": "SENTINEL-2B",
        "agency": "ESA",
        "program": "Copernicus",
        "sensor": "MSI (MultiSpectral Instrument)",
        "swath_km": 290,
        "launch_date": "2017-03-07",
        "revisit_days": 5,
        "color": "#3b82f6",  # blue
    },
    {
        "norad_id": 60989,
        "name": "SENTINEL-2C",
        "agency": "ESA",
        "program": "Copernicus",
        "sensor": "MSI (MultiSpectral Instrument)",
        "swath_km": 290,
        "launch_date": "2024-09-05",
        "revisit_days": 5,
        "color": "#a78bfa",  # violet
    },
    {
        "norad_id": 39084,
        "name": "LANDSAT 8",
        "agency": "NASA/USGS",
        "program": "Landsat",
        "sensor": "OLI + TIRS",
        "swath_km": 185,
        "launch_date": "2013-02-11",
        "revisit_days": 16,
        "color": "#ffd23f",  # yellow
    },
    {
        "norad_id": 49260,
        "name": "LANDSAT 9",
        "agency": "NASA/USGS",
        "program": "Landsat",
        "sensor": "OLI-2 + TIRS-2",
        "swath_km": 185,
        "launch_date": "2021-09-27",
        "revisit_days": 16,
        "color": "#ff6b35",  # orange-red
    },
]

NORAD_IDS = {sat["norad_id"] for sat in SATELLITES}
