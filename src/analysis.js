import { DriftEstimator, DriftSegmenter } from "./drift.js";
import { haversineMeters, toRadians, wrapRadians } from "./geo.js";
import { autoGate, buildLaps, nearestTrack, summarizeLaps } from "./laptiming.js";
import { calibrateRecording, courseOf, projectSample } from "./orientation.js";

export const ANALYSIS_VERSION = 2;
const KMH_FACTOR = 3.6;
const QUARTER_MILE_METERS = 402.336;
const SERIES_STEP_MS = 100;
const MAX_ACCURACY_METERS = 40;

// Older runs stored one mixed `samples` array; split it into the GNSS/IMU streams used now.
export function normalizeRun(run) {
  if (run.gnss && run.imu) {
    return run;
  }
  const samples = run.samples ?? [];
  const tagged = samples.some((sample) => sample.source);
  const gnss = [];
  let previous = null;
  for (const sample of samples) {
    const isFix = tagged
      ? sample.source === "location"
      : Number.isFinite(sample.lat) && (!previous || sample.lat !== previous.lat || sample.lon !== previous.lon);
    if (isFix && Number.isFinite(sample.lat)) {
      gnss.push({
        t: sample.timestamp,
        arrival: sample.timestamp,
        fixTime: null,
        lat: sample.lat,
        lon: sample.lon,
        altitude: sample.altitude ?? null,
        speed: sample.speed ?? null,
        heading: sample.heading ?? null,
        accuracy: null,
      });
      previous = sample;
    }
  }
  const imu = samples
    .filter((sample) => (tagged ? sample.source === "motion" : true) && Number.isFinite(sample.accelX))
    .map((sample) => ({
      t: sample.timestamp,
      ax: sample.accelX,
      ay: sample.accelY,
      az: sample.accelZ,
      gx: null,
      gy: null,
      gz: null,
    }));
  const { samples: _legacy, ...rest } = run;
  return { ...rest, version: 2, mode: run.mode ?? "track", gnss, imu, calibration: run.calibration ?? null };
}

// Re-align fix times over the whole session (the live aligner only knew the past) and fill in
// missing Doppler speeds from positions.
function prepareFixes(gnss) {
  let minOffset = Infinity;
  for (const fix of gnss) {
    if (Number.isFinite(fix.fixTime) && Number.isFinite(fix.arrival)) {
      minOffset = Math.min(minOffset, fix.arrival - fix.fixTime);
    }
  }

  const fixes = gnss
    .filter((fix) => Number.isFinite(fix.lat) && Number.isFinite(fix.lon))
    .filter((fix) => !(fix.accuracy > MAX_ACCURACY_METERS))
    .map((fix) => ({
      ...fix,
      t: Number.isFinite(fix.fixTime) && Number.isFinite(minOffset) ? fix.fixTime + minOffset : fix.t,
    }))
    .sort((a, b) => a.t - b.t);

  const unique = [];
  for (const fix of fixes) {
    const last = unique[unique.length - 1];
    if (last && fix.t - last.t < 1) continue;
    unique.push(fix);
  }

  for (let index = 0; index < unique.length; index += 1) {
    const fix = unique[index];
    if (Number.isFinite(fix.speed)) continue;
    const previous = unique[index - 1];
    const next = unique[index + 1];
    const a = previous ?? fix;
    const b = next ?? fix;
    const dt = (b.t - a.t) / 1000;
    fix.speed = dt > 0 ? haversineMeters(a, b) / dt : 0;
  }
  return unique;
}

function buildPoints(fixes, origin) {
  const points = [];
  let distance = 0;
  let previous = null;
  for (const fix of fixes) {
    if (previous) {
      const segment = haversineMeters(previous, fix);
      const dt = (fix.t - previous.t) / 1000;
      // Ignore position jumps that imply impossible speeds.
      if (dt > 0 && segment / dt < 120) distance += segment;
    }
    points.push({
      t: (fix.t - origin) / 1000,
      lat: fix.lat,
      lon: fix.lon,
      v: fix.speed * KMH_FACTOR,
      d: distance,
      course: courseOf(fix, previous),
    });
    previous = fix;
  }
  return points;
}

