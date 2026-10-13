// Mount calibration: maps device-frame accelerometer/gyro readings into the vehicle frame.
//
// 1. Gravity (mount angle) is captured automatically whenever the car is stationary, or on demand.
// 2. The forward axis is solved continuously from GNSS: the average horizontal acceleration the
//    phone feels between two fixes is matched against the longitudinal (speed change) and lateral
//    (speed x course change) acceleration GNSS reports for the same interval. Braking, accelerating
//    and cornering all contribute, so there is no fragile "drive straight now" step.
// 3. Axis handedness and gyro sign are resolved from the data too, which absorbs platform quirks
//    such as iOS reporting accelerationIncludingGravity with the opposite sign.

import { bearingDegrees, haversineMeters, toRadians, wrapRadians } from "./geo.js";

export const GRAVITY = 9.80665;

const STATIONARY_WINDOW_MS = 1500;
const STATIONARY_EVAL_MS = 500;
const MOUNT_MOVED_DEGREES = 7;
const GRAVITY_REFINE_INTERVAL_MS = 10000;
const PROVISIONAL_GRAVITY_MS = 20000;
const MIN_INTERVAL_MS = 400;
const MAX_INTERVAL_MS = 3000;
const MAX_INTERVALS = 900;
const MIN_SIGNAL = 0.6;
const READY_QUALITY = 0.55;
const READY_INTERVALS = 8;
const READY_SIGNAL_ENERGY = 15;
const HANDEDNESS_ENERGY = 25;
const STRAIGHT_YAW_RATE = 0.1;

