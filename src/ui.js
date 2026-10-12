import {
  analyzeRun,
  formatDelta,
  formatDuration,
  formatLapTime,
  needsReanalysis,
} from "./analysis.js";
import { Announcer, DriftTone } from "./audio.js";
import { DriftEstimator, DriftSegmenter } from "./drift.js";
import { runToCsv, runToGpx, runToVbo } from "./exporters.js";
import { LightMotionFilter } from "./filters.js";
import { IMUView } from "./imuview.js";
import { createGate, lapTrace, LiveLapTimer, nearestTrack } from "./laptiming.js";
import { LiveHud } from "./livehud.js";
import { courseOf, GRAVITY, MountCalibration } from "./orientation.js";
import { RunRecorder } from "./recorder.js";
import { escapeHtml, RunView } from "./runview.js";
import { SensorManager } from "./sensors.js";
import {
  formatSpeed,
  loadCalibration,
  loadSettings,
  saveCalibration,
  saveSettings,
  speedFactor,
  speedUnit,
} from "./settings.js";
import { RunStorage } from "./storage.js";

const PRE_ROLL_MS = 5000;
const CHUNK_FLUSH_MS = 5000;
const HUD_TICK_MS = 100;
const DRIFT_SAMPLE_MS = 100;
const STANDING_SPEED = 1.5;

