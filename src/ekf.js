// GNSS/IMU fusion. GNSS is the slow sensor (often 1 Hz); between fixes the state is dead-reckoned
// from vehicle-frame longitudinal acceleration and gyro yaw rate, and every fix corrects it.
//
// State: [x, y, v, chi, accelBias, yawBias]
//   x, y   local east/north metres
//   v      speed along the direction of travel (m/s)
//   chi    course, radians counter-clockwise from east
//   biases on the longitudinal accelerometer (m/s^2) and the yaw gyro (rad/s)
//
// The course is unknown until the car is moving forward: it is initialised from the first two
// consecutive moving GNSS fixes whose courses agree.

import { makeProjector, toRadians, wrapRadians } from "./geo.js";

const N = 6;
const GRAVITY = 9.80665;
const HEADING_INIT_SPEED = 3;
const HEADING_INIT_AGREEMENT = 0.35;
const COURSE_UPDATE_SPEED = 4;
const GATE_CHI2 = 30;
const MAX_REJECTIONS = 3;

const idx = (row, column) => row * N + column;

function identity() {
  const m = new Float64Array(N * N);
  for (let i = 0; i < N; i += 1) m[idx(i, i)] = 1;
  return m;
}

function multiply(a, b) {
  const out = new Float64Array(N * N);
  for (let i = 0; i < N; i += 1) {
    for (let k = 0; k < N; k += 1) {
      const aik = a[idx(i, k)];
      if (!aik) continue;
      for (let j = 0; j < N; j += 1) out[idx(i, j)] += aik * b[idx(k, j)];
    }
  }
  return out;
}

function transpose(a) {
  const out = new Float64Array(N * N);
  for (let i = 0; i < N; i += 1) for (let j = 0; j < N; j += 1) out[idx(j, i)] = a[idx(i, j)];
  return out;
}

function invert(a) {
  const m = Float64Array.from(a);
  const inv = identity();
  for (let column = 0; column < N; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < N; row += 1) {
      if (Math.abs(m[idx(row, column)]) > Math.abs(m[idx(pivot, column)])) pivot = row;
    }
    const pivotValue = m[idx(pivot, column)];
    if (Math.abs(pivotValue) < 1e-12) return null;
    if (pivot !== column) {
      for (let j = 0; j < N; j += 1) {
        [m[idx(column, j)], m[idx(pivot, j)]] = [m[idx(pivot, j)], m[idx(column, j)]];
        [inv[idx(column, j)], inv[idx(pivot, j)]] = [inv[idx(pivot, j)], inv[idx(column, j)]];
      }
    }
    for (let j = 0; j < N; j += 1) {
      m[idx(column, j)] /= pivotValue;
      inv[idx(column, j)] /= pivotValue;
    }
    for (let row = 0; row < N; row += 1) {
      if (row === column) continue;
      const factor = m[idx(row, column)];
      if (!factor) continue;
      for (let j = 0; j < N; j += 1) {
        m[idx(row, j)] -= factor * m[idx(column, j)];
        inv[idx(row, j)] -= factor * inv[idx(column, j)];
      }
    }
  }
  return inv;
}

// GNSS heading is clockwise from north in degrees; the filter works counter-clockwise from east.
export function courseToChi(courseDegrees) {
  return Number.isFinite(courseDegrees) ? wrapRadians(Math.PI / 2 - toRadians(courseDegrees)) : null;
}

export class NavFilter {
  constructor() {
    this.reset();
  }

  reset() {
    this.x = new Float64Array(N);
    this.P = identity();
    this.t = null;
    this.initialized = false;
    this.headingReady = false;
    this.previousMovingCourse = null;
    this.rejections = 0;
    this.input = { accel: null, yaw: null, lateral: null };
    this.resetCount = 0;
  }

  // Vehicle-frame inputs held until the next sample: longitudinal accel (m/s^2), yaw rate
  // (rad/s, left positive) and lateral accel (m/s^2, left positive). Any may be null.
  setInput(input) {
    this.input = input;
  }

