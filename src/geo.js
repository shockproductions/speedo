export const EARTH_RADIUS = 6371000;

export const toRadians = (degrees) => (degrees * Math.PI) / 180;
export const toDegrees = (radians) => (radians * 180) / Math.PI;

export function haversineMeters(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) {
    return 0;
  }

  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const angle =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.atan2(Math.sqrt(angle), Math.sqrt(1 - angle));
}

// Local east/north meters around an origin. Accurate to well under a meter across a circuit.
export function makeProjector(origin) {
  const lat0 = toRadians(origin.lat);
  const cosLat = Math.cos(lat0);
  return {
    toXY(point) {
      return {
        x: toRadians(point.lon - origin.lon) * EARTH_RADIUS * cosLat,
        y: toRadians(point.lat - origin.lat) * EARTH_RADIUS,
      };
    },
    toLatLon(point) {
      return {
        lat: origin.lat + toDegrees(point.y / EARTH_RADIUS),
        lon: origin.lon + toDegrees(point.x / (EARTH_RADIUS * cosLat)),
      };
    },
  };
}

// Course over ground, degrees clockwise from north.
export function bearingDegrees(a, b) {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLon = toRadians(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

export function wrapDegrees(angle) {
  let wrapped = angle % 360;
  if (wrapped > 180) wrapped -= 360;
  if (wrapped <= -180) wrapped += 360;
  return wrapped;
}

export function wrapRadians(angle) {
  let wrapped = angle % (2 * Math.PI);
  if (wrapped > Math.PI) wrapped -= 2 * Math.PI;
  if (wrapped <= -Math.PI) wrapped += 2 * Math.PI;
  return wrapped;
}

// Returns fractions along both segments when p0->p1 crosses q0->q1, otherwise null.
export function segmentIntersection(p0, p1, q0, q1) {
  const rx = p1.x - p0.x;
  const ry = p1.y - p0.y;
  const sx = q1.x - q0.x;
  const sy = q1.y - q0.y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-9) {
    return null;
  }

  const qpx = q0.x - p0.x;
  const qpy = q0.y - p0.y;
  const s = (qpx * sy - qpy * sx) / denominator;
  const u = (qpx * ry - qpy * rx) / denominator;
  if (s < 0 || s > 1 || u < 0 || u > 1) {
    return null;
  }
  return { s, u };
}

// Nearest point on segment a->b to p, all in local XY meters.
export function projectOntoSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const s = lengthSquared > 0
    ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
    : 0;
  const x = a.x + dx * s;
  const y = a.y + dy * s;
  return { s, distance: Math.hypot(p.x - x, p.y - y) };
}