const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
const add = (a, b) => vec(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => vec(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a, k) => vec(a.x * k, a.y * k, a.z * k);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const magnitude = (a) => Math.hypot(a.x, a.y, a.z);

function normalize(a, fallback = vec(0, 0, 1)) {
  const length = magnitude(a);
  return length > 1e-9 ? scale(a, 1 / length) : { ...fallback };
}

function projectOntoPlane(a, normal) {
  return sub(a, scale(normal, dot(a, normal)));
}

function planeBasis(up) {
  const reference = Math.abs(up.z) < 0.9 ? vec(0, 0, 1) : vec(1, 0, 0);
  const e1 = normalize(projectOntoPlane(reference, up), vec(1, 0, 0));
  return { e1, e2: cross(up, e1) };
}

function angleBetweenDegrees(a, b) {
  const cosine = dot(normalize(a), normalize(b));
  return (Math.acos(Math.min(1, Math.max(-1, cosine))) * 180) / Math.PI;
}

function accelVector(sample) {
  return Number.isFinite(sample?.ax) && Number.isFinite(sample?.ay) && Number.isFinite(sample?.az)
    ? vec(sample.ax, sample.ay, sample.az)
    : null;
}

function gyroVector(sample) {
  return Number.isFinite(sample?.gx) && Number.isFinite(sample?.gy) && Number.isFinite(sample?.gz)
    ? vec(sample.gx, sample.gy, sample.gz)
    : null;
}

function dominantAxisLabel(vector) {
  const axis = ["x", "y", "z"].reduce((best, key) =>
    Math.abs(vector[key]) > Math.abs(vector[best]) ? key : best,
  );
  return `${vector[axis] >= 0 ? "+" : "-"}${axis.toUpperCase()}`;
}

export function courseOf(fix, previousFix) {
  if (Number.isFinite(fix?.heading) && Number.isFinite(fix?.speed) && fix.speed > 1.5) {
    return fix.heading;
  }
  if (previousFix && haversineMeters(previousFix, fix) > 1.5) {
    return bearingDegrees(previousFix, fix);
  }
  return null;
}

// Projects one device-frame sample into the vehicle frame using a calibration snapshot.
// latG is positive to the right, longG positive when accelerating, yawRate (rad/s) positive turning left.
export function projectSample(calibration, sample) {
  const result = {
    longG: null,
    latG: null,
    vertG: null,
    yawRate: null,
    gravityReady: false,
    forwardReady: false,
  };
  const gravity = calibration?.gravity;
  const accel = accelVector(sample);
  if (!gravity || !accel || calibration.skipped) {
    return result;
  }

  const up = normalize(gravity);
  const h = sub(accel, gravity);
  result.gravityReady = true;
  result.vertG = dot(h, up) / GRAVITY;

  if (calibration.forward) {
    const forward = normalize(projectOntoPlane(calibration.forward, up));
    const left = scale(cross(up, forward), calibration.mirrored ? -1 : 1);
    result.longG = dot(h, forward) / GRAVITY;
    result.latG = -dot(h, left) / GRAVITY;
    result.forwardReady = true;
  }

  const gyro = gyroVector(sample);
  if (gyro) {
    const bias = calibration.gyroBias ?? vec();
    result.yawRate =
      (calibration.yawSign ?? 1) * (calibration.yawScale ?? 1) * dot(sub(gyro, bias), up);
  }

  return result;
}

export class MountCalibration {
  constructor({ onEvent, maxIntervals = MAX_INTERVALS } = {}) {
    this.onEvent = onEvent;
    this.maxIntervals = maxIntervals;
    this.reset();
  }

  reset() {
    this.gravity = null;
    this.gravityProvisional = false;
    this.gravitySource = null;
    this.gyroBias = null;
    this.forward = null;
    this.forwardSource = null;
    this.mirrored = false;
    this.handednessKnown = false;
    this.yawSign = 1;
    this.yawScale = 1;
    this.quality = 0;
    this.skipped = false;
    this.intervals = [];
    this.window = [];
    this.lastEvaluation = 0;
    this.lastRefine = 0;
    this.firstSampleAt = 0;
    this.meanAccumulator = { sum: vec(), count: 0 };
    this.manualCapture = null;
    this.lastFix = null;
    this.anchor = null;
  }

  snapshot() {
    return {
      version: 1,
      gravity: this.gravity,
      gravityProvisional: this.gravityProvisional,
      gyroBias: this.gyroBias,
      forward: this.forward,
      mirrored: this.mirrored,
      handednessKnown: this.handednessKnown,
      yawSign: this.yawSign,
      yawScale: this.yawScale,
      quality: this.quality,
      intervalCount: this.intervals.length,
      skipped: this.skipped,
      updatedAt: Date.now(),
    };
  }

  restore(snapshot) {
    if (!snapshot || snapshot.version !== 1) {
      return false;
    }
    this.reset();
    this.skipped = Boolean(snapshot.skipped);
    this.gravity = snapshot.gravity ?? null;
    this.gravityProvisional = Boolean(snapshot.gravityProvisional);
    this.gravitySource = this.gravity ? "restored" : null;
    this.gyroBias = snapshot.gyroBias ?? null;
    this.forward = snapshot.forward ?? null;
    this.forwardSource = this.forward ? "restored" : null;
    this.mirrored = Boolean(snapshot.mirrored);
    this.handednessKnown = Boolean(snapshot.handednessKnown);
    this.yawSign = snapshot.yawSign === -1 ? -1 : 1;
    this.yawScale = Number.isFinite(snapshot.yawScale) ? snapshot.yawScale : 1;
    this.quality = snapshot.quality ?? 0;
    return true;
  }

  skip() {
    this.reset();
    this.skipped = true;
  }

  isSkipped() {
    return this.skipped;
  }

  hasGravity() {
    return Boolean(this.gravity) && !this.gravityProvisional;
  }

  hasForward() {
    return Boolean(this.forward);
  }

  startManualCapture(durationMs = 1500) {
    this.skipped = false;
    this.manualCapture = { until: 0, durationMs, sum: vec(), gyroSum: vec(), gyroCount: 0, count: 0 };
  }

  isCapturing() {
    return Boolean(this.manualCapture);
  }

  ingestFix(fix) {
    if (this.skipped || !Number.isFinite(fix?.t)) {
      return;
    }

    const course = courseOf(fix, this.lastFix);
    const current = { t: fix.t, speed: fix.speed, course, lat: fix.lat, lon: fix.lon };
    this.lastFix = { ...fix, receivedAt: fix.t };

    if (!this.anchor || !Number.isFinite(current.speed)) {
      this.startAnchor(current);
      return;
    }

    const dtMs = current.t - this.anchor.t;
    if (dtMs < MIN_INTERVAL_MS) {
      return;
    }
    if (dtMs > MAX_INTERVAL_MS || this.anchor.count < 3) {
      this.startAnchor(current);
      return;
    }

    const dt = dtMs / 1000;
    const meanSpeed = (current.speed + this.anchor.speed) / 2;
    const aLong = (current.speed - this.anchor.speed) / dt;
    let courseRate = null;
    if (meanSpeed > 4 && current.course != null && this.anchor.course != null) {
      // Course is clockwise from north; convert to a counter-clockwise (left-positive) rate.
      courseRate = -wrapRadians(toRadians(current.course - this.anchor.course)) / dt;
    }

    this.intervals.push({
      meanAccel: scale(this.anchor.sum, 1 / this.anchor.count),
      meanGyro: this.anchor.gyroCount ? scale(this.anchor.gyroSum, 1 / this.anchor.gyroCount) : null,
      aLong,
      aLat: courseRate != null ? meanSpeed * courseRate : null,
      courseRate,
    });
    if (this.intervals.length > this.maxIntervals) {
      this.intervals.splice(0, this.intervals.length - this.maxIntervals);
    }

    this.startAnchor(current);
    this.solve();
  }

  startAnchor(fix) {
    this.anchor = { ...fix, sum: vec(), count: 0, gyroSum: vec(), gyroCount: 0 };
  }

  ingestMotion(sample) {
    if (this.skipped) {
      return;
    }
    const accel = accelVector(sample);
    if (!accel) {
      return;
    }
    const gyro = gyroVector(sample);
    const t = sample.t;

    if (this.anchor) {
      this.anchor.sum = add(this.anchor.sum, accel);
      this.anchor.count += 1;
      if (gyro) {
        this.anchor.gyroSum = add(this.anchor.gyroSum, gyro);
        this.anchor.gyroCount += 1;
      }
    }

    if (this.manualCapture) {
      this.ingestManualCapture(t, accel, gyro);
    }

    this.trackProvisionalGravity(t, accel);
    this.window.push({ t, accel, gyro });
    while (this.window.length && t - this.window[0].t > STATIONARY_WINDOW_MS) {
      this.window.shift();
    }
    if (t - this.lastEvaluation >= STATIONARY_EVAL_MS) {
      this.lastEvaluation = t;
      this.evaluateStationary(t);
    }
  }

  ingestManualCapture(t, accel, gyro) {
    const capture = this.manualCapture;
    if (!capture.until) {
      capture.until = t + capture.durationMs;
    }
    capture.sum = add(capture.sum, accel);
    capture.count += 1;
    if (gyro) {
      capture.gyroSum = add(capture.gyroSum, gyro);
      capture.gyroCount += 1;
    }
    if (t < capture.until) {
      return;
    }

    this.manualCapture = null;
    const gravity = capture.count ? scale(capture.sum, 1 / capture.count) : null;
    if (!gravity || magnitude(gravity) < 4 || magnitude(gravity) > 15) {
      this.onEvent?.("capture-failed");
      return;
    }
    const gyroBias = capture.gyroCount ? scale(capture.gyroSum, 1 / capture.gyroCount) : this.gyroBias;
    this.applyGravity(gravity, gyroBias, "manual", true);
    this.onEvent?.("captured");
  }

  trackProvisionalGravity(t, accel) {
    if (this.gravity && !this.gravityProvisional) {
      return;
    }
    if (!this.firstSampleAt) {
      this.firstSampleAt = t;
    }
    this.meanAccumulator.sum = add(this.meanAccumulator.sum, accel);
    this.meanAccumulator.count += 1;
    // The car never stopped while we were listening: fall back to the long-run mean so the
    // live view is usable. It is replaced as soon as a real stationary capture happens.
    if (t - this.firstSampleAt >= PROVISIONAL_GRAVITY_MS) {
      this.gravity = scale(this.meanAccumulator.sum, 1 / this.meanAccumulator.count);
      this.gravityProvisional = true;
      this.gravitySource = "provisional";
    }
  }

  evaluateStationary(t) {
    if (this.window.length < 6 || t - this.window[0].t < STATIONARY_WINDOW_MS * 0.8) {
      return;
    }

    const fixFresh = this.lastFix && Number.isFinite(this.lastFix.speed) && t - this.lastFix.receivedAt < 3000;
    if (fixFresh && this.lastFix.speed > 0.8) {
      return;
    }
    const gpsConfirmsStop = fixFresh && this.lastFix.speed <= 0.8;

    let sum = vec();
    let gyroSum = vec();
    let gyroCount = 0;
    const magnitudes = [];
    for (const item of this.window) {
      sum = add(sum, item.accel);
      magnitudes.push(magnitude(item.accel));
      if (item.gyro) {
        gyroSum = add(gyroSum, item.gyro);
        gyroCount += 1;
      }
    }
    const mean = scale(sum, 1 / this.window.length);
    const meanMagnitude = magnitudes.reduce((total, value) => total + value, 0) / magnitudes.length;
    const std = Math.sqrt(
      magnitudes.reduce((total, value) => total + (value - meanMagnitude) ** 2, 0) / magnitudes.length,
    );
    if (meanMagnitude < 8.8 || meanMagnitude > 10.8 || std > (gpsConfirmsStop ? 0.4 : 0.15)) {
      return;
    }

    let gyroBias = null;
    if (gyroCount) {
      gyroBias = scale(gyroSum, 1 / gyroCount);
      let rotationSum = 0;
      for (const item of this.window) {
        if (item.gyro) rotationSum += magnitude(sub(item.gyro, gyroBias));
      }
      if (rotationSum / gyroCount > (gpsConfirmsStop ? 0.08 : 0.04)) {
        return;
      }
    }

    if (!this.gravity || this.gravityProvisional) {
      this.applyGravity(mean, gyroBias, "auto", true);
      this.onEvent?.("captured");
      return;
    }

    if (angleBetweenDegrees(mean, this.gravity) > MOUNT_MOVED_DEGREES) {
      this.applyGravity(mean, gyroBias, "auto", true);
      this.onEvent?.("mount-moved");
      return;
    }

    if (t - this.lastRefine >= GRAVITY_REFINE_INTERVAL_MS) {
      this.lastRefine = t;
      this.gravity = add(scale(this.gravity, 0.9), scale(mean, 0.1));
      if (gyroBias) {
        this.gyroBias = this.gyroBias ? add(scale(this.gyroBias, 0.7), scale(gyroBias, 0.3)) : gyroBias;
      }
    }
  }

  applyGravity(gravity, gyroBias, source, resetForward) {
    const moved = this.gravity && !this.gravityProvisional && angleBetweenDegrees(gravity, this.gravity) > MOUNT_MOVED_DEGREES;
    this.gravity = gravity;
    this.gravityProvisional = false;
    this.gravitySource = source;
    this.lastRefine = 0;
    if (gyroBias) {
      this.gyroBias = gyroBias;
    }
    if (resetForward && (moved || this.forwardSource === "restored")) {
      // Interval data collected against a different mount angle is no longer meaningful.
      this.intervals = moved ? [] : this.intervals;
      if (moved) {
        this.forward = null;
        this.forwardSource = null;
        this.quality = 0;
      }
    }
    this.solve();
  }

  solve() {
    if (!this.gravity || this.intervals.length < 3) {
      return;
    }

    const result = solveForward(this.intervals, this.gravity, this.gyroBias, {
      mirrored: this.mirrored,
      handednessKnown: this.handednessKnown,
    });
    if (!result) {
      return;
    }

    if (result.handednessKnown) {
      this.mirrored = result.mirrored;
      this.handednessKnown = true;
    }
    if (result.yawSign) {
      this.yawSign = result.yawSign;
      this.yawScale = result.yawScale;
    }
    if (result.ready) {
      const isNew = !this.forward || this.forwardSource !== "solved";
      this.forward = result.forward;
      this.forwardSource = "solved";
      this.quality = result.quality;
      if (isNew) {
        this.onEvent?.("forward-ready");
      }
    } else if (this.forwardSource !== "solved" && this.forwardSource !== "restored") {
      this.quality = result.quality;
    }
  }

  project(sample) {
    return projectSample(this.snapshot(), sample);
  }

  getStatus() {
    const up = this.gravity ? normalize(this.gravity) : null;
    return {
      skipped: this.skipped,
      capturing: Boolean(this.manualCapture),
      gravity: this.skipped
        ? "Skipped"
        : !this.gravity
          ? "Waiting for the car to stop"
          : this.gravityProvisional
            ? "Provisional (stop for 2 s to lock)"
            : `${this.gravitySource === "restored" ? "Restored" : "Locked"} (up ${dominantAxisLabel(up)})`,
      forward: this.skipped
        ? "Skipped"
        : this.forwardSource === "solved"
          ? `Auto-solved, ${Math.round(this.quality * 100)}% fit (${dominantAxisLabel(this.forward)})`
          : this.forwardSource === "restored"
            ? `Restored (${dominantAxisLabel(this.forward)}), re-checking while driving`
            : this.intervals.length
              ? `Solving from GPS... ${Math.min(99, Math.round((this.intervals.length / 40) * 100))}%`
              : "Solves automatically once you drive",
      gyro: this.skipped
        ? "Skipped"
        : this.gyroBias
          ? `Bias ${((magnitude(this.gyroBias) * 180) / Math.PI).toFixed(2)} deg/s`
          : "Not measured yet",
      gravityReady: Boolean(this.gravity),
      forwardReady: Boolean(this.forward),
      intervals: this.intervals.length,
    };
  }
}

function emptySums() {
  return { aRe: 0, aIm: 0, bRe: 0, bIm: 0, uEnergy: 0, wEnergy: 0, lateralEnergy: 0, count: 0 };
}

function accumulate(sums, uRe, uIm, wRe, wIm) {
  // u * conj(w) for the direct hypothesis, u * w for the mirrored one.
  sums.aRe += uRe * wRe + uIm * wIm;
  sums.aIm += uIm * wRe - uRe * wIm;
  sums.bRe += uRe * wRe - uIm * wIm;
  sums.bIm += uRe * wIm + uIm * wRe;
  sums.uEnergy += uRe * uRe + uIm * uIm;
  sums.wEnergy += wRe * wRe + wIm * wIm;
  sums.lateralEnergy += wIm * wIm;
  sums.count += 1;
}

function qualities(sums) {
  const norm = Math.sqrt(sums.uEnergy * sums.wEnergy) || 1;
  return {
    direct: Math.hypot(sums.aRe, sums.aIm) / norm,
    mirrored: Math.hypot(sums.bRe, sums.bIm) / norm,
  };
}

function isReady(sums, quality) {
  return sums.count >= READY_INTERVALS && quality >= READY_QUALITY && sums.wEnergy >= READY_SIGNAL_ENERGY;
}

export function solveForward(intervals, gravity, gyroBias, prior = {}) {
  const up = normalize(gravity);
  const { e1, e2 } = planeBasis(up);
  const all = emptySums();
  // While sliding, the body points away from the direction of travel, so GNSS accelerations
  // (travel frame) and IMU accelerations (body frame) disagree by the slip angle. Low yaw rate
  // intervals (straight-line braking/accelerating) are slip-free and determine the axis angle.
  const straight = emptySums();
  let yawCross = 0;
  let yawEnergy = 0;
  let courseEnergy = 0;

  for (const interval of intervals) {
    let yaw = null;
    if (interval.meanGyro) {
      yaw = dot(sub(interval.meanGyro, gyroBias ?? vec()), up);
      if (interval.courseRate != null) {
        yawCross += yaw * interval.courseRate;
        yawEnergy += yaw * yaw;
        courseEnergy += interval.courseRate ** 2;
      }
    }

    const wRe = interval.aLong;
    const wIm = interval.aLat ?? 0;
    if (!Number.isFinite(wRe) || Math.hypot(wRe, wIm) < MIN_SIGNAL) {
      continue;
    }
    const h = sub(interval.meanAccel, gravity);
    const uRe = dot(h, e1);
    const uIm = dot(h, e2);
    accumulate(all, uRe, uIm, wRe, wIm);
    const courseRate = interval.courseRate ?? 0;
    if (yaw != null ? Math.abs(yaw) < STRAIGHT_YAW_RATE : Math.abs(courseRate) < STRAIGHT_YAW_RATE) {
      accumulate(straight, uRe, uIm, wRe, wIm);
    }
  }

  if (!all.count || !all.uEnergy || !all.wEnergy) {
    return null;
  }

  const allQuality = qualities(all);
  let mirrored = Boolean(prior.mirrored);
  let handednessKnown = Boolean(prior.handednessKnown);
  if (all.lateralEnergy >= HANDEDNESS_ENERGY && Math.abs(allQuality.direct - allQuality.mirrored) > 0.08) {
    mirrored = allQuality.mirrored > allQuality.direct;
    handednessKnown = true;
  }

  const straightQuality = qualities(straight);
  const useStraight = isReady(straight, mirrored ? straightQuality.mirrored : straightQuality.direct);
  const sums = useStraight ? straight : all;
  const quality = useStraight
    ? (mirrored ? straightQuality.mirrored : straightQuality.direct)
    : (mirrored ? allQuality.mirrored : allQuality.direct);
  const rRe = mirrored ? sums.bRe : sums.aRe;
  const rIm = mirrored ? sums.bIm : sums.aIm;
  const rLength = Math.hypot(rRe, rIm) || 1;
  const forward = normalize(add(scale(e1, rRe / rLength), scale(e2, rIm / rLength)));

  let yawSign = null;
  let yawScale = 1;
  if (courseEnergy >= 0.3 && yawEnergy > 0) {
    const gain = yawCross / yawEnergy;
    yawSign = gain < 0 ? -1 : 1;
    const absGain = Math.abs(gain);
    // Tolerate GPS lag; only rescale when the gyro is clearly reporting the wrong unit.
    yawScale = absGain > 20 || absGain < 0.05 ? absGain : 1;
  }

  return {
    forward,
    mirrored,
    handednessKnown,
    quality,
    yawSign,
    yawScale,
    ready: isReady(sums, quality),
  };
}

// ---------- trajectory alignment (post-run) ----------

// Eigen-decomposition of a symmetric 4x4 matrix (cyclic Jacobi). Returns the eigenvector of
// the largest eigenvalue.
function largestEigenvector4(matrix) {
  const a = matrix.map((row) => [...row]);
  const v = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  for (let sweep = 0; sweep < 60; sweep += 1) {
    let offDiagonal = 0;
    for (let p = 0; p < 4; p += 1) for (let q = p + 1; q < 4; q += 1) offDiagonal += a[p][q] ** 2;
    if (offDiagonal < 1e-18) break;
    for (let p = 0; p < 4; p += 1) {
      for (let q = p + 1; q < 4; q += 1) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const sn = t * c;
        for (let k = 0; k < 4; k += 1) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - sn * akq;
          a[k][q] = sn * akp + c * akq;
        }
        for (let k = 0; k < 4; k += 1) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - sn * aqk;
          a[q][k] = sn * apk + c * aqk;
        }
        for (let k = 0; k < 4; k += 1) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - sn * vkq;
          v[k][q] = sn * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let index = 1; index < 4; index += 1) if (a[index][index] > a[best][best]) best = index;
  return v.map((row) => row[best]);
}

