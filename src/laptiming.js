import {
  bearingDegrees,
  haversineMeters,
  makeProjector,
  projectOntoSegment,
  segmentIntersection,
  toRadians,
  wrapDegrees,
} from "./geo.js";

export const DEFAULT_GATE_WIDTH = 30;
const MAX_CROSSING_ANGLE = 75;
const MAX_FIX_GAP_MS = 5000;
const AUTO_GATE_ARM_SPEED = 11;
const AUTO_GATE_DELAY_MS = 20000;
const AUTO_GATE_MIN_SPEED = 8;
const REFERENCE_MATCH_METERS = 40;

// A gate is a line across the track, perpendicular to the direction of travel.
export function createGate(center, heading, width = DEFAULT_GATE_WIDTH) {
  const projector = makeProjector(center);
  const angle = toRadians(heading);
  // Direction of travel in east/north components, then rotate 90 degrees for the gate line.
  const dx = Math.cos(angle);
  const dy = -Math.sin(angle);
  const half = width / 2;
  return {
    a: projector.toLatLon({ x: dx * half, y: dy * half }),
    b: projector.toLatLon({ x: -dx * half, y: -dy * half }),
    center: { lat: center.lat, lon: center.lon },
    heading,
  };
}

// A gate drawn by tapping both edges of the track. The direction of travel is perpendicular to
// the line; `flipped` picks which way.
export function gateFromEndpoints(a, b, flipped = false) {
  const across = bearingDegrees(a, b);
  return {
    a: { lat: a.lat, lon: a.lon },
    b: { lat: b.lat, lon: b.lon },
    center: { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 },
    heading: (across + (flipped ? 270 : 90)) % 360,
  };
}

export function isGateFlipped(gate) {
  return Math.abs(wrapDegrees(gate.heading - (bearingDegrees(gate.a, gate.b) + 90))) > 90;
}

function gateGeometry(gate) {
  const projector = makeProjector(gate.center);
  return { projector, a: projector.toXY(gate.a), b: projector.toXY(gate.b) };
}

// Time at which the car reached `fraction` of the way from fix p0 to p1, assuming constant
// acceleration between fixes. Much better than linear interpolation with 1 Hz GNSS.
function interpolateCrossingTime(p0, p1, fraction) {
  const dt = (p1.t - p0.t) / 1000;
  const v0 = p0.speed;
  const v1 = p1.speed;
  if (!Number.isFinite(v0) || !Number.isFinite(v1) || v0 + v1 < 0.5 || dt <= 0) {
    return p0.t + (p1.t - p0.t) * fraction;
  }
  const target = fraction * ((v0 + v1) / 2) * dt;
  const acceleration = (v1 - v0) / dt;
  let tau;
  if (Math.abs(acceleration) < 1e-6) {
    tau = target / v0;
  } else {
    const discriminant = v0 * v0 + 2 * acceleration * target;
    tau = discriminant >= 0 ? (-v0 + Math.sqrt(discriminant)) / acceleration : fraction * dt;
  }
  return p0.t + Math.min(Math.max(tau, 0), dt) * 1000;
}

function crossingBetween(geometry, gate, p0, p1) {
  if (p1.t - p0.t > MAX_FIX_GAP_MS || p1.t <= p0.t) {
    return null;
  }
  const xy0 = geometry.projector.toXY(p0);
  const xy1 = geometry.projector.toXY(p1);
  if (Math.abs(xy0.x) > 2000 || Math.abs(xy0.y) > 2000) {
    return null;
  }
  const hit = segmentIntersection(xy0, xy1, geometry.a, geometry.b);
  if (!hit) {
    return null;
  }
  const travel = bearingDegrees(p0, p1);
  if (Math.abs(wrapDegrees(travel - gate.heading)) > MAX_CROSSING_ANGLE) {
    return null;
  }
  return {
    t: interpolateCrossingTime(p0, p1, hit.s),
    fraction: hit.s,
    lat: p0.lat + (p1.lat - p0.lat) * hit.s,
    lon: p0.lon + (p1.lon - p0.lon) * hit.s,
  };
}

