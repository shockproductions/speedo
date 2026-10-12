// Drift angle = where the car points (integrated gyro yaw) minus where it travels (GNSS course).
// The gyro heading has an arbitrary offset, so it is re-aligned to the GNSS course whenever the
// car drives straight with low yaw rate. Positive angles are left-hand drifts (nose pointing left
// of the direction of travel).

import { toDegrees, toRadians, wrapRadians } from "./geo.js";

const HISTORY_MS = 4000;
const MIN_SPEED_MPS = 5;
const STRAIGHT_YAW_RATE = 0.05;
const STRAIGHT_WINDOW_MS = 1000;
const ALIGN_GAIN = 0.3;
const FIX_GAIN = 0.5;
const GRAVITY = 9.80665;

export const DRIFT_ENTER_DEGREES = 12;
export const DRIFT_EXIT_DEGREES = 8;
export const DRIFT_MIN_SPEED_KMH = 15;
const ENTER_HOLD_MS = 300;
const EXIT_HOLD_MS = 400;
const CHAIN_GAP_MS = 800;

export class DriftEstimator {
  constructor() {
    this.reset();
  }

  reset() {
    this.psi = 0;
    this.beta = null;
    this.speed = null;
    this.lastYawT = 0;
    this.history = [];
    this.offset = null;
  }

  // Between fixes the slip angle is propagated kinematically: beta' = yawRate - courseRate, where
  // the course rate is the acceleration perpendicular to the velocity divided by speed.
  ingestImu(t, { yawRate, longG, latG }) {
    if (!Number.isFinite(yawRate)) {
      return;
    }
    const dt = this.lastYawT ? Math.min(Math.max((t - this.lastYawT) / 1000, 0), 0.2) : 0;
    this.lastYawT = t;
    this.psi += yawRate * dt;

    if (this.beta != null && Number.isFinite(this.speed) && this.speed >= MIN_SPEED_MPS) {
      const hasAccel = Number.isFinite(longG) && Number.isFinite(latG);
      let courseRate = yawRate;
      if (hasAccel) {
        const aForward = longG * GRAVITY;
        const aLeft = -latG * GRAVITY;
        const aPerpendicular = aForward * Math.sin(this.beta) + aLeft * Math.cos(this.beta);
        courseRate = aPerpendicular / this.speed;
        this.speed = Math.max(0, this.speed + aForward * Math.cos(this.beta) * dt);
      }
      this.beta = wrapRadians(this.beta + (yawRate - courseRate) * dt);
    }

    this.history.push({ t, psi: this.psi, yawRate, beta: this.beta });
    while (this.history.length && t - this.history[0].t > HISTORY_MS) {
      this.history.shift();
    }
  }

  historyAt(t, key) {
    const history = this.history;
    if (!history.length) {
      return null;
    }
    const valueOf = (item) => item[key];
    if (t <= history[0].t) return valueOf(history[0]);
    const last = history[history.length - 1];
    if (t >= last.t) return valueOf(last);
    for (let index = history.length - 1; index > 0; index -= 1) {
      const previous = history[index - 1];
      if (previous.t <= t) {
        const current = history[index];
        const a = valueOf(previous);
        const b = valueOf(current);
        if (a == null || b == null) return b ?? a;
        const fraction = (t - previous.t) / (current.t - previous.t || 1);
        return a + wrapRadians(b - a) * fraction;
      }
    }
    return valueOf(history[0]);
  }

  meanYawRate(fromT, toT) {
    let total = 0;
    let count = 0;
    for (const item of this.history) {
      if (item.t >= fromT && item.t <= toT) {
        total += Math.abs(item.yawRate);
        count += 1;
      }
    }
    return count ? total / count : null;
  }

  // course: degrees clockwise from north. Corrects the propagated slip angle with the measured
  // difference between gyro heading and GNSS course at the fix time.
  ingestFix(t, speed, course) {
    const theta = Number.isFinite(course) ? -toRadians(course) : null;
    const psi = this.historyAt(t, "psi");
    this.speed = Number.isFinite(speed) ? speed : this.speed;

    if (psi == null || theta == null || !Number.isFinite(speed) || speed < MIN_SPEED_MPS) {
      this.beta = null;
      return null;
    }

    const meanYaw = this.meanYawRate(t - STRAIGHT_WINDOW_MS, t);
    if (meanYaw != null && meanYaw < STRAIGHT_YAW_RATE && speed > MIN_SPEED_MPS + 1) {
      const target = wrapRadians(theta - psi);
      this.offset = this.offset == null
        ? target
        : wrapRadians(this.offset + ALIGN_GAIN * wrapRadians(target - this.offset));
    }
    if (this.offset == null) {
      return null;
    }

    const measured = wrapRadians(psi + this.offset - theta);
    if (this.beta == null) {
      this.beta = measured;
    } else {
      const atFix = this.historyAt(t, "beta") ?? this.beta;
      this.beta = wrapRadians(this.beta + FIX_GAIN * wrapRadians(measured - atFix));
    }
    return this.currentBeta();
  }