export function vehicleSeries(imu, calibration) {
  if (!calibration || calibration.skipped || !calibration.gravity) {
    return [];
  }
  return imu.map((sample) => ({ t: sample.t, ...projectSample(calibration, sample) }));
}

function runDrift(vehicle, fixes) {
  const estimator = new DriftEstimator();
  const betas = [];
  let fixIndex = 0;
  let hasYaw = false;
  for (const sample of vehicle) {
    while (fixIndex < fixes.length && fixes[fixIndex].t <= sample.t) {
      const fix = fixes[fixIndex];
      estimator.ingestFix(fix.t, fix.speed, courseOf(fix, fixes[fixIndex - 1]));
      fixIndex += 1;
    }
    if (Number.isFinite(sample.yawRate)) {
      hasYaw = true;
      estimator.ingestImu(sample.t, sample);
      betas.push({ t: sample.t, beta: estimator.currentBeta() });
    }
  }
  return hasYaw ? betas : null;
}

// One row per 100 ms: interpolated position/speed/distance plus averaged vehicle channels.
function buildSeries(points, vehicle, betas, origin, endT) {
  const series = [];
  if (!points.length) return series;
  let pointIndex = 0;
  let vehicleIndex = 0;
  let betaIndex = 0;
  const endSeconds = (endT - origin) / 1000;

  for (let t = Math.max(0, points[0].t); t <= Math.min(endSeconds, points[points.length - 1].t); t += SERIES_STEP_MS / 1000) {
    while (pointIndex < points.length - 2 && points[pointIndex + 1].t < t) pointIndex += 1;
    const a = points[pointIndex];
    const b = points[Math.min(pointIndex + 1, points.length - 1)];
    const fraction = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    const row = {
      t,
      d: a.d + (b.d - a.d) * fraction,
      v: a.v + (b.v - a.v) * fraction,
      la: a.lat + (b.lat - a.lat) * fraction,
      lo: a.lon + (b.lon - a.lon) * fraction,
      lon: null,
      lat: null,
      yaw: null,
      beta: null,
    };

    const windowStart = origin + (t - 0.05) * 1000;
    const windowEnd = origin + (t + 0.05) * 1000;
    while (vehicleIndex < vehicle.length && vehicle[vehicleIndex].t < windowStart) vehicleIndex += 1;
    let longSum = 0;
    let latSum = 0;
    let yawSum = 0;
    let count = 0;
    let yawCount = 0;
    for (let index = vehicleIndex; index < vehicle.length && vehicle[index].t < windowEnd; index += 1) {
      const sample = vehicle[index];
      if (Number.isFinite(sample.longG)) {
        longSum += sample.longG;
        latSum += sample.latG;
        count += 1;
      }
      if (Number.isFinite(sample.yawRate)) {
        yawSum += sample.yawRate;
        yawCount += 1;
      }
    }
    if (count) {
      row.lon = longSum / count;
      row.lat = latSum / count;
    }
    if (yawCount) {
      row.yaw = ((yawSum / yawCount) * 180) / Math.PI;
    }

    if (betas) {
      while (betaIndex < betas.length - 1 && betas[betaIndex + 1].t <= windowEnd) betaIndex += 1;
      const beta = betas[betaIndex];
      if (beta && Math.abs(beta.t - (origin + t * 1000)) < 250) row.beta = beta.beta;
    }
    series.push(row);
  }
  return series;
}

