function buildRunId() {
  return `run-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeLimit(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// Records two independent streams: every GNSS fix (never rate-limited, lap timing depends on
// them) and device-frame IMU samples (rate-limited by the logging cap).
export class RunRecorder {
  constructor({ onSampleCount } = {}) {
    this.onSampleCount = onSampleCount;
    this.reset();
  }

  reset() {
    this.run = null;
    this.sampleIntervalMs = 0;
    this.lastImuAt = 0;
    this.pending = { gnss: [], imu: [] };
  }

  start(options = {}, preRoll = null) {
    const now = performance.timeOrigin + performance.now();
    const sampleRateHz = normalizeLimit(options.sampleRateHz);
    this.run = {
      id: buildRunId(),
      version: 2,
      status: "recording",
      date: new Date().toISOString(),
      startedAt: now,
      duration: 0,
      mode: options.mode ?? "track",
      trackId: options.trackId ?? null,
      config: {
        sampleRateHz,
        maxDurationSeconds: normalizeLimit(options.maxDurationSeconds),
        lapMinSeconds: normalizeLimit(options.lapMinSeconds) || 10,
      },
      calibration: null,
      gnss: [],
      imu: [],
    };
    this.sampleIntervalMs = sampleRateHz > 0 ? 1000 / sampleRateHz : 0;
    this.lastImuAt = 0;
    this.pending = { gnss: [], imu: [] };

    if (preRoll) {
      for (const fix of preRoll.gnss) this.pushGnss(fix);
      for (const sample of preRoll.imu) this.pushImu(sample);
      const firstT = Math.min(preRoll.gnss[0]?.t ?? now, preRoll.imu[0]?.t ?? now);
      this.run.startedAt = Math.min(now, firstT);
    }
    this.onSampleCount?.(this.sampleCount());
    return this.run;
  }

  isRecording() {
    return Boolean(this.run);
  }

  sampleCount() {
    return this.run ? this.run.gnss.length + this.run.imu.length : 0;
  }

  ingestLocation(fix) {
    if (!this.run) return;
    this.pushGnss(fix);
    this.onSampleCount?.(this.sampleCount());
  }

  ingestMotion(sample) {
    if (!this.run) return;
    if (this.sampleIntervalMs > 0 && this.lastImuAt > 0 && sample.t - this.lastImuAt < this.sampleIntervalMs) {
      return;
    }
    this.pushImu(sample);
    this.onSampleCount?.(this.sampleCount());
  }

  pushGnss(fix) {
    const record = {
      t: fix.t,
      arrival: fix.arrival ?? fix.t,
      fixTime: fix.fixTime ?? null,
      lat: fix.lat,
      lon: fix.lon,
      altitude: fix.altitude ?? null,
      speed: fix.speed ?? null,
      heading: fix.heading ?? null,
      accuracy: fix.accuracy ?? null,
    };
    this.run.gnss.push(record);
    this.pending.gnss.push(record);
  }

  pushImu(sample) {
    const record = {
      t: sample.t,
      ax: sample.ax,
      ay: sample.ay,
      az: sample.az,
      gx: sample.gx ?? null,
      gy: sample.gy ?? null,
      gz: sample.gz ?? null,
    };
    this.run.imu.push(record);
    this.pending.imu.push(record);
    this.lastImuAt = sample.t;
  }

  // Samples recorded since the last call, for incremental persistence.
  takePending() {
    const chunk = this.pending;
    this.pending = { gnss: [], imu: [] };
    return chunk;
  }

  header() {
    return this.run ? { ...this.run, gnss: [], imu: [] } : null;
  }

  stop(calibration) {
    if (!this.run) return null;
    const stoppedAt = performance.timeOrigin + performance.now();
    this.run.duration = stoppedAt - this.run.startedAt;
    this.run.status = "complete";
    this.run.calibration = calibration ?? null;
    const finished = this.run;
    this.reset();
    return finished;
  }
}
