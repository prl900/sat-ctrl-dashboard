// Client-side orbit propagation built on satellite.js (SGP4).
// The backend only ships TLEs; everything live is computed here.

import {
  twoline2satrec,
  propagate,
  gstime,
  eciToGeodetic,
  degreesLat,
  degreesLong,
} from 'satellite.js'

const EARTH_RADIUS_KM = 6371.0
const AU_KM = 149597870.7

export function makeSatrec(tle) {
  return twoline2satrec(tle.line1, tle.line2)
}

/** Geodetic position + speed at `date`, or null if propagation fails. */
export function getPosition(satrec, date) {
  let pv
  try {
    pv = propagate(satrec, date)
  } catch {
    return null
  }
  if (!pv || !pv.position || typeof pv.position !== 'object') return null

  const gmst = gstime(date)
  const geo = eciToGeodetic(pv.position, gmst)
  const v = pv.velocity
  return {
    lat: degreesLat(geo.latitude),
    lon: degreesLong(geo.longitude),
    alt: geo.height, // km
    velocity: Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z), // km/s
    sunlit: isSunlit(pv.position, date),
  }
}

/**
 * Ground track sampled around `date`, as { past, future } GeoJSON
 * FeatureCollections. Each is chopped into chunks whose `opacity`
 * property tapers away from the satellite, so a trail is always
 * brightest where it touches its marker — segments far along the
 * orbit (e.g. reappearing past a pole crossing) fade out instead of
 * looking like orphan trajectories. Segments are also split at the
 * antimeridian. `full` spans ±1 orbit; default is a short trail
 * (10 min back / 30 min ahead).
 */
export function getGroundTrack(satrec, date, periodMin, full = false, stepS = 30) {
  const pastS = full ? periodMin * 60 : 10 * 60
  const futureS = full ? periodMin * 60 : 30 * 60
  return {
    // chunks are ordered from -past to +future; opacity peaks at the satellite
    past: taperedChunks(satrec, date, -pastS, 0, stepS, full ? [0.1, 0.18, 0.3] : [0.18, 0.35]),
    future: taperedChunks(
      satrec,
      date,
      0,
      futureS,
      stepS,
      full ? [0.9, 0.55, 0.3, 0.15] : [0.95, 0.75, 0.5, 0.25],
    ),
  }
}

/** Sample [fromS, toS] in equal chunks; opacities[i] applies to the i-th chunk. */
function taperedChunks(satrec, date, fromS, toS, stepS, opacities) {
  const features = []
  const n = opacities.length
  const span = (toS - fromS) / n
  for (let i = 0; i < n; i++) {
    const coords = sampleTrack(satrec, date, fromS + i * span, fromS + (i + 1) * span, stepS)
    for (const seg of splitAntimeridian(coords)) {
      features.push({
        type: 'Feature',
        properties: { opacity: opacities[i] },
        geometry: { type: 'LineString', coordinates: seg },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

function sampleTrack(satrec, date, fromS, toS, stepS) {
  const coords = []
  for (let t = fromS; t <= toS; t += stepS) {
    const p = getPosition(satrec, new Date(date.getTime() + t * 1000))
    if (p) coords.push([p.lon, p.lat])
  }
  return coords
}

function splitAntimeridian(coords) {
  const segments = []
  let current = []
  for (let i = 0; i < coords.length; i++) {
    if (i > 0 && Math.abs(coords[i][0] - coords[i - 1][0]) > 180) {
      if (current.length > 1) segments.push(current)
      current = []
    }
    current.push(coords[i])
  }
  if (current.length > 1) segments.push(current)
  return segments
}

/**
 * Cylindrical Earth-shadow test: the satellite is eclipsed when it sits
 * behind the Earth (relative to the Sun) inside the shadow cylinder.
 */
function isSunlit(positionEci, date) {
  const sun = sunEci(date)
  const sunMag = Math.hypot(sun.x, sun.y, sun.z)
  const u = { x: sun.x / sunMag, y: sun.y / sunMag, z: sun.z / sunMag }
  const dot = positionEci.x * u.x + positionEci.y * u.y + positionEci.z * u.z
  if (dot >= 0) return true // on the day side
  const perp = {
    x: positionEci.x - dot * u.x,
    y: positionEci.y - dot * u.y,
    z: positionEci.z - dot * u.z,
  }
  return Math.hypot(perp.x, perp.y, perp.z) > EARTH_RADIUS_KM
}

/** Low-precision solar position (Astronomical Almanac), adequate for shadow tests. */
function sunEci(date) {
  const jd = date.getTime() / 86400000 + 2440587.5
  const n = jd - 2451545.0
  const rad = Math.PI / 180
  const L = (280.46 + 0.9856474 * n) % 360
  const g = ((357.528 + 0.9856003 * n) % 360) * rad
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad
  const eps = (23.439 - 0.0000004 * n) * rad
  const r = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * AU_KM
  return {
    x: r * Math.cos(lambda),
    y: r * Math.cos(eps) * Math.sin(lambda),
    z: r * Math.sin(eps) * Math.sin(lambda),
  }
}

/**
 * Night-side polygon for `date` (GeoJSON Feature). The terminator is the
 * great circle 90° from the subsolar point; we sample its latitude per
 * longitude and close the ring over the pole currently in darkness.
 */
export function nightPolygon(date) {
  const rad = Math.PI / 180
  const sun = sunEci(date)
  const r = Math.hypot(sun.x, sun.y, sun.z)
  const dec = Math.asin(sun.z / r) // subsolar latitude
  let lonS = (Math.atan2(sun.y, sun.x) - gstime(date)) / rad // subsolar longitude
  lonS = ((lonS + 540) % 360) - 180
  let latS = dec / rad
  if (Math.abs(latS) < 0.5) latS = latS >= 0 ? 0.5 : -0.5 // equinox singularity guard

  const ring = []
  for (let lon = -180; lon <= 180; lon += 2) {
    const lat = Math.atan(-Math.cos((lon - lonS) * rad) / Math.tan(latS * rad)) / rad
    ring.push([lon, lat])
  }
  const darkPole = latS > 0 ? -90 : 90
  ring.push([180, darkPole], [-180, darkPole], ring[0])
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } }
}

/** Circle polygon (GeoJSON ring) of `radiusKm` around a ground point — sensor footprint viz. */
export function footprintRing(lat, lon, radiusKm, steps = 64) {
  const rad = Math.PI / 180
  const d = radiusKm / EARTH_RADIUS_KM // angular distance
  const lat1 = lat * rad
  const lon1 = lon * rad
  const ring = []
  for (let i = 0; i <= steps; i++) {
    const brg = (i / steps) * 2 * Math.PI
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg),
    )
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
      )
    ring.push([degNorm(lon2 / rad), lat2 / rad])
  }
  return ring
}

function degNorm(lon) {
  return ((lon + 540) % 360) - 180
}