  start(t, position, speed, accuracy) {
    const sigma = Math.max(accuracy ?? 5, 2);
    this.x = Float64Array.from([position.x, position.y, Math.max(0, speed ?? 0), 0, 0, 0]);
    this.P = new Float64Array(N * N);
    this.P[idx(0, 0)] = sigma * sigma;
    this.P[idx(1, 1)] = sigma * sigma;
    this.P[idx(2, 2)] = 1;
    this.P[idx(3, 3)] = Math.PI * Math.PI;
    this.P[idx(4, 4)] = 0.3 ** 2;
    this.P[idx(5, 5)] = 0.02 ** 2;
    this.t = t;
    this.initialized = true;
    this.headingReady = false;
    this.previousMovingCourse = null;
    this.resetCount += 1;
  }

  // Propagates to time `t` (ms). Returns the transition matrix used (for smoothing).
  predict(t) {
    if (!this.initialized || t <= this.t) {
      return identity();
    }
    const dt = Math.min((t - this.t) / 1000, 2);
    this.t = t;
    const x = this.x;
    const v = x[2];
    const chi = x[3];
    const { accel, yaw, lateral } = this.input;
    const hasAccel = Number.isFinite(accel);
    const hasYaw = Number.isFinite(yaw);
    const hasLateral = Number.isFinite(lateral);

    const a = hasAccel ? accel - x[4] : 0;
    let rate = 0;
    if (this.headingReady) {
      if (hasYaw) rate = yaw - x[5];
      else if (hasLateral && v > HEADING_INIT_SPEED) rate = lateral / v;
    }

    const F = identity();
    if (this.headingReady) {
      const cos = Math.cos(chi);
      const sin = Math.sin(chi);
      x[0] += (v * dt + 0.5 * a * dt * dt) * cos;
      x[1] += (v * dt + 0.5 * a * dt * dt) * sin;
      F[idx(0, 2)] = cos * dt;
      F[idx(0, 3)] = -v * sin * dt;
      F[idx(1, 2)] = sin * dt;
      F[idx(1, 3)] = v * cos * dt;
    }
    x[2] = Math.max(0, v + a * dt);
    x[3] = wrapRadians(chi + rate * dt);
    if (hasAccel) F[idx(2, 4)] = -dt;
    if (hasYaw && this.headingReady) F[idx(3, 5)] = -dt;

    // Process noise: tight when IMU inputs drive the model, loose when coasting on assumptions.
    const positionNoise = this.headingReady ? 0.3 : Math.max(v, 1) * 1.5;
    const speedNoise = hasAccel ? 0.6 : 2.5;
    const courseNoise = hasYaw ? 0.03 : hasLateral ? 0.12 : 0.5;
    const Q = [positionNoise ** 2, positionNoise ** 2, speedNoise ** 2, courseNoise ** 2, 0.02 ** 2, 0.002 ** 2];

    const P = multiply(multiply(F, this.P), transpose(F));
    for (let i = 0; i < N; i += 1) P[idx(i, i)] += Q[i] * dt;
    this.P = P;
    return F;
  }

  scalarUpdate(stateIndex, innovation, variance) {
    const S = this.P[idx(stateIndex, stateIndex)] + variance;
    if (S <= 0) return;
    const gain = new Float64Array(N);
    for (let i = 0; i < N; i += 1) gain[i] = this.P[idx(i, stateIndex)] / S;
    for (let i = 0; i < N; i += 1) this.x[i] += gain[i] * innovation;
    this.x[3] = wrapRadians(this.x[3]);
    if (this.x[2] < 0) this.x[2] = 0;
    const row = new Float64Array(N);
    for (let j = 0; j < N; j += 1) row[j] = this.P[idx(stateIndex, j)];
    for (let i = 0; i < N; i += 1) {
      for (let j = 0; j < N; j += 1) this.P[idx(i, j)] -= gain[i] * row[j];
    }
  }

