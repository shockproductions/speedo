export class LightMotionFilter {
  constructor(alpha = 0.2) {
    this.alpha = alpha;
    this.reset();
  }

  reset() {
    this.state = null;
  }

  process(sample) {
    if (!sample) {
      return sample;
    }

    const next = { ...sample };
    const keys = [
      "accelX",
      "accelY",
      "accelZ",
      "rawAccelX",
      "rawAccelY",
      "rawAccelZ",
      "linearAccelX",
      "linearAccelY",
      "linearAccelZ",
      "gyroX",
      "gyroY",
      "gyroZ",
    ];

    if (!this.state) {
      this.state = {};
      for (const key of keys) {
        this.state[key] = Number.isFinite(sample[key]) ? sample[key] : null;
      }
      return next;
    }

    for (const key of keys) {
      const value = sample[key];
      if (!Number.isFinite(value)) {
        next[key] = value;
        continue;
      }

      const previous = Number.isFinite(this.state[key]) ? this.state[key] : value;
      const filtered = previous + this.alpha * (value - previous);
      this.state[key] = filtered;
      next[key] = filtered;
    }

    return next;
  }
}
