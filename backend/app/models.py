"""Pydantic response models for the SAT-CTRL API."""

from pydantic import BaseModel


class TLE(BaseModel):
    line1: str
    line2: str
    epoch: str
    age_hours: float


class Orbit(BaseModel):
    period_min: float
    inclination_deg: float
    eccentricity: float
    apogee_km: float
    perigee_km: float


class Satellite(BaseModel):
    norad_id: int
    name: str
    agency: str
    program: str
    sensor: str
    swath_km: int
    launch_date: str
    revisit_days: int
    color: str
    tle: TLE | None = None
    orbit: Orbit | None = None


class Status(BaseModel):
    revision: str
    last_sync: str | None
    last_error: str | None
    next_sync_in_s: float | None
    source: str
    satellites_tracked: int
    tle_age_hours: dict[str, float]