  // measurement: {t, x, y, speed, chi (rad|null), accuracy}
  update(measurement) {
    if (!this.initialized) {
      this.start(measurement.t, measurement, measurement.speed, measurement.accuracy);
      return { accepted: true, reset: true };
    }

    const sigma = Math.min(Math.max((measurement.accuracy ?? 5) * 0.7, 1.5), 30);
    const variance = sigma * sigma;
    const dx = measurement.x - this.x[0];
    const dy = measurement.y - this.x[1];
    // Gate on the joint position innovation to reject GNSS jumps.
    const sxx = this.P[idx(0, 0)] + variance;
    const syy = this.P[idx(1, 1)] + variance;
    const sxy = this.P[idx(0, 1)];
    const determinant = sxx * syy - sxy * sxy;
    const chi2 = determinant > 0 ? (dx * dx * syy - 2 * dx * dy * sxy + dy * dy * sxx) / determinant : 0;
    if (chi2 > GATE_CHI2 && this.rejections < MAX_REJECTIONS) {
      this.rejections += 1;
      return { accepted: false };
    }
    if (chi2 > GATE_CHI2) {
      // Persistent disagreement: the filter is lost, start over from GNSS.
      this.start(measurement.t, measurement, measurement.speed, measurement.accuracy);
      this.rejections = 0;
      return { accepted: true, reset: true };
    }
    this.rejections = 0;

    this.scalarUpdate(0, dx, variance);
    this.scalarUpdate(1, measurement.y - this.x[1], variance);
    if (Number.isFinite(measurement.speed)) {
      this.scalarUpdate(2, measurement.speed - this.x[2], 0.3 ** 2);
    }

    const moving = Number.isFinite(measurement.speed) && measurement.speed > HEADING_INIT_SPEED;
    if (!this.headingReady) {
      if (moving && measurement.chi != null) {
        const previous = this.previousMovingCourse;
        if (previous != null && Math.abs(wrapRadians(measurement.chi - previous)) < HEADING_INIT_AGREEMENT) {
          this.x[3] = measurement.chi;
          for (let i = 0; i < N; i += 1) {
            this.P[idx(3, i)] = 0;
            this.P[idx(i, 3)] = 0;
          }
          this.P[idx(3, 3)] = 0.1 ** 2;
          this.headingReady = true;
        }
        this.previousMovingCourse = measurement.chi;
      } else {
        this.previousMovingCourse = null;
      }
    } else if (measurement.chi != null && measurement.speed > COURSE_UPDATE_SPEED) {
      const courseSigma = toRadians(2) + 1 / measurement.speed;
      this.scalarUpdate(3, wrapRadians(measurement.chi - this.x[3]), courseSigma * courseSigma);
    }
    return { accepted: true, reset: false };
  }

  state() {
    return {
      x: this.x[0],
      y: this.x[1],
      v: this.x[2],
      chi: this.x[3],
      accelBias: this.x[4],
      yawBias: this.x[5],
      headingReady: this.headingReady,
    };
  }
}

function vehicleInputs(sample) {
  if (!sample) return { accel: null, yaw: null, lateral: null };
  return {
    accel: Number.isFinite(sample.longG) ? sample.longG * GRAVITY : null,
    yaw: Number.isFinite(sample.yawRate) ? sample.yawRate : null,
    lateral: Number.isFinite(sample.latG) ? -sample.latG * GRAVITY : null,
  };
}

// Live use: feed vehicle-frame IMU samples as they arrive and GNSS fixes when they arrive
// (they are slightly in the past; the measurement is moved forward by the delivery latency).
export class LiveNavigator {
  constructor() {
    this.filter = new NavFilter();
    this.reset();
  }

  reset() {
    this.filter.reset();
    this.projector = null;
    this.lastSlip = null;
    this.slipRate = 0;
  }