// Best standing-start 0-100 km/h and quarter mile found anywhere in the run.
function dragMetrics(points) {
  let zeroToHundred = null;
  let quarterMile = null;
  let launch = null;
  let reachedHundred = false;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    if (point.v < 2) {
      launch = point;
      reachedHundred = false;
      continue;
    }
    if (!launch) continue;

    if (!reachedHundred && previous.v < 100 && point.v >= 100) {
      reachedHundred = true;
      const fraction = (100 - previous.v) / (point.v - previous.v || 1);
      const time = previous.t + (point.t - previous.t) * fraction - launch.t;
      if (zeroToHundred == null || time < zeroToHundred) zeroToHundred = time;
    }
    const covered = point.d - launch.d;
    const coveredBefore = previous.d - launch.d;
    if (coveredBefore < QUARTER_MILE_METERS && covered >= QUARTER_MILE_METERS) {
      const fraction = (QUARTER_MILE_METERS - coveredBefore) / (covered - coveredBefore || 1);
      const time = previous.t + (point.t - previous.t) * fraction - launch.t;
      if (quarterMile == null || time < quarterMile) quarterMile = time;
    }
  }
  return { zeroToHundred, quarterMile };
}

// GNSS-only fallbacks for g channels: smoothed speed derivative and v x course rate.
function gnssAccelerations(points) {
  let peakAccel = 0;
  let peakBrake = 0;
  let maxLat = 0;
  for (let index = 2; index < points.length; index += 1) {
    const a = points[index - 2];
    const b = points[index];
    const dt = b.t - a.t;
    if (dt < 0.5 || dt > 4) continue;
    const longG = (b.v - a.v) / KMH_FACTOR / dt / 9.80665;
    peakAccel = Math.max(peakAccel, longG);
    peakBrake = Math.max(peakBrake, -longG);
    if (a.course != null && b.course != null && b.v > 15) {
      const rate = wrapRadians(toRadians(b.course - a.course)) / dt;
      maxLat = Math.max(maxLat, Math.abs((b.v / KMH_FACTOR) * rate) / 9.80665);
    }
  }
  return { peakAccel, peakBrake, maxLat };
}

function sliceSeries(series, start, end) {
  return series.filter((row) => row.t >= start && row.t <= end);
}

function lapStats(lap, points, series) {
  const lapPoints = points.filter((point) => point.t >= lap.start && point.t <= lap.end);
  const rows = sliceSeries(series, lap.start, lap.end);
  const speeds = lapPoints.map((point) => point.v);
  const lats = rows.map((row) => row.lat).filter(Number.isFinite);
  const longs = rows.map((row) => row.lon).filter(Number.isFinite);
  return {
    topSpeedKmh: speeds.length ? Math.max(...speeds) : null,
    minSpeedKmh: speeds.length ? Math.min(...speeds) : null,
    maxLatG: lats.length ? Math.max(...lats.map(Math.abs)) : null,
    maxBrakeG: longs.length ? Math.max(0, -Math.min(...longs)) : null,
    distance: lapPoints.length ? lapPoints[lapPoints.length - 1].d - lapPoints[0].d : null,
  };
}

export function resolveTrack(run, fixes, tracks) {
  if (run.trackId) {
    const assigned = tracks.find((track) => track.id === run.trackId);
    if (assigned) return assigned;
  }
  if (run.trackId === "none" || !fixes.length) {
    return null;
  }
  const middle = fixes[Math.floor(fixes.length / 2)];
  return nearestTrack(tracks, middle);
}

