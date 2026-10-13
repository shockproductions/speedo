// Live drag timing from the fused speed: stage (stand still), launch, then 0-target speed,
// 1/8 mile and 1/4 mile with trap speed.

const STAGE_SPEED = 0.5;
const STAGE_HOLD_MS = 1000;
const LAUNCH_SPEED = 0.8;
const EIGHTH_MILE = 201.168;
const QUARTER_MILE = 402.336;

export class DragTimer {
  constructor({ onEvent } = {}) {
    this.onEvent = onEvent;
    this.best = { target: null, quarter: null };
    this.reset();
  }

  reset() {
    this.state = "waiting";
    this.stillSince = null;
    this.launchT = null;
    this.lastT = null;
    this.lastSpeed = 0;
    this.distance = 0;
    this.result = { target: null, eighth: null, quarter: null, trapKmh: null };
  }

  // targetMps: 100 km/h or 60 mph depending on units.
  ingest(t, speed, targetMps) {
    if (!Number.isFinite(speed)) return;
    const dt = this.lastT != null ? Math.min(Math.max((t - this.lastT) / 1000, 0), 0.5) : 0;
    const previousSpeed = this.lastSpeed;
    this.lastT = t;
    this.lastSpeed = speed;

    if (this.state === "waiting" || this.state === "done" || this.state === "staged") {
      if (speed < STAGE_SPEED) {
        this.stillSince ??= t;
        if (this.state !== "staged" && t - this.stillSince >= STAGE_HOLD_MS) {
          this.state = "staged";
          this.result = { target: null, eighth: null, quarter: null, trapKmh: null };
          this.onEvent?.({ type: "staged" });
        }
      } else {
        this.stillSince = null;
        if (this.state === "staged" && speed >= LAUNCH_SPEED) {
          this.state = "running";
          // Back-date the launch to when speed left zero, assuming constant acceleration.
          const acceleration = dt > 0 ? (speed - previousSpeed) / dt : 0;
          this.launchT = acceleration > 0.1 ? t - (speed / acceleration) * 1000 : t;
          this.distance = (speed * (t - this.launchT)) / 2000;
          this.onEvent?.({ type: "launch" });
        } else if (this.state === "staged") {
          this.state = "waiting";
        }
      }
      return;
    }

    // running
    const before = this.distance;
    this.distance += ((speed + previousSpeed) / 2) * dt;
    const elapsed = (t - this.launchT) / 1000;
    if (this.result.target == null && previousSpeed < targetMps && speed >= targetMps) {
      const fraction = (targetMps - previousSpeed) / (speed - previousSpeed || 1);
      this.result.target = elapsed - dt * (1 - fraction);
      this.onEvent?.({ type: "target", time: this.result.target });
    }
    const crossed = (mark) => before < mark && this.distance >= mark;
    const crossingTime = (mark) => elapsed - dt * ((this.distance - mark) / (this.distance - before || 1));
    if (this.result.eighth == null && crossed(EIGHTH_MILE)) {
      this.result.eighth = crossingTime(EIGHTH_MILE);
    }
    if (this.result.quarter == null && crossed(QUARTER_MILE)) {
      this.result.quarter = crossingTime(QUARTER_MILE);
      this.result.trapKmh = speed * 3.6;
      this.finish();
      return;
    }
    if (speed < STAGE_SPEED) {
      this.finish();
    }
  }

  finish() {
    this.state = "done";
    this.stillSince = null;
    const { target, quarter } = this.result;
    if (target != null && (this.best.target == null || target < this.best.target)) this.best.target = target;
    if (quarter != null && (this.best.quarter == null || quarter < this.best.quarter)) this.best.quarter = quarter;
    this.onEvent?.({ type: "finish", result: { ...this.result } });
  }

  elapsed(t) {
    return this.state === "running" && this.launchT != null ? (t - this.launchT) / 1000 : null;
  }
}
