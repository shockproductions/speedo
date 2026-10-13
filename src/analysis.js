import { DriftEstimator, DriftSegmenter } from "./drift.js";
import { smoothTrajectory } from "./ekf.js";
import { haversineMeters, toRadians, wrapRadians } from "./geo.js";
import { autoGate, buildLaps, nearestTrack, summarizeLaps } from "./laptiming.js";
import { calibrateRecording, courseOf, projectSample } from "./orientation.js";

export const ANALYSIS_VERSION = 3;
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

// GNSS timestamps are only known up to the phone's delivery latency. Find the lag that best lines
// up GNSS speed changes with the IMU's longitudinal acceleration, so fused data is in sync.
export function estimateGnssLag(fixes, vehicle) {
  const times = [];
  const cumulative = [0];
  const turning = [0];
  for (const sample of vehicle) {
    if (!Number.isFinite(sample.longG)) continue;
    times.push(sample.t);
    cumulative.push(cumulative[cumulative.length - 1] + sample.longG * 9.80665);
    turning.push(turning[turning.length - 1] + Math.abs(sample.yawRate ?? 0));
  }
  if (times.length < 100) return null;

  const lowerBound = (value) => {
    let low = 0;
    let high = times.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (times[middle] < value) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const meanBetween = (from, to) => {
    const a = lowerBound(from);
    const b = lowerBound(to);
    return b - a >= 2 ? (cumulative[b] - cumulative[a]) / (b - a) : null;
  };

  const intervals = [];
  // Pair fixes at least 0.4 s apart so high-rate GNSS noise does not swamp the speed change.
  let anchor = 0;
  for (let index = 1; index < fixes.length; index += 1) {
    const a = fixes[anchor];
    const b = fixes[index];
    const dt = (b.t - a.t) / 1000;
    if (dt < 0.4) continue;
    anchor = index;
    if (dt > 2.5 || !Number.isFinite(a.speed) || !Number.isFinite(b.speed)) continue;
    if ((a.speed + b.speed) / 2 < 3) continue;
    // Straight-line intervals only: while turning (or sliding) body and travel frames differ.
    const first = lowerBound(a.t);
    const last = lowerBound(b.t);
    if (last - first >= 2 && (turning[last] - turning[first]) / (last - first) > 0.1) continue;
    intervals.push({ from: a.t, to: b.t, accel: (b.speed - a.speed) / dt });
  }
  if (intervals.length < 30) return null;

  const errorAt = (lag) => {
    let total = 0;
    let count = 0;
    for (const interval of intervals) {
      const mean = meanBetween(interval.from - lag, interval.to - lag);
      if (mean == null) continue;
      total += (interval.accel - mean) ** 2;
      count += 1;
    }
    return count > intervals.length * 0.5 ? total / count : Infinity;
  };

  let bestLag = 0;
  let bestError = errorAt(0);
  for (let lag = -300; lag <= 1200; lag += 10) {
    const error = errorAt(lag);
    if (error < bestError) {
      bestError = error;
      bestLag = lag;
    }
  }
  return { lagMs: bestLag, residual: Math.sqrt(bestError) };
}

// Rotates body-frame inputs into the direction of travel using the slip angle, so the fusion
// filter integrates the right acceleration and course rate even while the car is sliding.
function travelFrameInputs(vehicle, betas) {
  if (!betas) return vehicle;
  let betaIndex = 0;
  let previous = null;
  let slipRate = 0;
  return vehicle.map((sample) => {
    while (betaIndex < betas.length - 1 && betas[betaIndex + 1].t <= sample.t) betaIndex += 1;
    const entry = betas[betaIndex];
    const beta = entry && Math.abs(entry.t - sample.t) < 200 && Number.isFinite(entry.beta) ? (entry.beta * Math.PI) / 180 : 0;
    if (previous && sample.t > previous.t) {
      const rate = (beta - previous.beta) / ((sample.t - previous.t) / 1000);
      slipRate += 0.3 * (rate - slipRate);
    }
    previous = { t: sample.t, beta };
    if (!Number.isFinite(sample.longG)) return sample;
    const aForward = sample.longG * 9.80665;
    const aLeft = -sample.latG * 9.80665;
    return {
      ...sample,
      travelAccel: aForward * Math.cos(beta) - aLeft * Math.sin(beta),
      courseRate: Number.isFinite(sample.yawRate) ? sample.yawRate - slipRate : null,
    };
  });
}

// One row per 100 ms: position, speed and course from the smoothed GNSS/IMU trajectory (so
// samples between 1 Hz fixes follow the car through corners), plus averaged vehicle channels.
function buildSeries(smoothed, vehicle, betas, origin) {
  const series = [];
  let vehicleIndex = 0;
  let betaIndex = 0;
  let distance = 0;
  let previous = null;

  for (const state of smoothed) {
    if (previous) distance += ((state.v + previous.v) / 2) * ((state.t - previous.t) / 1000);
    previous = state;
    const t = (state.t - origin) / 1000;
    const row = {
      t,
      d: distance,
      v: state.v * KMH_FACTOR,
      la: state.lat,
      lo: state.lon,
      hdg: ((90 - (state.chi * 180) / Math.PI) % 360 + 360) % 360,
      lon: null,
      lat: null,
      yaw: null,
      beta: null,
    };

    const windowStart = state.t - SERIES_STEP_MS / 2;
    const windowEnd = state.t + SERIES_STEP_MS / 2;
    while (vehicleIndex < vehicle.length && vehicle[vehicleIndex].t < windowStart) vehicleIndex += 1;
    let longSum = 0;
    let latSum = 0;
    let vertSum = 0;
    let yawSum = 0;
    let count = 0;
    let yawCount = 0;
    for (let index = vehicleIndex; index < vehicle.length && vehicle[index].t < windowEnd; index += 1) {
      const sample = vehicle[index];
      if (Number.isFinite(sample.longG)) {
        longSum += sample.longG;
        latSum += sample.latG;
        vertSum += sample.vertG ?? 0;
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
      row.vert = vertSum / count;
    }
    if (yawCount) {
      row.yaw = ((yawSum / yawCount) * 180) / Math.PI;
    }

    if (betas) {
      while (betaIndex < betas.length - 1 && betas[betaIndex + 1].t <= windowEnd) betaIndex += 1;
      const beta = betas[betaIndex];
      if (beta && Math.abs(beta.t - state.t) < 250) row.beta = beta.beta;
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

  let calibration = run.calibration?.skipped ? run.calibration : calibrateRecording(imu, fixes, run.calibration);
  let vehicle = vehicleSeries(imu, calibration);
  const lag = estimateGnssLag(fixes, vehicle);
  if (lag && Math.abs(lag.lagMs) >= 20) {
    // Shift GNSS onto the IMU clock and re-solve the mount with the synchronised data.
    for (const fix of fixes) fix.t -= lag.lagMs;
    calibration = calibrateRecording(imu, fixes, run.calibration);
    vehicle = vehicleSeries(imu, calibration);
  }
  const hasG = vehicle.some((sample) => Number.isFinite(sample.longG));
  const betas = runDrift(vehicle, fixes);

  const points = buildPoints(fixes, origin);
  const smoothed = smoothTrajectory(fixes, travelFrameInputs(vehicle, betas), { stepMs: SERIES_STEP_MS });
  const series = buildSeries(smoothed, vehicle, betas, origin);

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
      gnssLagMs: lag?.lagMs ?? null,
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