  // betaDegrees: current slip angle (left positive) from the drift estimator, or null.
  ingestImu(t, projection, betaDegrees = null) {
    if (!this.filter.initialized) return;
    this.filter.predict(t);
    const beta = Number.isFinite(betaDegrees) ? (betaDegrees * Math.PI) / 180 : 0;
    if (this.lastSlip && t > this.lastSlip.t) {
      const rate = (beta - this.lastSlip.beta) / ((t - this.lastSlip.t) / 1000);
      this.slipRate += 0.3 * (rate - this.slipRate);
    }
    this.lastSlip = { t, beta };
    const input = projection?.forwardReady
      ? vehicleInputs(projection)
      : { accel: null, yaw: projection?.yawRate ?? null, lateral: null };
    if (projection?.forwardReady && beta) {
      // Rotate into the direction of travel while sliding.
      const aForward = input.accel;
      const aLeft = input.lateral;
      input.accel = aForward * Math.cos(beta) - aLeft * Math.sin(beta);
    }
    if (Number.isFinite(input.yaw)) input.yaw -= this.slipRate;
    this.filter.setInput(input);
  }

  ingestFix(fix, now) {
    if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return;
    this.projector ??= makeProjector(fix);
    const position = this.projector.toXY(fix);
    const filter = this.filter;
    if (filter.initialized) filter.predict(now);
    const latency = filter.initialized ? Math.min(Math.max((now - fix.t) / 1000, 0), 1.5) : 0;
    const state = filter.state();
    const chi = courseToChi(fix.heading);
    const forward = state.headingReady ? state.v * latency : 0;
    filter.update({
      t: now,
      x: position.x + forward * Math.cos(state.chi),
      y: position.y + forward * Math.sin(state.chi),
      speed: Number.isFinite(fix.speed) ? fix.speed + (filter.input.accel ?? 0) * latency : null,
      chi: chi == null ? null : wrapRadians(chi + (filter.input.yaw ?? 0) * latency),
      accuracy: fix.accuracy,
    });
  }

  // Current fused estimate, propagated to `now` without committing the prediction.
  estimate(now) {
    const filter = this.filter;
    if (!filter.initialized || !this.projector) return null;
    const state = filter.state();
    const dt = Math.min(Math.max((now - filter.t) / 1000, 0), 1);
    const a = Number.isFinite(filter.input.accel) ? filter.input.accel - state.accelBias : 0;
    const v = Math.max(0, state.v + a * dt);
    let { x, y } = state;
    if (state.headingReady) {
      x += v * dt * Math.cos(state.chi);
      y += v * dt * Math.sin(state.chi);
    }
    const position = this.projector.toLatLon({ x, y });
    return {
      lat: position.lat,
      lon: position.lon,
      speed: v,
      course: state.headingReady ? ((90 - (state.chi * 180) / Math.PI) % 360 + 360) % 360 : null,
      headingReady: state.headingReady,
    };
  }
}

