import { analyzeRun, formatDelta, formatDuration, formatLapTime, needsReanalysis } from "./analysis.js";
import { AnalysisView, escapeHtml } from "./analysisview.js";
import { Announcer, DriftTone } from "./audio.js";
import { DragTimer } from "./dragtimer.js";
import { DriftEstimator, DriftSegmenter } from "./drift.js";
import { DriveView } from "./driveview.js";
import { LiveNavigator } from "./ekf.js";
import { runToCsv, runToGpx, runToVbo } from "./exporters.js";
import { LightMotionFilter } from "./filters.js";
import { IMUView } from "./imuview.js";
import { createGate, lapTrace, LiveLapTimer, nearestTrack } from "./laptiming.js";
import { courseOf, MountCalibration } from "./orientation.js";
import { RunRecorder } from "./recorder.js";
import { SensorManager } from "./sensors.js";
import {
  formatSpeed,
  loadCalibration,
  loadSettings,
  saveCalibration,
  saveSettings,
} from "./settings.js";
import { RunStorage } from "./storage.js";
import { TrackEditor } from "./trackeditor.js";
import { haversineMeters } from "./geo.js";

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
        this.sampleCount = count;
      },
    });
    this.sensors = new SensorManager({
      onLocation: (payload) => this.handleLocation(payload),
      onMotion: (payload) => this.handleMotion(payload),
      onStatus: (type, message) => this.handleSensorStatus(type, message),
    });
    this.navigator = new LiveNavigator();
    this.lapTimer = new LiveLapTimer({ onEvent: (event) => this.handleLapEvent(event) });
    this.driftEstimator = new DriftEstimator();
    this.driftSegmenter = new DriftSegmenter({ onChainEnd: (chain) => this.handleDriftChain(chain) });
    this.dragTimer = new DragTimer({ onEvent: (event) => this.handleDragEvent(event) });
    this.announcer = new Announcer();
    this.driftTone = new DriftTone();

    this.deferredPrompt = null;
    this.serviceWorkerRegistration = null;
    this.runs = [];
    this.tracks = [];
    this.selectedRun = null;
    this.stage = "setupStage";
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
    this.latestProjection = null;
    this.drawPending = false;
    this.lastDriftSample = 0;
    this.driftState = { angle: null, chainScore: null, lastScore: null, bestScore: null };
    this.logger = { distanceMeters: 0, maxKmh: 0, movingSeconds: 0, lastT: null };
    this.chunkSeq = 0;
    this.sampleCount = 0;
    this.timers = {};
    this.wakeLock = null;
  }

  async init() {
    this.cacheElements();
    this.driveView = new DriveView(this.driveStage, {
      getUnits: () => this.settings.units,
      onStop: () => this.handleStopRun("manual"),
      onDisarm: () => this.handleArmToggle(),
    });
    this.imuView = new IMUView(this.imuMount);
    this.trackEditor = new TrackEditor(document.getElementById("trackEditor"), {
      getPosition: () =>
        this.lastFix && now() - this.lastFix.arrival < 10000 ? { lat: this.lastFix.lat, lon: this.lastFix.lon } : null,
      onSave: (track, info) => this.handleTrackSaved(track, info),
      onClose: () => this.updateTrackButtons(),
    });
    this.analysisView = new AnalysisView(this.runDetails, {
      getUnits: () => this.settings.units,
      getTracks: () => this.tracks,
      assignTrack: (run, value) => this.assignTrack(run, value),
      saveTrackForRun: (run, draft) => this.saveTrackForRun(run, draft),
      updateTrack: (run, patch) => this.updateTrackFromRun(run, patch),
    });
    this.applySettingsToInputs();
    this.bindEvents();
    this.registerPwa();
    this.driveView.setTab(this.settings.driveTab ?? "speed");
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
    this.driveStage = byId("driveStage");
    this.startButton = byId("startButton");
    this.armButton = byId("armButton");
    this.markStartFinishButton = byId("markStartFinishButton");
    this.locationStatus = byId("locationStatus");
    this.motionStatus = byId("motionStatus");
    this.setupSpeed = byId("setupSpeed");
    this.toast = byId("toast");
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
    this.newTrackButton = byId("newTrackButton");
    this.editTrackButton = byId("editTrackButton");
    this.calibrationGravity = byId("calibrationGravity");
    this.calibrationForward = byId("calibrationForward");
    this.calibrationGyro = byId("calibrationGyro");
    this.captureMountButton = byId("captureMountButton");
    this.resetCalibrationButton = byId("resetCalibrationButton");
    this.skipCalibrationButton = byId("skipCalibrationButton");
    this.enableImuButton = byId("enableImuButton");
    this.disableImuButton = byId("disableImuButton");
    this.imuMount = byId("imuMount");
    this.modeCards = [...document.querySelectorAll(".mode-card")];
    this.modeOptions = [...document.querySelectorAll(".mode-options")];
    this.stages = [...document.querySelectorAll(".stage")];
    this.stageButtons = [...document.querySelectorAll(".stage-button")];
  }

  // ---------- stages ----------

  showStage(stageId) {
    this.stage = stageId;
    for (const stage of this.stages) stage.classList.toggle("active", stage.id === stageId);
    for (const button of this.stageButtons) button.classList.toggle("active", button.dataset.stage === stageId);
    document.body.classList.toggle("driving", stageId === "driveStage");
    if (stageId === "driveStage") {
      this.driveView.setTab(this.driveView.tab ?? "speed");
    }
    window.scrollTo(0, 0);
    this.syncSensors();
  }

  updateStageButtons() {
    const live = this.recordingActive || this.armed;
    const driveButton = this.stageButtons.find((button) => button.dataset.stage === "driveStage");
    driveButton.disabled = !live;
    driveButton.classList.toggle("live", live);
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
    saveSettings(this.settings);
  }

  setMode(mode) {
    if (this.recordingActive) return;
    this.settings.mode = mode;
    for (const card of this.modeCards) card.classList.toggle("active", card.dataset.mode === mode);
    for (const section of this.modeOptions) section.hidden = section.dataset.for !== mode;
    this.driveView.setMode(mode);
    saveSettings(this.settings);
  }

  // ---------- events ----------

  bindEvents() {
    this.startButton.addEventListener("click", () => this.handleStartRun());
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
      this.driveView.setMode(this.settings.mode);
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
      this.updateTrackButtons();
    });
    this.deleteTrackButton.addEventListener("click", () => this.handleDeleteTrack());
    this.newTrackButton.addEventListener("click", () => {
      this.trackEditor.open(null);
      this.updateTrackButtons();
    });
    this.editTrackButton.addEventListener("click", () => {
      const track = this.tracks.find((item) => item.id === this.trackSelect.value);
      if (track) this.trackEditor.open(track);
      this.updateTrackButtons();
    });
    this.captureMountButton.addEventListener("click", () => this.handleCaptureMount());
    this.resetCalibrationButton.addEventListener("click", () => this.handleResetCalibration());
    this.skipCalibrationButton.addEventListener("click", () => this.handleSkipCalibration());
    this.enableImuButton.addEventListener("click", () => this.handleEnableImu());
    this.disableImuButton.addEventListener("click", () => this.handleDisableImu());
    for (const card of this.modeCards) {
      card.addEventListener("click", () => this.setMode(card.dataset.mode));
    }
    for (const button of this.stageButtons) {
      button.addEventListener("click", () => this.showStage(button.dataset.stage));
    }
    for (const button of this.driveStage.querySelectorAll(".drive-tab")) {
      button.addEventListener("click", () => {
        this.settings.driveTab = button.dataset.tab;
        saveSettings(this.settings);
      });
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
    const inSetup = this.stage === "setupStage";
    this.sensors.setStreams({
      location: live || inSetup,
      motion: this.imuStreaming || (!this.calibration.isSkipped() && (live || inSetup)),
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

  gnssText() {
    const arrivals = this.fixArrivals;
    if (!this.lastFix || now() - this.lastFix.arrival > 3000) return "No GNSS";
    const span = arrivals.length > 1 ? (arrivals[arrivals.length - 1] - arrivals[0]) / 1000 : 0;
    const rate = span > 0 ? (arrivals.length - 1) / span : 0;
    const accuracy = Number.isFinite(this.lastFix.accuracy) ? ` ±${Math.round(this.lastFix.accuracy)} m` : "";
    return `${rate ? `${rate.toFixed(rate < 2 ? 1 : 0)} Hz` : "Live"}${accuracy}`;
  }

  handleLocation(fix) {
    this.previousFix = this.lastFix;
    this.lastFix = fix;
    this.fixArrivals.push(fix.arrival);
    if (this.fixArrivals.length > 10) this.fixArrivals.shift();
    this.locationStatus.textContent = this.gnssText();

    this.calibration.ingestFix(fix);
    // GNSS timestamps run late by the delivery latency measured after previous sessions.
    this.navigator.ingestFix({ ...fix, t: fix.t - (this.settings.gnssLagMs || 0) }, fix.arrival);

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
    this.navigator.ingestImu(sample.t, projection, this.recordingActive ? this.driftEstimator.currentBeta() : null);

    if (this.recordingActive && this.settings.mode === "drag") {
      const estimate = this.navigator.estimate(sample.t);
      const target = this.settings.units === "mph" ? 60 / 2.23694 : 100 / 3.6;
      if (estimate) this.dragTimer.ingest(sample.t, estimate.speed, target);
    }

    if (this.imuStreaming) {
      this.imuView.update(filtered);
    }
    if (this.stage === "driveStage" && !this.drawPending) {
      this.drawPending = true;
      requestAnimationFrame(() => {
        this.drawPending = false;
        this.driveView.drawG(this.latestProjection, now());
      });
    }
  }

  pushPreRoll(stream, item) {
    const buffer = this.preRoll[stream];
    buffer.push(item);
    while (buffer.length && item.t - buffer[0].t > PRE_ROLL_MS) buffer.shift();
  }

  updateLiveDrift(t) {
    const beta = this.driftEstimator.currentBeta();
    const estimate = this.navigator.estimate(t);
    const chain = this.driftSegmenter.ingest(t, beta, (estimate?.speed ?? 0) * 3.6);
    this.driftState.angle = beta;
    this.driftState.chainScore = chain ? chain.score : null;
    this.driftTone.update(beta, Boolean(chain));
  }

  handleDriftChain(chain) {
    this.driftState.lastScore = chain.score;
    if (this.driftState.bestScore == null || chain.score > this.driftState.bestScore) {
      this.driftState.bestScore = chain.score;
      if (this.settings.mode === "drift") {
        this.driveView.flash(`Best drift ${chain.score}`, "good");
        this.announcer.say(`Best drift. ${chain.score}`);
      }
    }
  }

  handleDragEvent(event) {
    if (event.type === "staged") {
      this.announcer.say("Staged");
    } else if (event.type === "finish" && event.result.quarter != null) {
      this.driveView.flash(`1/4 mile ${event.result.quarter.toFixed(2)} s`, "good");
      this.announcer.say(`Quarter mile. ${event.result.quarter.toFixed(2)}`);
    } else if (event.type === "target") {
      this.announcer.say(event.time.toFixed(2));
    }
  }

  // ---------- HUD ----------

  tickHud() {
    const t = now();
    const estimate = this.navigator.estimate(t);
    const kmh = estimate ? estimate.speed * 3.6 : Number.isFinite(this.lastFix?.speed) ? this.lastFix.speed * 3.6 : 0;
    this.setupSpeed.textContent = formatSpeed(kmh, this.settings.units);

    if (this.stage === "driveStage" || this.recordingActive) {
      this.driveView.updateSpeed(kmh);
      this.driveView.updatePosition(estimate, t);
      this.driveView.setStatus({
        recording: this.recordingActive,
        armed: this.armed,
        elapsedMs: this.recorder.run ? t - this.recorder.run.startedAt : 0,
        gnssText: this.gnssText(),
        imuText: this.imuShortStatus(),
      });
      if (this.recordingActive) {
        this.updateLogger(t, estimate);
        const mode = this.settings.mode;
        if (mode === "track") {
          this.driveView.updateTrack({
            lapSeconds: this.lapTimer.currentLapSeconds(t),
            delta: this.lapTimer.delta,
            lastLap: this.lapTimer.lastLap,
            bestLap: this.lapTimer.bestLap,
            lapCount: this.lapTimer.lapNumber,
          });
        } else if (mode === "drift") {
          this.driveView.updateDrift(this.driftState);
        } else if (mode === "drag") {
          this.driveView.updateDrag(this.dragTimer, t);
        } else {
          this.driveView.updateLogger({
            distanceMeters: this.logger.distanceMeters,
            maxKmh: this.logger.maxKmh,
            averageKmh: this.logger.movingSeconds ? (this.logger.distanceMeters / this.logger.movingSeconds) * 3.6 : 0,
          });
        }
      }
    }
    this.tickCount = (this.tickCount ?? 0) + 1;
    if (this.tickCount % 5 === 0) {
      this.refreshCalibrationStatus();
    }
  }

  updateLogger(t, estimate) {
    const logger = this.logger;
    if (estimate && logger.lastT != null) {
      const dt = Math.min((t - logger.lastT) / 1000, 1);
      logger.distanceMeters += estimate.speed * dt;
      if (estimate.speed > 1) logger.movingSeconds += dt;
      logger.maxKmh = Math.max(logger.maxKmh, estimate.speed * 3.6);
    }
    logger.lastT = t;
  }

  imuShortStatus() {
    const status = this.calibration.getStatus();
    if (status.skipped) return "GPS only";
    if (!status.gravityReady) return "IMU: stop to level";
    if (!status.forwardReady) return "IMU: aligning";
    return "IMU ok";
  }

  // ---------- calibration ----------

  handleCalibrationEvent(event) {
    if (event === "captured") {
      this.showMessage("Mount angle locked.", 2500);
    } else if (event === "mount-moved") {
      this.showMessage("Phone mount moved. Re-aligning the forward axis while you drive.");
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
    this.driveView.setGNote(
      status.skipped
        ? "GPS-only mode"
        : !status.gravityReady
          ? "Waiting for the car to stand still"
          : !status.forwardReady
            ? "Drive to auto-align the forward axis"
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
    this.showMessage("Calibration cleared. It re-captures when the car stops and re-solves while you drive.");
  }

  async handleSkipCalibration() {
    if (this.calibration.isSkipped()) {
      this.calibration.reset();
      saveCalibration(null);
      await this.ensureMotionPermission();
    } else {
      this.calibration.skip();
      saveCalibration(this.calibration.snapshot());
      this.showMessage("GPS-only mode. G-forces are estimated from GPS and drift angle is unavailable.");
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
    this.syncSensors();
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
      if (!this.recordingActive) {
        await this.releaseWakeLock();
        this.showStage("setupStage");
      }
      this.updateStageButtons();
      this.syncSensors();
      return;
    }
    const ready = await this.requestRecordingPermissions();
    if (!ready) return;
    this.readSettingsFromInputs();
    this.driftTone.unlock();
    this.armed = true;
    this.preRoll = { gnss: [], imu: [] };
    this.driveView.resetSession();
    await this.acquireWakeLock();
    this.updateStageButtons();
    this.showStage("driveStage");
    this.driveView.flash(
      `Armed: recording starts above ${this.settings.autoStartKmh || 30} km/h`,
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
    const timingWanted = this.settings.mode === "track";
    this.liveTrack = timingWanted ? this.selectLiveTrack() : null;
    this.lapTimer.configure({
      track: this.liveTrack,
      minLapSeconds: this.settings.lapMinSeconds || 10,
      autoGate: timingWanted && selection !== "none",
      referenceTrace: this.liveTrack?.bestLap?.trace ?? null,
    });
    this.driftEstimator.reset();
    this.driftSegmenter.reset();
    this.dragTimer.reset();
    this.driftState = { angle: null, chainScore: null, lastScore: null, bestScore: null };
    this.logger = { distanceMeters: 0, maxKmh: 0, movingSeconds: 0, lastT: null };
    this.driveView.resetSession();
    this.driveView.setMode(this.settings.mode);
    this.driveView.updateTrack({
      lapSeconds: null, delta: null, lastLap: null, bestLap: null, lapCount: 0,
      trackName: this.liveTrack?.name ?? (selection === "none" ? "Lap timing off" : "Auto start/finish"),
    });
    this.updateDriveGates();

    const preRoll = auto ? this.preRoll : null;
    this.recorder.start(
      {
        sampleRateHz: this.settings.sampleRateHz,
        maxDurationSeconds: this.settings.maxDurationSeconds,
        lapMinSeconds: this.settings.lapMinSeconds,
        mode: this.settings.mode,
        trackId: !timingWanted || selection === "none" ? (timingWanted ? "none" : null) : this.liveTrack?.id ?? null,
      },
      preRoll,
    );
    if (preRoll) {
      // Replay the buffered fixes so the live timer does not start blind.
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
    this.updateStageButtons();
    this.showStage("driveStage");
    if (auto) this.announcer.say("Recording");
  }

  updateDriveGates() {
    const track = this.lapTimer.track;
    this.driveView.setGates(
      track
        ? [
            { ...track.startFinish, color: "#ffffff" },
            ...(track.sectors ?? []).map((gate) => ({ ...gate, color: "#c792ea" })),
          ]
        : [],
    );
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
    this.updateStageButtons();
    if (!reArm) this.showStage("analysisStage");
    this.syncSensors();

    if (!run || (!run.gnss.length && !run.imu.length)) {
      if (run) await this.storage.deleteRun(run.id);
      this.showMessage("No telemetry samples were captured.");
      if (!reArm) this.showStage("setupStage");
      return;
    }

    this.showMessage("Processing session: re-aligning IMU to the trajectory and smoothing...", 0);
    // Let the toast paint before the heavy processing.
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    const analyzed = analyzeRun(run, { tracks: this.tracks });
    await this.storage.saveRun(analyzed);
    await this.storage.deleteChunks(run.id);
    this.rememberGnssLag(analyzed);
    await this.updateTrackBest(analyzed);
    await this.refreshRuns(analyzed.id);

    const { summary } = analyzed.analysis;
    const parts = [
      reArm ? "Session auto-stopped and saved" : "Session saved",
      summary.lapCount ? `${summary.lapCount} laps, best ${formatLapTime(summary.bestLap)}` : null,
      summary.driftCount ? `${summary.driftCount} drifts, ${summary.driftScore} pts` : null,
      reason === "max-duration" ? "time limit reached" : null,
      reArm ? "re-armed for the next session" : null,
    ].filter(Boolean);
    this.showMessage(`${parts.join(" · ")}.`, 6000);
  }

  // The latency found by aligning GNSS with the IMU is reused by the live fusion filter.
  rememberGnssLag(run) {
    const lag = run.analysis.gnssLagMs;
    if (!Number.isFinite(lag)) return;
    const previous = this.settings.gnssLagMs;
    this.settings.gnssLagMs = Number.isFinite(previous) && previous ? Math.round(previous * 0.5 + lag * 0.5) : lag;
    saveSettings(this.settings);
  }

  handleLapEvent(event) {
    if (event.type === "lap") {
      const tone = event.isBest ? "good" : "bad";
      const deltaText = event.deltaToBest == null ? "" : event.isBest ? " best" : ` ${formatDelta(event.deltaToBest)}`;
      this.driveView.flash(`Lap ${event.number}: ${formatLapTime(event.time)}${deltaText}`, tone);
      this.announcer.announceLap(event);
      navigator.vibrate?.(event.isBest ? [80, 60, 80] : 120);
    } else if (event.type === "auto-gate") {
      this.driveView.updateTrack({ ...this.liveTrackState(), trackName: "Auto start/finish (placed)" });
      this.updateDriveGates();
      this.driveView.flash("Start/finish placed automatically");
      this.announcer.say("Start finish set");
    } else if (event.type === "sector") {
      this.driveView.flash(`S${event.sector}: ${event.split.toFixed(2)}`);
    } else if (event.type === "lap-start") {
      this.driveView.flash("Lap timing started");
    }
  }

  liveTrackState() {
    return {
      lapSeconds: this.lapTimer.currentLapSeconds(now()),
      delta: this.lapTimer.delta,
      lastLap: this.lapTimer.lastLap,
      bestLap: this.lapTimer.bestLap,
      lapCount: this.lapTimer.lapNumber,
    };
  }

  async handleMarkStartFinish() {
    const fix = this.lastFix;
    if (!fix || now() - fix.arrival > 3000) {
      this.driveView.flash("No recent GPS fix", "bad");
      return;
    }
    const heading = courseOf(fix, this.previousFix);
    if (heading == null) {
      this.driveView.flash("Drive through the line, then tap again", "bad");
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
    if (this.recordingActive) {
      this.lapTimer.markStartFinish(track, fix);
      this.recorder.run.trackId = track.id;
      await this.storage.saveRun(this.recorder.header());
      this.updateDriveGates();
      this.driveView.updateTrack({ ...this.liveTrackState(), trackName: track.name });
      this.driveView.flash("Start/finish set. Lap 1 started");
    }
  }

  // ---------- tracks ----------

  async refreshTracks() {
    this.tracks = await this.storage.getTracks();
    const selection = this.settings.trackSelection ?? "auto";
    this.trackSelect.innerHTML = [
      `<option value="auto">Auto (nearest saved track)</option>`,
      ...this.tracks.map((track) => `<option value="${escapeHtml(track.id)}">${escapeHtml(track.name)}</option>`),
      `<option value="none">Off (no lap timing)</option>`,
    ].join("");
    const valid = selection === "auto" || selection === "none" || this.tracks.some((track) => track.id === selection);
    this.trackSelect.value = valid ? selection : "auto";
    this.updateTrackButtons();
  }

  updateTrackButtons() {
    const selected = this.tracks.some((track) => track.id === this.trackSelect.value);
    const editing = this.trackEditor.isOpen();
    this.deleteTrackButton.disabled = !selected || editing;
    this.editTrackButton.disabled = !selected || editing;
    this.newTrackButton.disabled = editing;
  }

  // Track drawn in Setup: select it for the next sessions and re-time past sessions there.
  async handleTrackSaved(track, { isNew, geometryChanged }) {
    await this.storage.saveTrack(track);
    this.settings.trackSelection = track.id;
    saveSettings(this.settings);
    await this.refreshTracks();
    this.showMessage(`${isNew ? "Saved" : "Updated"} "${track.name}". It is selected for your next sessions.`, 4000);
    if (!geometryChanged) {
      await this.refreshRuns(this.selectedRun?.id);
      return;
    }
    const center = track.startFinish.center;
    await this.reanalyzeRuns((run) => {
      if (run.analysis?.track?.id === track.id || run.trackId === track.id) return true;
      if (run.trackId) return false;
      const points = run.analysis?.points ?? [];
      const middle = points[Math.floor(points.length / 2)];
      return Boolean(middle) && haversineMeters(middle, center) < 3000;
    });
  }

  async handleDeleteTrack() {
    const track = this.tracks.find((item) => item.id === this.trackSelect.value);
    if (!track || !window.confirm(`Delete track "${track.name}"? Sessions keep their data.`)) return;
    await this.storage.deleteTrack(track.id);
    this.settings.trackSelection = "auto";
    saveSettings(this.settings);
    await this.refreshTracks();
    await this.reanalyzeRuns(
      (run) => run.trackId === track.id || run.analysis?.track?.id === track.id,
      (run) => {
        if (run.trackId === track.id) run.trackId = null;
      },
    );
  }

  async updateTrackBest(run) {
    const trackId = run.analysis.track?.id;
    const { bestLap, bestLapNumber } = run.analysis.summary;
    if (!trackId || !Number.isFinite(bestLap)) return;
    const track = this.tracks.find((item) => item.id === trackId);
    if (!track || (track.bestLap && track.bestLap.time <= bestLap)) return;
    const lap = run.analysis.laps.find((item) => item.number === bestLapNumber);
    track.bestLap = { time: bestLap, runId: run.id, date: run.date, trace: lapTrace(run.analysis.points, lap) };
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
      this.analysisView.destroy();
      this.runDetails.className = "details-empty";
      this.runDetails.innerHTML = "<p>Select a session to see laps, maps, graphs and replay.</p>";
      return;
    }
    const run = this.runs.find((item) => item.id === selectRunId) ?? this.runs[0];
    this.renderRunDetails(run, { keepSelection: run.id === this.selectedRun?.id });
  }

  renderRunSummary() {
    const bestQuarter = this.runs.map((run) => run.analysis?.summary?.quarterMileSeconds).filter(Number.isFinite);
    const items = [
      `<article class="detail-stat"><span>Sessions</span><strong>${this.runs.length}</strong></article>`,
      `<article class="detail-stat"><span>Tracks</span><strong>${this.tracks.length}</strong></article>`,
    ];
    if (bestQuarter.length) {
      items.push(`<article class="detail-stat"><span>Best 1/4 Mile</span><strong>${Math.min(...bestQuarter).toFixed(2)} s</strong></article>`);
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
          : Number.isFinite(summary.quarterMileSeconds) && run.mode === "drag"
            ? `${summary.quarterMileSeconds.toFixed(2)} s 1/4 mile`
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
        <div class="run-meta">${meta.map((item) => `<span>${item}</span>`).join("")}</div>`;
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
    this.analysisView.destroy();
    this.analysisView.render(run, options);
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

  showMessage(message, autoHideMs = 5000) {
    window.clearTimeout(this.timers.message);
    this.toast.hidden = !message;
    this.toast.textContent = message;
    if (message && autoHideMs) {
      this.timers.message = window.setTimeout(() => {
        this.toast.hidden = true;
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
    if (!this.serviceWorkerRegistration || !("Notification" in window) || Notification.permission !== "granted") return;
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
  }
}