// Wahba's problem via Davenport's q-method: the rotation A minimising sum w |b - A r|^2.
// Returns a function applying A to a vector.
function solveWahba(pairs) {
  const B = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const { b, r, w } of pairs) {
    const bv = [b.x, b.y, b.z];
    const rv = [r.x, r.y, r.z];
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) B[i][j] += w * bv[i] * rv[j];
  }
  const sigma = B[0][0] + B[1][1] + B[2][2];
  const z = [B[1][2] - B[2][1], B[2][0] - B[0][2], B[0][1] - B[1][0]];
  const K = [
    [2 * B[0][0] - sigma, B[0][1] + B[1][0], B[0][2] + B[2][0], z[0]],
    [B[1][0] + B[0][1], 2 * B[1][1] - sigma, B[1][2] + B[2][1], z[1]],
    [B[2][0] + B[0][2], B[2][1] + B[1][2], 2 * B[2][2] - sigma, z[2]],
    [z[0], z[1], z[2], sigma],
  ];
  const [q1, q2, q3, q4] = largestEigenvector4(K);
  const d = q4 * q4 - (q1 * q1 + q2 * q2 + q3 * q3);
  const qv = [q1, q2, q3];
  const skew = [
    [0, -q3, q2],
    [q3, 0, -q1],
    [-q2, q1, 0],
  ];
  const A = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => (i === j ? d : 0) + 2 * qv[i] * qv[j] - 2 * q4 * skew[i][j]),
  );
  return (r) =>
    vec(
      A[0][0] * r.x + A[0][1] * r.y + A[0][2] * r.z,
      A[1][0] * r.x + A[1][1] * r.y + A[1][2] * r.z,
      A[2][0] * r.x + A[2][1] * r.y + A[2][2] * r.z,
    );
}