export function findCrossings(fixes, gate, minGapMs = 0) {
  const geometry = gateGeometry(gate);
  const crossings = [];
  for (let index = 1; index < fixes.length; index += 1) {
    const crossing = crossingBetween(geometry, gate, fixes[index - 1], fixes[index]);
    if (!crossing) continue;
    const previous = crossings[crossings.length - 1];
    if (previous && crossing.t - previous.t < minGapMs) continue;
    crossings.push({ ...crossing, index });
  }
  return crossings;
}

// Without a saved track, any line across the circuit works as start/finish. Pick one shortly
// after the car first gets up to speed, which keeps it clear of the paddock and pit exit.
export function autoGate(fixes) {
  let armedAt = null;
  for (let index = 1; index < fixes.length; index += 1) {
    const fix = fixes[index];
    if (armedAt == null) {
      if (fix.speed >= AUTO_GATE_ARM_SPEED) armedAt = fix.t;
      continue;
    }
    if (fix.t - armedAt >= AUTO_GATE_DELAY_MS && fix.speed >= AUTO_GATE_MIN_SPEED) {
      const previous = fixes[index - 1];
      const heading = Number.isFinite(fix.heading) ? fix.heading : bearingDegrees(previous, fix);
      return { ...createGate(fix, heading), auto: true };
    }
  }
  return null;
}

// Laps between consecutive start/finish crossings, with optional sector splits.
export function buildLaps(fixes, track, { minLapSeconds = 10 } = {}) {
  const empty = { laps: [], crossings: [], outLap: null, inLap: null };
  if (!track?.startFinish || fixes.length < 2) {
    return empty;
  }

  const crossings = findCrossings(fixes, track.startFinish, minLapSeconds * 1000);
  if (!crossings.length) {
    return empty;
  }
  const sectorCrossings = (track.sectors ?? []).map((gate) => findCrossings(fixes, gate, 3000));
  const runStart = fixes[0].t;
  const laps = [];

  for (let index = 1; index < crossings.length; index += 1) {
    const start = crossings[index - 1];
    const end = crossings[index];
    let sectors = null;
    if (sectorCrossings.length) {
      const splits = [];
      let cursor = start.t;
      for (const list of sectorCrossings) {
        const hit = list.find((crossing) => crossing.t > cursor && crossing.t < end.t);
        if (!hit) {
          splits.length = 0;
          break;
        }
        splits.push((hit.t - cursor) / 1000);
        cursor = hit.t;
      }
      if (splits.length === sectorCrossings.length) {
        splits.push((end.t - cursor) / 1000);
        sectors = splits;
      }
    }

    laps.push({
      number: index,
      startT: start.t,
      endT: end.t,
      start: (start.t - runStart) / 1000,
      end: (end.t - runStart) / 1000,
      time: (end.t - start.t) / 1000,
      sectors,
      startIndex: start.index,
      endIndex: end.index,
      startPoint: { lat: start.lat, lon: start.lon },
      endPoint: { lat: end.lat, lon: end.lon },
    });
  }

  const first = crossings[0];
  const last = crossings[crossings.length - 1];
  const finalT = fixes[fixes.length - 1].t;
  return {
    laps,
    crossings,
    outLap: { time: (first.t - runStart) / 1000 },
    inLap: finalT > last.t ? { time: (finalT - last.t) / 1000 } : null,
  };
}

export function summarizeLaps(laps) {
  if (!laps.length) {
    return { bestLap: null, bestLapNumber: null, theoreticalBest: null, averageLap: null, bestSectors: null };
  }
  const best = laps.reduce((winner, lap) => (lap.time < winner.time ? lap : winner), laps[0]);
  const withSectors = laps.filter((lap) => lap.sectors);
  let bestSectors = null;
  let theoreticalBest = null;
  if (withSectors.length) {
    bestSectors = withSectors[0].sectors.map((_, sectorIndex) =>
      Math.min(...withSectors.map((lap) => lap.sectors[sectorIndex])),
    );
    theoreticalBest = bestSectors.reduce((total, value) => total + value, 0);
  }
  return {
    bestLap: best.time,
    bestLapNumber: best.number,
    theoreticalBest,
    averageLap: laps.reduce((total, lap) => total + lap.time, 0) / laps.length,
    bestSectors,
  };
}