// Post-run: forward EKF at a fixed step plus every fix, then a Rauch-Tung-Striebel backward
// pass so each output sample uses both past and future data. Returns rows at `stepMs`.
export function smoothTrajectory(fixes, vehicle, { stepMs = 100 } = {}) {
  if (fixes.length < 2) return [];
  const projector = makeProjector(fixes[0]);
  const measurements = fixes.map((fix) => ({
    t: fix.t,
    ...projector.toXY(fix),
    speed: fix.speed,
    chi: courseToChi(fix.heading),
    accuracy: fix.accuracy,
  }));

  const tStart = measurements[0].t;
  const tEnd = measurements[measurements.length - 1].t;
  const steps = Math.floor((tEnd - tStart) / stepMs) + measurements.length + 2;
  const xf = new Float64Array(steps * N);
  const xp = new Float64Array(steps * N);
  const Pf = new Float64Array(steps * N * N);
  const Pp = new Float64Array(steps * N * N);
  const Fs = new Float64Array(steps * N * N);
  const segmentStart = new Uint8Array(steps);
  const gridIndex = [];
  const filter = new NavFilter();
  let count = 0;
  let vehicleIndex = 0;
  let measurementIndex = 0;
  let headingWasReady = false;

  const record = (F, segmentBoundary) => {
    xp.set(filter.x, count * N);
    Pp.set(filter.P, count * N * N);
    Fs.set(F, count * N * N);
    segmentStart[count] = segmentBoundary ? 1 : 0;
  };
  const commit = () => {
    xf.set(filter.x, count * N);
    Pf.set(filter.P, count * N * N);
    count += 1;
  };

  for (let t = tStart; t <= tEnd + 1e-6; t += stepMs) {
    // Average the vehicle channels over this step as the zero-order-hold input.
    let longSum = 0;
    let latSum = 0;
    let yawSum = 0;
    let gCount = 0;
    let yawCount = 0;
    while (vehicleIndex < vehicle.length && vehicle[vehicleIndex].t < t) vehicleIndex += 1;
    for (let index = vehicleIndex; index < vehicle.length && vehicle[index].t < t + stepMs; index += 1) {
      const sample = vehicle[index];
      if (Number.isFinite(sample.longG)) {
        longSum += Number.isFinite(sample.travelAccel) ? sample.travelAccel / GRAVITY : sample.longG;
        latSum += sample.latG;
        gCount += 1;
      }
      const rate = Number.isFinite(sample.courseRate) ? sample.courseRate : sample.yawRate;
      if (Number.isFinite(rate)) {
        yawSum += rate;
        yawCount += 1;
      }
    }
    const input = {
      accel: gCount ? (longSum / gCount) * GRAVITY : null,
      yaw: yawCount ? yawSum / yawCount : null,
      lateral: gCount ? -(latSum / gCount) * GRAVITY : null,
    };

    while (measurementIndex < measurements.length && measurements[measurementIndex].t <= t) {
      const measurement = measurements[measurementIndex];
      const F = filter.predict(measurement.t);
      const startsBefore = filter.resetCount;
      record(F, false);
      filter.update(measurement);
      const reset = filter.resetCount !== startsBefore;
      // A heading initialisation or reset breaks the transition model: smooth segments separately.
      if (reset || (filter.headingReady && !headingWasReady)) segmentStart[count] = 1;
      headingWasReady = filter.headingReady;
      commit();
      measurementIndex += 1;
    }
    record(filter.predict(t), false);
    commit();
    gridIndex.push({ t, index: count - 1 });
    filter.setInput(input);
  }

  // Backward pass.
  const xs = Float64Array.from(xf.subarray(0, count * N));
  for (let k = count - 2; k >= 0; k -= 1) {
    if (segmentStart[k + 1]) continue;
    const F = Fs.subarray((k + 1) * N * N, (k + 2) * N * N);
    const predictedInverse = invert(Pp.subarray((k + 1) * N * N, (k + 2) * N * N));
    if (!predictedInverse) continue;
    const gain = multiply(multiply(Pf.subarray(k * N * N, (k + 1) * N * N), transpose(F)), predictedInverse);
    const difference = new Float64Array(N);
    for (let i = 0; i < N; i += 1) difference[i] = xs[(k + 1) * N + i] - xp[(k + 1) * N + i];
    difference[3] = wrapRadians(difference[3]);
    for (let i = 0; i < N; i += 1) {
      let correction = 0;
      for (let j = 0; j < N; j += 1) correction += gain[idx(i, j)] * difference[j];
      xs[k * N + i] = xf[k * N + i] + correction;
    }
    xs[k * N + 2] = Math.max(0, xs[k * N + 2]);
    xs[k * N + 3] = wrapRadians(xs[k * N + 3]);
  }

  return gridIndex.map(({ t, index }) => {
    const base = index * N;
    const position = projector.toLatLon({ x: xs[base], y: xs[base + 1] });
    return { t, lat: position.lat, lon: position.lon, v: xs[base + 2], chi: xs[base + 3] };
  });
}