const ALIGN_MIN_INTERVALS = 20;
const ALIGN_MIN_SIGNAL_ENERGY = 40;
const ROBUST_SCALE = 0.8;
const TURNING_WEIGHT = 0.1;

// Solves the full mount rotation and accelerometer bias from the GNSS trajectory: every GNSS
// interval says what the car's acceleration was (longitudinal from speed change, lateral from
// speed x course rate, plus gravity). Needs no stationary capture, and road grades/banking
// average out over a session. Both sign conventions are tried (iOS reports the opposite sign).
export function alignToTrajectory(intervals, gyroBias = null) {
  const usable = [];
  let signalEnergy = 0;
  for (const interval of intervals) {
    if (!Number.isFinite(interval.aLong)) continue;
    const aLat = interval.aLat ?? 0;
    let weight = interval.aLat == null ? 0.5 : 1;
    // The body can only be slipping (pointing away from the direction of travel) while it is
    // rotating, so turning intervals get a small weight. They still supply lateral excitation.
    const turnRate = interval.meanGyro
      ? magnitude(sub(interval.meanGyro, gyroBias ?? vec()))
      : Math.abs(interval.courseRate ?? 0);
    if (turnRate > STRAIGHT_YAW_RATE) weight *= TURNING_WEIGHT;
    usable.push({ accel: interval.meanAccel, r: vec(interval.aLong, aLat, GRAVITY), w: weight });
    signalEnergy += interval.aLong ** 2 + aLat ** 2;
  }
  if (usable.length < ALIGN_MIN_INTERVALS || signalEnergy < ALIGN_MIN_SIGNAL_ENERGY) {
    return null;
  }

  let best = null;
  for (const sign of [1, -1]) {
    let bias = vec();
    let rotate = null;
    let weights = usable.map((item) => item.w);
    // Iteratively reweighted: intervals that disagree with the fit (sliding corners, GNSS
    // glitches) are down-weighted with a Cauchy kernel so they cannot tilt the solution.
    for (let iteration = 0; iteration < 8; iteration += 1) {
      rotate = solveWahba(
        usable.map((item, index) => ({ b: scale(sub(item.accel, bias), sign), r: item.r, w: weights[index] })),
      );
      let residual = vec();
      let weightSum = 0;
      usable.forEach((item, index) => {
        residual = add(residual, scale(sub(item.accel, scale(rotate(item.r), sign)), weights[index]));
        weightSum += weights[index];
      });
      bias = scale(residual, 1 / weightSum);
      if (iteration >= 2) {
        weights = usable.map((item) => {
          const error = magnitude(sub(item.accel, add(scale(rotate(item.r), sign), bias)));
          return item.w / (1 + (error / ROBUST_SCALE) ** 2);
        });
      }
    }
    let loss = 0;
    let energy = 0;
    for (const item of usable) {
      const errorVector = sub(item.accel, add(scale(rotate(item.r), sign), bias));
      loss += item.w * dot(errorVector, errorVector);
      energy += item.w * (item.r.x ** 2 + item.r.y ** 2);
    }
    if (!best || loss < best.loss) {
      best = { sign, rotate, bias, loss, energy };
    }
  }

  const { sign, rotate, bias } = best;
  return {
    gravity: add(scale(rotate(vec(0, 0, GRAVITY)), sign), bias),
    forward: normalize(scale(rotate(vec(1, 0, 0)), sign)),
    mirrored: sign < 0,
    // Share of the dynamic (horizontal) signal explained by the fit.
    quality: Math.max(0, 1 - best.loss / (best.energy || 1)),
    accelBias: bias,
  };
}