  currentBeta() {
    if (this.beta == null) {
      return null;
    }
    const degrees = toDegrees(this.beta);
    return Math.abs(degrees) > 90 ? null : degrees;
  }
}

// Points accrue with angle x speed x time. Transitions (direction changes inside one chain)
// add a 10% bonus each.
export function driftPoints(absAngle, speedKmh, dtSeconds) {
  return (absAngle * speedKmh * dtSeconds) / 100;
}

export class DriftSegmenter {
  constructor({ onChainEnd } = {}) {
    this.onChainEnd = onChainEnd;
    this.reset();
  }

  reset() {
    this.chains = [];
    this.active = null;
    this.drifting = false;
    this.pendingSince = 0;
    this.exitSince = 0;
    this.lastT = 0;
    this.lastDriftT = 0;
  }

  ingest(t, beta, speedKmh) {
    const dt = this.lastT ? Math.min(Math.max((t - this.lastT) / 1000, 0), 0.5) : 0;
    this.lastT = t;
    const angle = Number.isFinite(beta) ? Math.abs(beta) : 0;
    const fastEnough = Number.isFinite(speedKmh) && speedKmh >= DRIFT_MIN_SPEED_KMH;

    if (!this.drifting) {
      if (fastEnough && angle >= DRIFT_ENTER_DEGREES) {
        this.pendingSince ||= t;
        if (t - this.pendingSince >= ENTER_HOLD_MS) {
          this.drifting = true;
          this.exitSince = 0;
          this.beginOrContinueChain(this.pendingSince, beta);
        }
      } else {
        this.pendingSince = 0;
        if (this.active && t - this.lastDriftT > CHAIN_GAP_MS) {
          this.finishChain();
        }
      }
    } else if (!fastEnough || angle < DRIFT_EXIT_DEGREES) {
      this.exitSince ||= t;
      if (t - this.exitSince >= EXIT_HOLD_MS) {
        this.drifting = false;
        this.pendingSince = 0;
      }
    } else {
      this.exitSince = 0;
    }

    if (this.drifting && this.active && Number.isFinite(beta)) {
      const chain = this.active;
      const direction = Math.sign(beta);
      if (angle >= DRIFT_ENTER_DEGREES && direction && direction !== chain.lastDirection) {
        if (chain.lastDirection) chain.transitions += 1;
        chain.lastDirection = direction;
      }
      chain.end = t;
      chain.angleTime += angle * dt;
      chain.speedTime += (speedKmh ?? 0) * dt;
      chain.driftSeconds += dt;
      chain.peakAngle = Math.max(chain.peakAngle, angle);
      chain.basePoints += driftPoints(angle, speedKmh ?? 0, dt);
      this.lastDriftT = t;
    }

    return this.active ? this.describe(this.active) : null;
  }

  beginOrContinueChain(t, beta) {
    if (this.active) {
      return;
    }
    this.active = {
      start: t,
      end: t,
      direction: Math.sign(beta) > 0 ? "L" : "R",
      lastDirection: 0,
      transitions: 0,
      angleTime: 0,
      speedTime: 0,
      driftSeconds: 0,
      peakAngle: 0,
      basePoints: 0,
    };
  }

  finishChain() {
    const chain = this.describe(this.active);
    this.active = null;
    if (chain.duration >= 0.5) {
      this.chains.push(chain);
      this.onChainEnd?.(chain);
    }
  }

  flush() {
    if (this.active) {
      this.finishChain();
    }
    return this.chains;
  }

  describe(chain) {
    const seconds = chain.driftSeconds || 0;
    return {
      start: chain.start,
      end: chain.end,
      duration: (chain.end - chain.start) / 1000,
      direction: chain.direction,
      transitions: chain.transitions,
      peakAngle: chain.peakAngle,
      averageAngle: seconds ? chain.angleTime / seconds : 0,
      averageSpeedKmh: seconds ? chain.speedTime / seconds : 0,
      score: Math.round(chain.basePoints * (1 + 0.1 * chain.transitions)),
    };
  }
}