// Lap trace used as the predictive-delta reference: positions with seconds since lap start.
// `points` are analysis points (seconds since run start, same indexing as the lap's fixes).
export function lapTrace(points, lap) {
  const trace = [{ lat: lap.startPoint.lat, lon: lap.startPoint.lon, t: 0 }];
  for (let index = lap.startIndex; index < lap.endIndex; index += 1) {
    const point = points[index];
    trace.push({ lat: point.lat, lon: point.lon, t: point.t - lap.start });
  }
  trace.push({ lat: lap.endPoint.lat, lon: lap.endPoint.lon, t: lap.time });
  return trace;
}

export class ReferenceLap {
  constructor(trace, origin) {
    this.projector = makeProjector(origin ?? trace[0]);
    this.points = trace.map((point) => ({ ...this.projector.toXY(point), t: point.t }));
    this.time = trace[trace.length - 1]?.t ?? null;
    this.cursor = 0;
  }

  restart() {
    this.cursor = 0;
  }

  // Reference time at the point of the reference lap nearest to `position`.
  timeAt(position) {
    const points = this.points;
    if (points.length < 2) {
      return null;
    }
    const p = this.projector.toXY(position);
    const from = Math.max(0, this.cursor - 3);
    const to = Math.min(points.length - 1, this.cursor + 60);
    let best = null;
    for (let index = from; index < to; index += 1) {
      const projection = projectOntoSegment(p, points[index], points[index + 1]);
      if (!best || projection.distance < best.distance) {
        best = { ...projection, index };
      }
    }
    if (!best || best.distance > REFERENCE_MATCH_METERS) {
      return null;
    }
    this.cursor = best.index;
    const a = points[best.index];
    const b = points[best.index + 1];
    return a.t + (b.t - a.t) * best.s;
  }
}

// Live timing during a session: lap/sector events, running lap clock and predictive delta.
export class LiveLapTimer {
  constructor({ onEvent } = {}) {
    this.onEvent = onEvent;
    this.reset();
  }

  reset() {
    this.track = null;
    this.geometry = null;
    this.sectorGeometry = [];
    this.minLapMs = 10000;
    this.previousFix = null;
    this.lapStartT = null;
    this.lapStartPoint = null;
    this.lapFixes = [];
    this.sectorIndex = 0;
    this.sectorStartT = null;
    this.lapNumber = 0;
    this.lastLap = null;
    this.bestLap = null;
    this.reference = null;
    this.referenceSource = null;
    this.delta = null;
    this.autoArmedAt = null;
    this.autoEnabled = false;
  }

  configure({ track = null, minLapSeconds = 10, autoGate: allowAutoGate = true, referenceTrace = null } = {}) {
    this.reset();
    this.minLapMs = minLapSeconds * 1000;
    this.autoEnabled = allowAutoGate;
    if (track?.startFinish) {
      this.setTrack(track);
    }
    if (referenceTrace?.length > 1) {
      this.reference = new ReferenceLap(referenceTrace, track?.startFinish?.center);
      this.referenceSource = "track";
    }
  }

  setTrack(track) {
    this.track = track;
    this.geometry = gateGeometry(track.startFinish);
    this.sectorGeometry = (track.sectors ?? []).map((gate) => ({ gate, geometry: gateGeometry(gate) }));
  }

  // Manual "mark start/finish here": the car is on the line right now.
  markStartFinish(track, fix) {
    this.setTrack(track);
    this.beginLap(fix.t, { lat: fix.lat, lon: fix.lon });
    this.reference = null;
  }

  beginLap(t, point) {
    this.lapStartT = t;
    this.lapStartPoint = point;
    this.lapFixes = [];
    this.sectorIndex = 0;
    this.sectorStartT = t;
    this.delta = null;
    this.reference?.restart();
  }