function downloadBlob(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function parseNumber(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value || value === "-") return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

const now = () => performance.timeOrigin + performance.now();

export class TelemetryUI {
  constructor() {
    this.settings = loadSettings();
    this.storage = new RunStorage();
    this.calibration = new MountCalibration({ onEvent: (event) => this.handleCalibrationEvent(event) });
    this.calibration.restore(loadCalibration());
    this.motionFilter = new LightMotionFilter(0.18);
    this.recorder = new RunRecorder({
      onSampleCount: (count) => {
        this.sampleCountDirty = count;
      },
    });
    this.sensors = new SensorManager({
      onLocation: (payload) => this.handleLocation(payload),
      onMotion: (payload) => this.handleMotion(payload),
      onStatus: (type, message) => this.handleSensorStatus(type, message),
    });
    this.lapTimer = new LiveLapTimer({ onEvent: (event) => this.handleLapEvent(event) });
    this.driftEstimator = new DriftEstimator();
    this.driftSegmenter = new DriftSegmenter({ onChainEnd: (chain) => this.handleDriftChain(chain) });
    this.announcer = new Announcer();
    this.driftTone = new DriftTone();

    this.deferredPrompt = null;
    this.serviceWorkerRegistration = null;
    this.runs = [];
    this.tracks = [];
    this.selectedRun = null;
    this.currentPage = "recorderPage";
    this.recordingActive = false;
    this.armed = false;
    this.autoStarted = false;
    this.imuStreaming = false;
    this.preRoll = { gnss: [], imu: [] };
    this.lastFix = null;
    this.previousFix = null;
    this.fixArrivals = [];
    this.standingSince = null;
    this.liveTrack = null;
    this.liveSpeedMps = 0;
    this.lastSpeedUpdate = 0;
    this.latestProjection = null;
    this.drawPending = false;
    this.lastDriftSample = 0;
    this.driftState = { angle: null, chainScore: null, lastScore: null, bestScore: null };
    this.chunkSeq = 0;
    this.sampleCountDirty = null;
    this.timers = {};
    this.wakeLock = null;
  }

  async init() {
    this.cacheElements();
    this.hud = new LiveHud(this.livePanel);
    this.imuView = new IMUView(this.imuMount);
    this.runView = new RunView(this.runDetails, {
      getUnits: () => this.settings.units,
      getTracks: () => this.tracks,
      assignTrack: (run, value) => this.assignTrack(run, value),
      saveTrackForRun: (run, draft) => this.saveTrackForRun(run, draft),
      updateTrack: (run, patch) => this.updateTrackFromRun(run, patch),
    });
    this.applySettingsToInputs();
    this.bindEvents();
    this.registerPwa();
    this.hud.drawG(null, now());
    this.hud.resetTiming();
    this.refreshCalibrationStatus();
    this.timers.hud = window.setInterval(() => this.tickHud(), HUD_TICK_MS);

    await this.enableMotionWithoutPrompt();
    this.syncSensors();
    await this.refreshTracks();
    await this.recoverInterruptedRuns();
    await this.refreshRuns();
  }

  cacheElements() {
    const byId = (id) => document.getElementById(id);
    this.livePanel = byId("livePanel");
    this.liveSpeed = byId("liveSpeed");
    this.speedUnitLabel = byId("speedUnit");
    this.startButton = byId("startButton");
    this.stopButton = byId("stopButton");
    this.armButton = byId("armButton");
    this.markStartFinishButton = byId("markStartFinishButton");
    this.recordingState = byId("recordingState");
    this.locationStatus = byId("locationStatus");
    this.motionStatus = byId("motionStatus");
    this.liveTrackName = byId("liveTrackName");
    this.permissionMessage = byId("permissionMessage");
    this.sampleCount = byId("sampleCount");
    this.elapsedValue = byId("elapsedValue");
    this.runList = byId("runList");
    this.runSummaryBar = byId("runSummaryBar");
    this.runDetails = byId("runDetails");
    this.detailTitle = byId("detailTitle");
    this.exportButtons = {
      json: byId("exportJsonButton"),
      csv: byId("exportCsvButton"),
      gpx: byId("exportGpxButton"),
      vbo: byId("exportVboButton"),
    };
    this.deleteRunButton = byId("deleteRunButton");
    this.checkUpdatesButton = byId("checkUpdatesButton");
    this.updateStatusMessage = byId("updateStatusMessage");
    this.installButton = byId("installButton");
    this.inputs = {
      sampleRateHz: byId("sampleRateInput"),
      maxDurationSeconds: byId("maxDurationInput"),
      lapMinSeconds: byId("lapMinTimeInput"),
      autoStartKmh: byId("autoStartInput"),
      autoStopSeconds: byId("autoStopInput"),
    };
    this.unitsSelect = byId("unitsSelect");
    this.voiceToggle = byId("voiceToggle");
    this.driftToneToggle = byId("driftToneToggle");
    this.trackSelect = byId("trackSelect");
    this.deleteTrackButton = byId("deleteTrackButton");
    this.calibrationGravity = byId("calibrationGravity");
    this.calibrationForward = byId("calibrationForward");
    this.calibrationGyro = byId("calibrationGyro");
    this.captureMountButton = byId("captureMountButton");
    this.resetCalibrationButton = byId("resetCalibrationButton");
    this.skipCalibrationButton = byId("skipCalibrationButton");
    this.enableImuButton = byId("enableImuButton");
    this.disableImuButton = byId("disableImuButton");
    this.imuMount = byId("imuMount");
    this.modeButtons = [...document.querySelectorAll(".mode-button")];
    this.pages = [...document.querySelectorAll(".page")];
    this.tabButtons = [...document.querySelectorAll(".tab-button")];
  }

  // ---------- settings ----------

  applySettingsToInputs() {
    for (const [key, input] of Object.entries(this.inputs)) {
      input.value = String(this.settings[key] ?? 0);
    }
    this.unitsSelect.value = this.settings.units;
    this.voiceToggle.checked = this.settings.voice;
    this.driftToneToggle.checked = this.settings.driftTone;
    this.announcer.enabled = this.settings.voice;
    this.driftTone.enabled = this.settings.driftTone;
    this.setMode(this.settings.mode);
    this.speedUnitLabel.textContent = speedUnit(this.settings.units);
  }

  readSettingsFromInputs() {
    for (const [key, input] of Object.entries(this.inputs)) {
      this.settings[key] = parseNumber(input.value);
    }
    this.settings.lapMinSeconds ||= 10;
    this.settings.units = this.unitsSelect.value;
    this.settings.voice = this.voiceToggle.checked;
    this.settings.driftTone = this.driftToneToggle.checked;
    this.announcer.enabled = this.settings.voice;
    this.driftTone.enabled = this.settings.driftTone;
    this.speedUnitLabel.textContent = speedUnit(this.settings.units);
    saveSettings(this.settings);
  }

  setMode(mode) {
    this.settings.mode = mode;
    this.hud.setMode(mode);
    for (const button of this.modeButtons) {
      button.classList.toggle("active", button.dataset.mode === mode);
    }
    saveSettings(this.settings);
  }

  // ---------- events ----------

  bindEvents() {
    this.startButton.addEventListener("click", () => this.handleStartRun());
    this.stopButton.addEventListener("click", () => this.handleStopRun("manual"));
    this.armButton.addEventListener("click", () => this.handleArmToggle());
    this.markStartFinishButton.addEventListener("click", () => this.handleMarkStartFinish());
    this.exportButtons.json.addEventListener("click", () => this.exportRun("json"));
    this.exportButtons.csv.addEventListener("click", () => this.exportRun("csv"));
    this.exportButtons.gpx.addEventListener("click", () => this.exportRun("gpx"));
    this.exportButtons.vbo.addEventListener("click", () => this.exportRun("vbo"));
    this.deleteRunButton.addEventListener("click", () => this.handleDeleteRun());
    this.checkUpdatesButton.addEventListener("click", () => this.handleCheckForUpdates());
    for (const input of Object.values(this.inputs)) {
      input.addEventListener("change", () => this.readSettingsFromInputs());
    }
    this.unitsSelect.addEventListener("change", () => {
      this.readSettingsFromInputs();
      if (this.selectedRun) this.renderRunDetails(this.selectedRun, { keepSelection: true });
      this.renderRunList();
    });
    this.voiceToggle.addEventListener("change", () => this.readSettingsFromInputs());
    this.driftToneToggle.addEventListener("change", () => {
      this.readSettingsFromInputs();
      this.driftTone.unlock();
    });
    this.trackSelect.addEventListener("change", () => {
      this.settings.trackSelection = this.trackSelect.value;
      saveSettings(this.settings);
      this.deleteTrackButton.disabled = !this.tracks.some((track) => track.id === this.trackSelect.value);
    });
    this.deleteTrackButton.addEventListener("click", () => this.handleDeleteTrack());
    this.captureMountButton.addEventListener("click", () => this.handleCaptureMount());
    this.resetCalibrationButton.addEventListener("click", () => this.handleResetCalibration());
    this.skipCalibrationButton.addEventListener("click", () => this.handleSkipCalibration());
    this.enableImuButton.addEventListener("click", () => this.handleEnableImu());
    this.disableImuButton.addEventListener("click", () => this.handleDisableImu());
    for (const button of this.modeButtons) {
      button.addEventListener("click", () => this.setMode(button.dataset.mode));
    }
    for (const button of this.tabButtons) {
      button.addEventListener("click", () => this.showPage(button.dataset.page));
    }

    this.installButton.addEventListener("click", async () => {
      if (!this.deferredPrompt) return;
      this.deferredPrompt.prompt();
      await this.deferredPrompt.userChoice;
      this.installButton.hidden = true;
      this.deferredPrompt = null;
    });
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      this.deferredPrompt = event;
      this.installButton.hidden = false;
    });
    document.addEventListener("visibilitychange", () => this.handleVisibilityChange());
  }

  showPage(pageId) {
    this.currentPage = pageId;
    for (const page of this.pages) page.classList.toggle("active", page.id === pageId);
    for (const button of this.tabButtons) button.classList.toggle("active", button.dataset.page === pageId);
    this.syncSensors();
  }

  // ---------- PWA ----------

  async registerPwa() {
    if (!("serviceWorker" in navigator)) return;
    try {
      this.serviceWorkerRegistration = await navigator.serviceWorker.register("./sw.js");
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (this.reloadingForUpdate || this.recordingActive) return;
        this.reloadingForUpdate = true;
        window.location.reload();
      });
    } catch (error) {
      console.warn("Service worker registration failed", error);
    }
  }

  async handleCheckForUpdates() {
    if (!this.serviceWorkerRegistration) {
      this.showUpdateStatus("Updates unavailable.");
      return;
    }
    if (this.recordingActive) {
      this.showUpdateStatus("Stop recording before updating.");
      return;
    }
    this.checkUpdatesButton.disabled = true;
    try {
      await this.serviceWorkerRegistration.update();
      const installingWorker = this.serviceWorkerRegistration.installing;
      if (installingWorker) {
        await new Promise((resolve) => {
          installingWorker.addEventListener("statechange", () => {
            if (installingWorker.state === "installed") resolve();
          });
        });
      }
      if (this.serviceWorkerRegistration.waiting) {
        this.showUpdateStatus("Update found. Reloading...");
        this.serviceWorkerRegistration.waiting.postMessage({ type: "SKIP_WAITING" });
        return;
      }
      this.showUpdateStatus("Already up to date.");
    } catch (error) {
      console.warn("Update check failed", error);
      this.showUpdateStatus("Update check failed.");
    } finally {
      this.checkUpdatesButton.disabled = false;
    }
  }

  showUpdateStatus(message, durationMs = 3200) {
    window.clearTimeout(this.timers.updateStatus);
    this.updateStatusMessage.hidden = !message;
    this.updateStatusMessage.textContent = message;
    if (!message) return;
    this.timers.updateStatus = window.setTimeout(() => {
      this.updateStatusMessage.hidden = true;
      this.updateStatusMessage.textContent = "";
    }, durationMs);
  }

  // ---------- sensors ----------

  // Android grants motion without a prompt, so auto-capture can begin as soon as the page opens.
  // iOS needs a tap first; that happens on Start / Arm / Capture.
  async enableMotionWithoutPrompt() {
    if (this.calibration.isSkipped()) return;
    if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission !== "function") {
      await this.sensors.requestPermissions({ location: false, motion: true });
    }
  }

  syncSensors() {
    const live = this.recordingActive || this.armed;
    const motionWanted =
      this.imuStreaming ||
      (!this.calibration.isSkipped() && (live || this.currentPage === "recorderPage"));
    this.sensors.setStreams({
      location: live || this.currentPage === "recorderPage",
      motion: motionWanted,
    });
    this.enableImuButton.disabled = this.imuStreaming;
    this.disableImuButton.disabled = !this.imuStreaming;
  }

  handleSensorStatus(type, message) {
    if (type === "location") {
      if (message !== "Live") this.locationStatus.textContent = message;
    } else if (type === "motion") {
      this.motionStatus.textContent = message;
    } else if (type === "permission") {
      this.showMessage(message);
    }
  }

  handleLocation(fix) {
    this.previousFix = this.lastFix;
    this.lastFix = fix;
    this.fixArrivals.push(fix.arrival);
    if (this.fixArrivals.length > 10) this.fixArrivals.shift();
    this.updateGnssStatus(fix);

    this.calibration.ingestFix(fix);
    if (Number.isFinite(fix.speed)) {
      this.liveSpeedMps = Math.max(0, fix.speed);
      this.lastSpeedUpdate = fix.t;
      this.renderSpeed();
    }

    if (this.recordingActive) {
      this.lapTimer.ingestFix(fix);
      this.driftEstimator.ingestFix(fix.t, fix.speed, courseOf(fix, this.previousFix));
      this.recorder.ingestLocation(fix);
      this.checkAutoStop(fix);
    } else if (this.armed) {
      this.pushPreRoll("gnss", fix);
      if (Number.isFinite(fix.speed) && fix.speed * 3.6 >= (this.settings.autoStartKmh || 30)) {
        this.handleStartRun({ auto: true });
      }
    }
  }

  updateGnssStatus(fix) {
    const arrivals = this.fixArrivals;
    const span = arrivals.length > 1 ? (arrivals[arrivals.length - 1] - arrivals[0]) / 1000 : 0;
    const rate = span > 0 ? (arrivals.length - 1) / span : 0;
    const accuracy = Number.isFinite(fix.accuracy) ? ` ±${Math.round(fix.accuracy)} m` : "";
    this.locationStatus.textContent = `${rate ? `${rate.toFixed(rate < 2 ? 1 : 0)} Hz` : "Live"}${accuracy}`;
  }

  handleMotion(payload) {
    const filtered = this.motionFilter.process(payload);
    const sample = {
      t: filtered.timestamp,
      ax: filtered.rawAccelX ?? filtered.accelX,
      ay: filtered.rawAccelY ?? filtered.accelY,
      az: filtered.rawAccelZ ?? filtered.accelZ,
      gx: filtered.gyroX,
      gy: filtered.gyroY,
      gz: filtered.gyroZ,
    };
    if (filtered.hasAbsoluteAcceleration) {
      this.calibration.ingestMotion(sample);
    }
    const projection = this.calibration.project(sample);
    this.latestProjection = projection;
    this.integrateSpeed(sample.t, projection);

    if (this.recordingActive) {
      this.driftEstimator.ingestImu(sample.t, projection);
      if (sample.t - this.lastDriftSample >= DRIFT_SAMPLE_MS) {
        this.lastDriftSample = sample.t;
        this.updateLiveDrift(sample.t);
      }
      this.recorder.ingestMotion(sample);
    } else if (this.armed) {
      this.pushPreRoll("imu", sample);
    }

    if (this.currentPage === "imuPage") {
      this.imuView.update(filtered);
    }
    if (!this.drawPending) {
      this.drawPending = true;
      requestAnimationFrame(() => {
        this.drawPending = false;
        this.hud.drawG(this.latestProjection, now());
      });
    }
  }

  // Smooth the speed readout between GNSS fixes using calibrated longitudinal acceleration.
  integrateSpeed(t, projection) {
    if (!projection.forwardReady || !this.lastSpeedUpdate || t - this.lastSpeedUpdate > 1500) return;
    const dt = Math.min(Math.max((t - (this.lastIntegration ?? t)) / 1000, 0), 0.1);
    this.lastIntegration = t;
    if (!dt || this.liveSpeedMps < 2) return;
    this.liveSpeedMps = Math.max(0, this.liveSpeedMps + projection.longG * GRAVITY * dt);
  }

  pushPreRoll(stream, item) {
    const buffer = this.preRoll[stream];
    buffer.push(item);
    while (buffer.length && item.t - buffer[0].t > PRE_ROLL_MS) buffer.shift();
  }

  updateLiveDrift(t) {
    const beta = this.driftEstimator.currentBeta();
    const chain = this.driftSegmenter.ingest(t, beta, this.liveSpeedMps * 3.6);
    this.driftState.angle = beta;
    this.driftState.chainScore = chain ? chain.score : null;
    this.driftTone.update(beta, Boolean(chain));
  }

  handleDriftChain(chain) {
    this.driftState.lastScore = chain.score;
    if (this.driftState.bestScore == null || chain.score > this.driftState.bestScore) {
      this.driftState.bestScore = chain.score;
      if (this.settings.mode === "drift") {
        this.hud.flash(`Best drift ${chain.score}`, "good");
        this.announcer.say(`Best drift. ${chain.score}`);
      }
    }
  }

  // ---------- HUD ----------

  tickHud() {
    const t = now();
    if (this.sampleCountDirty != null) {
      this.sampleCount.textContent = String(this.sampleCountDirty);
      this.sampleCountDirty = null;
    }
    if (this.recordingActive && this.recorder.run) {
      this.elapsedValue.textContent = formatDuration(t - this.recorder.run.startedAt);
      this.hud.updateTrack({
        lapSeconds: this.lapTimer.currentLapSeconds(t),
        delta: this.lapTimer.delta,
        lastLap: this.lapTimer.lastLap,
        bestLap: this.lapTimer.bestLap,
        lapNumber: this.lapTimer.lapNumber,
      });
      this.hud.updateDrift(this.driftState);
    }
    this.renderSpeed();
    this.tickCount = (this.tickCount ?? 0) + 1;
    if (this.tickCount % 5 === 0) {
      this.refreshCalibrationStatus();
    }
  }

  renderSpeed() {
    const kmh = this.liveSpeedMps * 3.6 * speedFactor(this.settings.units);
    this.liveSpeed.textContent = Math.round(kmh).toString();
  }

  // ---------- calibration ----------

  handleCalibrationEvent(event) {
    if (event === "captured") {
      this.showMessage("Mount angle locked.", 2500);
    } else if (event === "mount-moved") {
      this.showMessage("Phone mount moved. Recalibrating the forward axis while you drive.");
    } else if (event === "forward-ready") {
      this.showMessage("Forward axis solved from GPS. G-forces are now in the car's frame.", 3500);
    } else if (event === "capture-failed") {
      this.showMessage("Mount capture failed. Keep the phone still and try again.");
    }
    saveCalibration(this.calibration.snapshot());
    this.refreshCalibrationStatus();
  }

  refreshCalibrationStatus() {
    const status = this.calibration.getStatus();
    this.calibrationGravity.textContent = status.capturing ? "Capturing..." : status.gravity;
    this.calibrationForward.textContent = status.forward;
    this.calibrationGyro.textContent = status.gyro;
    this.skipCalibrationButton.textContent = status.skipped ? "Use IMU" : "GPS Only (No IMU)";
    this.captureMountButton.disabled = status.skipped || status.capturing;
    this.hud.setGNote(
      status.skipped
        ? "GPS-only mode"
        : !status.gravityReady
          ? "Waiting for the car to stand still"
          : !status.forwardReady
            ? "Drive to auto-calibrate the forward axis"
            : "",
    );
  }

  async ensureMotionPermission() {
    if (this.calibration.isSkipped()) return true;
    const permissions = await this.sensors.requestPermissions({ location: false, motion: true });
    if (!permissions.ok) {
      this.showMessage(permissions.issues.join(" "));
      return false;
    }
    this.syncSensors();
    return true;
  }

  async handleCaptureMount() {
    if (!(await this.ensureMotionPermission())) return;
    this.motionFilter.reset();
    this.calibration.startManualCapture(1500);
    this.showMessage("Hold still: capturing the mount angle...", 2000);
    this.refreshCalibrationStatus();
  }

  handleResetCalibration() {
    this.calibration.reset();
    saveCalibration(null);
    this.syncSensors();
    this.refreshCalibrationStatus();
    this.showMessage("Calibration cleared. It will re-capture when the car stops and re-solve while you drive.");
  }

  async handleSkipCalibration() {
    if (this.calibration.isSkipped()) {
      this.calibration.reset();
      saveCalibration(null);
      await this.ensureMotionPermission();
    } else {
      this.calibration.skip();
      saveCalibration(this.calibration.snapshot());
      this.showMessage("GPS-only mode. G-forces will be estimated from GPS and drift angle is unavailable.");
    }
    this.syncSensors();
    this.refreshCalibrationStatus();
  }

  async handleEnableImu() {
    const permissions = await this.sensors.requestPermissions({ location: false, motion: true });
    if (!permissions.ok) {
      this.showMessage(permissions.issues.join(" "));
      return;
    }
    this.imuStreaming = true;
    this.showPage("imuPage");
  }

  handleDisableImu() {
    this.imuStreaming = false;
    this.syncSensors();
  }

  // ---------- recording ----------

  selectLiveTrack() {
    const selection = this.settings.trackSelection;
    if (selection === "none") return null;
    if (selection && selection !== "auto") {
      return this.tracks.find((track) => track.id === selection) ?? null;
    }
    return this.lastFix ? nearestTrack(this.tracks, this.lastFix) : null;
  }

  async handleArmToggle() {
    if (this.armed) {
      this.armed = false;
      this.preRoll = { gnss: [], imu: [] };
      this.updateRecordingControls();
      this.syncSensors();
      return;
    }
    const ready = await this.requestRecordingPermissions();
    if (!ready) return;
    this.driftTone.unlock();
    this.armed = true;
    this.preRoll = { gnss: [], imu: [] };
    await this.acquireWakeLock();
    this.updateRecordingControls();
    this.syncSensors();
    this.showMessage(
      `Armed: recording starts above ${this.settings.autoStartKmh || 30} km/h` +
        (this.settings.autoStopSeconds ? ` and stops after ${this.settings.autoStopSeconds} s standing.` : "."),
      4000,
    );
  }

  async requestRecordingPermissions() {
    const permissions = await this.sensors.requestPermissions({
      location: true,
      motion: !this.calibration.isSkipped(),
    });
    if (!permissions.ok) {
      this.showMessage(permissions.issues.join(" "));
      return false;
    }
    return true;
  }

  async handleStartRun({ auto = false } = {}) {
    if (this.recordingActive) return;
    if (!auto) {
      const ready = await this.requestRecordingPermissions();
      if (!ready) return;
      this.driftTone.unlock();
    }
    this.readSettingsFromInputs();
    this.recordingActive = true;
    this.autoStarted = auto;
    this.standingSince = null;

    const selection = this.settings.trackSelection;
    this.liveTrack = this.selectLiveTrack();
    this.lapTimer.configure({
      track: this.liveTrack,
      minLapSeconds: this.settings.lapMinSeconds || 10,
      autoGate: selection !== "none",
      referenceTrace: this.liveTrack?.bestLap?.trace ?? null,
    });
    this.driftEstimator.reset();
    this.driftSegmenter.reset();
    this.driftState = { angle: null, chainScore: null, lastScore: null, bestScore: null };
    this.hud.resetTiming();
    this.liveTrackName.textContent = this.liveTrack?.name ?? (selection === "none" ? "Off" : "Auto");

    const preRoll = auto ? this.preRoll : null;
    this.recorder.start(
      {
        sampleRateHz: this.settings.sampleRateHz,
        maxDurationSeconds: this.settings.maxDurationSeconds,
        lapMinSeconds: this.settings.lapMinSeconds,
        mode: this.settings.mode,
        trackId: selection === "none" ? "none" : this.liveTrack?.id ?? null,
      },
      preRoll,
    );
    if (preRoll) {
      // Replay the buffered fixes so the live timer and drift estimator are not starting blind.
      for (const fix of preRoll.gnss) this.lapTimer.ingestFix(fix);
    }
    this.preRoll = { gnss: [], imu: [] };
    this.chunkSeq = 0;
    await this.storage.saveRun(this.recorder.header());
    this.timers.flush = window.setInterval(() => this.flushChunk(), CHUNK_FLUSH_MS);
    if (this.settings.maxDurationSeconds > 0) {
      this.timers.maxDuration = window.setTimeout(
        () => this.handleStopRun("max-duration"),
        this.settings.maxDurationSeconds * 1000,
      );
    }

    this.requestNotificationPermission();
    await this.acquireWakeLock();
    this.updateRecordingControls();
    this.syncSensors();
    if (auto) {
      this.announcer.say("Recording");
    }
  }

  async flushChunk() {
    if (!this.recorder.isRecording()) return;
    const chunk = this.recorder.takePending();
    if (!chunk.gnss.length && !chunk.imu.length) return;
    try {
      await this.storage.appendChunk(this.recorder.run.id, this.chunkSeq++, chunk);
    } catch (error) {
      console.warn("Chunk save failed", error);
    }
  }

  checkAutoStop(fix) {
    if (!this.autoStarted || !this.settings.autoStopSeconds) return;
    if (Number.isFinite(fix.speed) && fix.speed < STANDING_SPEED) {
      this.standingSince ??= fix.t;
      if (fix.t - this.standingSince >= this.settings.autoStopSeconds * 1000) {
        this.handleStopRun("auto-stop");
      }
    } else {
      this.standingSince = null;
    }
  }

  async handleStopRun(reason = "manual") {
    if (!this.recordingActive) return;
    this.recordingActive = false;
    window.clearInterval(this.timers.flush);
    window.clearTimeout(this.timers.maxDuration);
    this.driftTone.stop();
    const reArm = reason === "auto-stop";
    if (!reArm) {
      this.armed = false;
      await this.releaseWakeLock();
    }
    await this.clearRecordingNotification();

    const run = this.recorder.stop(this.calibration.snapshot());
    saveCalibration(this.calibration.snapshot());
    this.updateRecordingControls();
    this.syncSensors();
    this.elapsedValue.textContent = "0:00";

    if (!run || (!run.gnss.length && !run.imu.length)) {
      if (run) await this.storage.deleteRun(run.id);
      this.showMessage("No telemetry samples were captured.");
      return;
    }

    const analyzed = analyzeRun(run, { tracks: this.tracks });
    await this.storage.saveRun(analyzed);
    await this.storage.deleteChunks(run.id);
    await this.updateTrackBest(analyzed);
    await this.refreshRuns(analyzed.id);

    const { summary } = analyzed.analysis;
    const parts = [
      reason === "auto-stop" ? "Session auto-stopped and saved" : "Session saved",
      summary.lapCount ? `${summary.lapCount} laps, best ${formatLapTime(summary.bestLap)}` : null,
      summary.driftCount ? `${summary.driftCount} drifts, ${summary.driftScore} pts` : null,
      reason === "max-duration" ? "time limit reached" : null,
      reArm ? "re-armed for the next session" : null,
    ].filter(Boolean);
    this.showMessage(`${parts.join(" · ")}.`, 6000);
  }

  updateRecordingControls() {
    const recording = this.recordingActive;
    this.startButton.disabled = recording;
    this.stopButton.disabled = !recording;
    this.armButton.textContent = this.armed ? "Disarm" : "Arm Auto-Start";
    this.armButton.classList.toggle("armed", this.armed);
    this.recordingState.textContent = recording ? "Recording" : this.armed ? "Armed: waiting for speed" : "Ready to record";
    this.recordingState.className = `status-pill ${recording ? "recording" : this.armed ? "armed" : "idle"}`;
  }

  handleLapEvent(event) {
    if (event.type === "lap") {
      const tone = event.isBest ? "good" : "bad";
      const deltaText = event.deltaToBest == null ? "" : event.isBest ? " best" : ` ${formatDelta(event.deltaToBest)}`;
      this.hud.flash(`Lap ${event.number}: ${formatLapTime(event.time)}${deltaText}`, tone);
      if (this.settings.mode !== "drag") this.announcer.announceLap(event);
      navigator.vibrate?.(event.isBest ? [80, 60, 80] : 120);
    } else if (event.type === "auto-gate") {
      this.liveTrackName.textContent = "Auto line";
      this.showMessage("Start/finish line placed automatically. Laps count from here; save it as a track afterwards.", 5000);
      this.announcer.say("Start finish set");
    } else if (event.type === "sector") {
      this.hud.flash(`S${event.sector}: ${event.split.toFixed(2)}`);
    } else if (event.type === "lap-start") {
      this.hud.flash("Lap timing started");
    }
  }

  async handleMarkStartFinish() {
    const fix = this.lastFix;
    if (!fix || now() - fix.arrival > 3000) {
      this.showMessage("No recent GPS fix. Wait for GNSS to go live.");
      return;
    }
    const heading = courseOf(fix, this.previousFix);
    if (heading == null) {
      this.showMessage("Drive through the start/finish line so the direction of travel is known, then tap again.");
      return;
    }
    const gate = createGate(fix, heading);
    let track = this.liveTrack?.id ? this.liveTrack : null;
    if (track) {
      if (!window.confirm(`Move the start/finish line of "${track.name}" here?`)) return;
      track = { ...track, startFinish: gate, bestLap: null };
    } else {
      track = {
        id: `track-${Date.now()}`,
        name: `Track ${new Date().toLocaleDateString()}`,
        startFinish: gate,
        sectors: [],
        bestLap: null,
        createdAt: new Date().toISOString(),
      };
    }
    await this.storage.saveTrack(track);
    await this.refreshTracks();
    this.liveTrack = track;
    this.liveTrackName.textContent = track.name;
    if (this.recordingActive) {
      this.lapTimer.markStartFinish(track, fix);
      this.recorder.run.trackId = track.id;
      await this.storage.saveRun(this.recorder.header());
      this.hud.flash("Start/finish set. Lap 1 started");
    } else {
      this.showMessage(`Saved start/finish for "${track.name}". Rename it from the Sessions page.`, 4000);
    }
  }

  // ---------- tracks ----------

  async refreshTracks() {
    this.tracks = await this.storage.getTracks();
    const selection = this.settings.trackSelection ?? "auto";
    const options = [
      `<option value="auto">Auto (nearest saved track)</option>`,
      ...this.tracks.map((track) => `<option value="${escapeHtml(track.id)}">${escapeHtml(track.name)}</option>`),
      `<option value="none">Off (no lap timing)</option>`,
    ];
    this.trackSelect.innerHTML = options.join("");
    const valid = selection === "auto" || selection === "none" || this.tracks.some((track) => track.id === selection);
    this.trackSelect.value = valid ? selection : "auto";
    this.deleteTrackButton.disabled = !this.tracks.some((track) => track.id === this.trackSelect.value);
  }

  async handleDeleteTrack() {
    const track = this.tracks.find((item) => item.id === this.trackSelect.value);
    if (!track || !window.confirm(`Delete track "${track.name}"? Sessions keep their data.`)) return;
    await this.storage.deleteTrack(track.id);
    this.settings.trackSelection = "auto";
    saveSettings(this.settings);
    await this.refreshTracks();
    await this.reanalyzeRuns((run) => run.trackId === track.id || run.analysis?.track?.id === track.id, (run) => {
      if (run.trackId === track.id) run.trackId = null;
    });
  }

  async updateTrackBest(run) {
    const trackId = run.analysis.track?.id;
    const { bestLap, bestLapNumber } = run.analysis.summary;
    if (!trackId || !Number.isFinite(bestLap)) return;
    const track = this.tracks.find((item) => item.id === trackId);
    if (!track || (track.bestLap && track.bestLap.time <= bestLap)) return;
    const lap = run.analysis.laps.find((item) => item.number === bestLapNumber);
    track.bestLap = {
      time: bestLap,
      runId: run.id,
      date: run.date,
      trace: lapTrace(run.analysis.points, lap),
    };
    await this.storage.saveTrack(track);
  }

  async assignTrack(run, value) {
    run.trackId = value === "auto" ? null : value;
    await this.reanalyzeAndShow(run);
  }

  async saveTrackForRun(run, draft) {
    const track = {
      id: `track-${Date.now()}`,
      name: draft.name,
      startFinish: draft.startFinish,
      sectors: draft.sectors ?? [],
      bestLap: null,
      createdAt: new Date().toISOString(),
    };
    await this.storage.saveTrack(track);
    await this.refreshTracks();
    run.trackId = track.id;
    await this.reanalyzeAndShow(run);
  }

  async updateTrackFromRun(run, patch) {
    const trackId = run.analysis.track?.id;
    const track = this.tracks.find((item) => item.id === trackId);
    if (!track) return;
    Object.assign(track, patch);
    if (patch.startFinish || patch.sectors) track.bestLap = null;
    await this.storage.saveTrack(track);
    await this.refreshTracks();
    await this.reanalyzeRuns((item) => item.analysis?.track?.id === trackId || item.trackId === trackId);
    const updated = this.runs.find((item) => item.id === run.id);
    if (updated) this.renderRunDetails(updated);
  }

  async reanalyzeAndShow(run) {
    const analyzed = analyzeRun(run, { tracks: this.tracks });
    await this.storage.saveRun(analyzed);
    await this.updateTrackBest(analyzed);
    await this.refreshRuns(analyzed.id);
  }

  async reanalyzeRuns(predicate, mutate) {
    const runs = await this.storage.getRuns();
    for (const run of runs.filter((item) => item.status !== "recording" && predicate(item))) {
      mutate?.(run);
      const analyzed = analyzeRun(run, { tracks: this.tracks });
      await this.storage.saveRun(analyzed);
      await this.updateTrackBest(analyzed);
    }
    await this.refreshRuns(this.selectedRun?.id);
  }

  // ---------- sessions ----------

  async recoverInterruptedRuns() {
    try {
      const recovered = await this.storage.recoverInterruptedRuns();
      for (const run of recovered) {
        const analyzed = analyzeRun(run, { tracks: this.tracks });
        await this.storage.saveRun(analyzed);
        await this.storage.deleteChunks(run.id);
      }
      if (recovered.length) {
        this.showMessage(`Recovered ${recovered.length} interrupted session${recovered.length > 1 ? "s" : ""}.`, 5000);
      }
    } catch (error) {
      console.warn("Session recovery failed", error);
    }
  }

  async refreshRuns(selectRunId = this.selectedRun?.id) {
    const runs = await this.storage.getRuns();
    this.runs = [];
    for (const run of runs) {
      if (run.status === "recording") continue;
      if (needsReanalysis(run)) {
        const analyzed = analyzeRun(run, { tracks: this.tracks });
        await this.storage.saveRun(analyzed);
        this.runs.push(analyzed);
      } else {
        this.runs.push(run);
      }
    }
    this.renderRunSummary();

    if (!this.runs.length) {
      this.selectedRun = null;
      this.renderRunList();
      this.setRunButtonsEnabled(false);
      this.runView.destroy();
      this.runDetails.className = "details-empty";
      this.runDetails.innerHTML = "<p>Select a session to see laps, sectors, g-forces and drifts.</p>";
      return;
    }
    const run = this.runs.find((item) => item.id === selectRunId) ?? this.runs[0];
    this.renderRunDetails(run, { keepSelection: run.id === this.selectedRun?.id });
  }

  renderRunSummary() {
    const bestQuarter = this.runs
      .map((run) => run.analysis?.summary?.quarterMileSeconds)
      .filter(Number.isFinite);
    const items = [
      `<article class="detail-stat"><span>Saved Sessions</span><strong>${this.runs.length}</strong></article>`,
      `<article class="detail-stat"><span>Saved Tracks</span><strong>${this.tracks.length}</strong></article>`,
    ];
    if (bestQuarter.length) {
      items.push(
        `<article class="detail-stat"><span>Best 1/4 Mile</span><strong>${Math.min(...bestQuarter).toFixed(2)} s</strong></article>`,
      );
    }
    this.runSummaryBar.innerHTML = items.join("");
  }

  renderRunList() {
    if (!this.runs.length) {
      this.runList.className = "run-list empty-state";
      this.runList.innerHTML = "<p>No sessions yet. Record one to start building telemetry history.</p>";
      return;
    }
    this.runList.className = "run-list";
    this.runList.innerHTML = "";
    let currentDay = null;
    const units = this.settings.units;

    for (const run of this.runs) {
      const date = new Date(run.date);
      const day = date.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
      if (day !== currentDay) {
        currentDay = day;
        const heading = document.createElement("p");
        heading.className = "eyebrow day-heading";
        heading.textContent = day;
        this.runList.appendChild(heading);
      }

      const summary = run.analysis.summary;
      const trackName = run.analysis.track?.id ? run.analysis.track.name : null;
      const headline = summary.lapCount
        ? `${formatLapTime(summary.bestLap)} best lap`
        : summary.driftCount
          ? `${summary.driftScore} drift pts`
          : `${formatSpeed(summary.maxSpeedKmh, units)} max`;
      const meta = [
        formatDuration(summary.durationSeconds * 1000),
        summary.lapCount ? `${summary.lapCount} laps` : null,
        summary.driftCount ? `${summary.driftCount} drifts` : null,
        Number.isFinite(summary.zeroToHundredSeconds) ? `0-100 ${summary.zeroToHundredSeconds.toFixed(2)} s` : null,
        run.status === "recovered" ? "recovered" : null,
      ].filter(Boolean);

      const card = document.createElement("button");
      card.className = `run-card${run.id === this.selectedRun?.id ? " active" : ""}`;
      card.type = "button";
      card.innerHTML = `
        <p class="eyebrow">${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · ${escapeHtml(trackName ?? run.mode ?? "session")}</p>
        <h3>${headline}</h3>
        <div class="run-meta">${meta.map((item) => `<span>${item}</span>`).join("")}</div>
      `;
      card.addEventListener("click", () => this.renderRunDetails(run));
      this.runList.appendChild(card);
    }
  }

  renderRunDetails(run, options = {}) {
    this.selectedRun = run;
    this.renderRunList();
    const trackName = run.analysis.track?.id ? ` · ${run.analysis.track.name}` : "";
    this.detailTitle.textContent = `${new Date(run.date).toLocaleString()}${trackName}`;
    this.setRunButtonsEnabled(true);
    this.runDetails.className = "run-details";
    this.runView.render(run, options);
  }

  setRunButtonsEnabled(enabled) {
    for (const button of Object.values(this.exportButtons)) button.disabled = !enabled;
    this.deleteRunButton.disabled = !enabled;
  }

  async handleDeleteRun() {
    if (!this.selectedRun) return;
    if (!window.confirm(`Delete the session from ${new Date(this.selectedRun.date).toLocaleString()}?`)) return;
    await this.storage.deleteRun(this.selectedRun.id);
    this.selectedRun = null;
    await this.refreshRuns();
  }

  exportRun(format) {
    const run = this.selectedRun;
    if (!run) return;
    const base = `${run.date.replaceAll(":", "-")}-${run.id}`;
    if (format === "json") {
      // Raw streams plus the lap/drift results; derived 10 Hz series are rebuilt on import.
      const { series: _series, points: _points, ...analysis } = run.analysis;
      downloadBlob(`${base}.json`, JSON.stringify({ ...run, analysis }, null, 2), "application/json");
    } else if (format === "csv") {
      downloadBlob(`${base}.csv`, runToCsv(run), "text/csv;charset=utf-8");
    } else if (format === "gpx") {
      downloadBlob(`${base}.gpx`, runToGpx(run), "application/gpx+xml");
    } else if (format === "vbo") {
      downloadBlob(`${base}.vbo`, runToVbo(run), "text/plain");
    }
  }

  // ---------- platform helpers ----------

  showMessage(message, autoHideMs = 0) {
    window.clearTimeout(this.timers.message);
    this.permissionMessage.hidden = !message;
    this.permissionMessage.textContent = message;
    if (message && autoHideMs) {
      this.timers.message = window.setTimeout(() => {
        this.permissionMessage.hidden = true;
      }, autoHideMs);
    }
  }

  async requestNotificationPermission() {
    if (!("Notification" in window) || Notification.permission !== "default") return;
    try {
      await Notification.requestPermission();
    } catch (error) {
      console.warn("Notification permission request failed", error);
    }
  }

  async acquireWakeLock() {
    if (this.wakeLock || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
      this.wakeLock.addEventListener("release", () => {
        this.wakeLock = null;
      });
    } catch (error) {
      console.warn("Wake lock request failed", error);
      this.showMessage("Screen wake lock was not granted. Keep the phone awake manually while recording.");
    }
  }

  async releaseWakeLock() {
    if (!this.wakeLock) return;
    try {
      await this.wakeLock.release();
    } catch (error) {
      console.warn("Wake lock release failed", error);
    }
    this.wakeLock = null;
  }

  async showRecordingNotification() {
    if (!this.serviceWorkerRegistration || !("Notification" in window) || Notification.permission !== "granted") {
      return;
    }
    await this.serviceWorkerRegistration.showNotification("Telemetry recording in progress", {
      body: "Keep the app visible and the phone unlocked for reliable sensor capture.",
      tag: "telemetry-recording",
      icon: "./assets/icon.svg",
      badge: "./assets/icon.svg",
      requireInteraction: true,
      renotify: false,
      silent: true,
    });
  }

  async clearRecordingNotification() {
    if (!this.serviceWorkerRegistration) return;
    const notifications = await this.serviceWorkerRegistration.getNotifications({ tag: "telemetry-recording" });
    for (const notification of notifications) notification.close();
  }

  async handleVisibilityChange() {
    if (!this.recordingActive && !this.armed) return;
    if (document.visibilityState === "visible") {
      await this.acquireWakeLock();
      await this.clearRecordingNotification();
      return;
    }
    await this.flushChunk();
    await this.showRecordingNotification();
    this.showMessage("Most mobile browsers pause sensors while the app is hidden or the phone is locked.");
  }
}