export function analyzeRun(inputRun, { tracks = [] } = {}) {
  const run = normalizeRun(inputRun);
  const fixes = prepareFixes(run.gnss);
  const imu = [...run.imu].sort((a, b) => a.t - b.t);
  const origin = Math.min(
    Number.isFinite(run.startedAt) ? run.startedAt : Infinity,
    fixes[0]?.t ?? Infinity,
    imu[0]?.t ?? Infinity,
  );
  const endT = Math.max(fixes[fixes.length - 1]?.t ?? 0, imu[imu.length - 1]?.t ?? 0, origin + (run.duration || 0));

  const calibration = run.calibration?.skipped ? run.calibration : calibrateRecording(imu, fixes, run.calibration);
  const vehicle = vehicleSeries(imu, calibration);
  const hasG = vehicle.some((sample) => Number.isFinite(sample.longG));
  const betas = runDrift(vehicle, fixes);

  const points = buildPoints(fixes, origin);
  const series = buildSeries(points, vehicle, betas, origin, endT);

  const track = resolveTrack(run, fixes, tracks);
  const gateTrack = track ?? (run.trackId === "none" ? null : (() => {
    const gate = autoGate(fixes);
    return gate ? { id: null, name: "Auto start/finish", startFinish: gate, sectors: [] } : null;
  })());
  const lapResult = buildLaps(fixes, gateTrack, { minLapSeconds: run.config?.lapMinSeconds || 10 });
  const laps = lapResult.laps.map((lap) => ({ ...lap, ...lapStats(lap, points, series) }));
  // An auto gate with a single crossing is not a circuit; drop it so the UI does not draw it.
  const usedTrack = track || laps.length ? gateTrack : null;

  const segmenter = new DriftSegmenter();
  if (betas) {
    for (const row of series) segmenter.ingest(row.t * 1000, row.beta, row.v);
  }
  const chains = segmenter.flush().map((chain) => ({ ...chain, start: chain.start / 1000, end: chain.end / 1000 }));

  const speeds = points.map((point) => point.v);
  const movingSeconds = points.reduce((total, point, index) => {
    if (!index || point.v < 3.6) return total;
    return total + Math.min(point.t - points[index - 1].t, 5);
  }, 0);
  const distance = points.length ? points[points.length - 1].d : 0;
  const gnssG = gnssAccelerations(points);
  const lats = series.map((row) => row.lat).filter(Number.isFinite);
  const longs = series.map((row) => row.lon).filter(Number.isFinite);
  const drag = dragMetrics(points);

  return {
    ...run,
    calibration: run.calibration,
    analysis: {
      version: ANALYSIS_VERSION,
      calibration,
      calibrationQuality: calibration?.forward ? calibration.quality : null,
      hasG,
      hasGyro: Boolean(betas),
      track: usedTrack
        ? { id: usedTrack.id, name: usedTrack.name, startFinish: usedTrack.startFinish, sectors: usedTrack.sectors ?? [] }
        : null,
      summary: {
        durationSeconds: (endT - origin) / 1000,
        distanceMeters: distance,
        maxSpeedKmh: speeds.length ? Math.max(...speeds) : 0,
        averageSpeedKmh: movingSeconds ? (distance / movingSeconds) * KMH_FACTOR : 0,
        maxLatG: hasG && lats.length ? Math.max(...lats.map(Math.abs)) : gnssG.maxLat,
        peakAccelG: hasG && longs.length ? Math.max(0, ...longs) : gnssG.peakAccel,
        peakBrakeG: hasG && longs.length ? Math.max(0, -Math.min(...longs)) : gnssG.peakBrake,
        gSource: hasG ? "imu" : "gnss",
        zeroToHundredSeconds: drag.zeroToHundred,
        quarterMileSeconds: drag.quarterMile,
        lapCount: laps.length,
        ...summarizeLaps(laps),
        driftScore: chains.reduce((total, chain) => total + chain.score, 0),
        bestDriftScore: chains.length ? Math.max(...chains.map((chain) => chain.score)) : null,
        maxDriftAngle: chains.length ? Math.max(...chains.map((chain) => chain.peakAngle)) : null,
        driftCount: chains.length,
      },
      laps,
      outLap: lapResult.outLap,
      inLap: lapResult.inLap,
      points,
      series,
      drift: { chains },
    },
  };
}

export function needsReanalysis(run) {
  return run.analysis?.version !== ANALYSIS_VERSION;
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatLapTime(seconds, digits = 2) {
  if (!Number.isFinite(seconds)) {
    return "--:--";
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  const restText = rest.toFixed(digits).padStart(digits + 3, "0");
  return minutes ? `${minutes}:${restText}` : rest.toFixed(digits);
}

export function formatDelta(seconds, digits = 2) {
  if (!Number.isFinite(seconds)) {
    return "--";
  }
  return `${seconds >= 0 ? "+" : "-"}${Math.abs(seconds).toFixed(digits)}`;
}

export function formatNumber(value, digits = 1, suffix = "") {
  if (!Number.isFinite(value)) {
    return "N/A";
  }
  return `${value.toFixed(digits)}${suffix}`;
}