  ingestFix(fix) {
    const previous = this.previousFix;
    this.previousFix = fix;
    if (!previous) {
      return;
    }

    if (!this.track && this.autoEnabled) {
      this.tryAutoGate(previous, fix);
    }
    if (!this.track) {
      return;
    }

    const crossing = crossingBetween(this.geometry, this.track.startFinish, previous, fix);
    if (crossing && (this.lapStartT == null || crossing.t - this.lapStartT >= this.minLapMs)) {
      this.completeLap(crossing);
    } else if (this.lapStartT != null) {
      this.checkSector(previous, fix);
    }

    if (this.lapStartT != null) {
      this.lapFixes.push({ lat: fix.lat, lon: fix.lon, t: (fix.t - this.lapStartT) / 1000 });
      if (this.reference) {
        const referenceTime = this.reference.timeAt(fix);
        this.delta = referenceTime == null ? this.delta : (fix.t - this.lapStartT) / 1000 - referenceTime;
      }
    }
  }

  tryAutoGate(previous, fix) {
    if (this.autoArmedAt == null) {
      if (fix.speed >= AUTO_GATE_ARM_SPEED) this.autoArmedAt = fix.t;
      return;
    }
    if (fix.t - this.autoArmedAt >= AUTO_GATE_DELAY_MS && fix.speed >= AUTO_GATE_MIN_SPEED) {
      const heading = Number.isFinite(fix.heading) ? fix.heading : bearingDegrees(previous, fix);
      const gate = { ...createGate(fix, heading), auto: true };
      this.setTrack({ id: null, name: "Auto start/finish", startFinish: gate, sectors: [] });
      this.beginLap(fix.t, { lat: fix.lat, lon: fix.lon });
      this.onEvent?.({ type: "auto-gate", gate });
    }
  }

  checkSector(previous, fix) {
    const sector = this.sectorGeometry[this.sectorIndex];
    if (!sector) return;
    const crossing = crossingBetween(sector.geometry, sector.gate, previous, fix);
    if (!crossing) return;
    const split = (crossing.t - this.sectorStartT) / 1000;
    this.sectorStartT = crossing.t;
    this.sectorIndex += 1;
    this.onEvent?.({ type: "sector", sector: this.sectorIndex, split });
  }

  completeLap(crossing) {
    if (this.lapStartT == null) {
      this.beginLap(crossing.t, crossing);
      this.onEvent?.({ type: "lap-start" });
      return;
    }

    const time = (crossing.t - this.lapStartT) / 1000;
    const trace = [
      { ...this.lapStartPoint, t: 0 },
      ...this.lapFixes,
      { lat: crossing.lat, lon: crossing.lon, t: time },
    ];
    this.lapNumber += 1;
    const previousBest = this.bestLap;
    const referenceTime = this.reference?.time ?? null;
    const isBest = previousBest == null || time < previousBest;
    this.lastLap = time;
    if (isBest) {
      this.bestLap = time;
    }
    if (referenceTime == null || time < referenceTime) {
      this.reference = new ReferenceLap(trace, this.track.startFinish.center);
      this.referenceSource = "session";
    }

    this.onEvent?.({
      type: "lap",
      number: this.lapNumber,
      time,
      isBest,
      deltaToBest: previousBest == null ? null : time - previousBest,
      deltaToReference: referenceTime == null ? null : time - referenceTime,
      trace,
    });
    this.beginLap(crossing.t, crossing);
  }

  currentLapSeconds(now) {
    return this.lapStartT == null ? null : Math.max(0, (now - this.lapStartT) / 1000);
  }
}

export function nearestTrack(tracks, position, maxMeters = 3000) {
  let best = null;
  for (const track of tracks) {
    const center = track.startFinish?.center;
    if (!center) continue;
    const distance = haversineMeters(center, position);
    if (distance <= maxMeters && (!best || distance < best.distance)) {
      best = { track, distance };
    }
  }
  return best?.track ?? null;
}