// Re-runs calibration over a whole recording, after the run. The mount is re-aligned against
// the complete GNSS trajectory, so which way is forward is corrected even if the live solve
// never converged. Falls back to the live snapshot where the recording cannot decide.
export function calibrateRecording(imu, gnss, prior) {
  if (prior?.skipped || !imu?.length) {
    return prior ?? null;
  }

  const calibration = new MountCalibration({ maxIntervals: Infinity });
  if (prior?.gravity) {
    calibration.restore({ ...prior, forward: null });
    calibration.gravitySource = "live";
  }

  let gnssIndex = 0;
  for (const sample of imu) {
    while (gnssIndex < gnss.length && gnss[gnssIndex].t <= sample.t) {
      calibration.ingestFix(gnss[gnssIndex]);
      gnssIndex += 1;
    }
    calibration.ingestMotion(sample);
  }
  while (gnssIndex < gnss.length) {
    calibration.ingestFix(gnss[gnssIndex]);
    gnssIndex += 1;
  }
  calibration.solve();
  const snapshot = calibration.snapshot();
  snapshot.alignment = snapshot.forward ? "solver" : null;

  let aligned = alignToTrajectory(calibration.intervals, calibration.gyroBias);
  const stationaryGravity = calibration.hasGravity() ? calibration.gravity : null;
  if (aligned && stationaryGravity && angleBetweenDegrees(aligned.gravity, stationaryGravity) > 6) {
    aligned = null;
  }
  if (aligned) {
    snapshot.gravity = aligned.gravity;
    snapshot.gravityProvisional = false;
    snapshot.accelBias = aligned.accelBias;
    snapshot.alignment = "trajectory";
    // Refine forward with slip-free (straight-line) intervals against the trajectory gravity.
    const refined = solveForward(calibration.intervals, aligned.gravity, calibration.gyroBias, {
      mirrored: aligned.mirrored,
      handednessKnown: true,
    });
    if (refined?.ready) {
      snapshot.forward = refined.forward;
      snapshot.mirrored = refined.mirrored;
      snapshot.quality = refined.quality;
      if (refined.yawSign) {
        snapshot.yawSign = refined.yawSign;
        snapshot.yawScale = refined.yawScale;
      }
    } else {
      snapshot.forward = aligned.forward;
      snapshot.mirrored = aligned.mirrored;
      snapshot.quality = aligned.quality;
    }
  }

  if (!snapshot.forward && prior?.forward) {
    snapshot.forward = prior.forward;
    snapshot.mirrored = prior.mirrored;
    snapshot.quality = prior.quality;
    snapshot.alignment = "live";
  }
  if (!snapshot.gravity && prior?.gravity) {
    snapshot.gravity = prior.gravity;
  }
  return snapshot;
}
