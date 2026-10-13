import { formatDelta, formatLapTime } from "./analysis.js";
import { formatDistance, speedFactor, speedUnit } from "./settings.js";

const TRAIL_MS = 1500;
const G_RANGE = 1.6;
const MAP_UPDATE_MS = 200;
const MAP_TRAIL_POINTS = 3000;
const HOLD_TO_STOP_MS = 800;

function formatG(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)} g` : "-- g";
}

// The in-car screen: only what is useful at a glance, split across Speed / Map / G tabs.
export class DriveView {
  constructor(root, { getUnits, onStop, onDisarm }) {
    this.root = root;
    this.getUnits = getUnits;
    this.onStop = onStop;
    this.onDisarm = onDisarm;
    const $ = (selector) => root.querySelector(selector);
    this.el = {
      modeLabel: $("#driveMode"),
      recDot: $("#driveRecDot"),
      stateLabel: $("#driveState"),
      elapsed: $("#driveElapsed"),
      gnss: $("#driveGnss"),
      imu: $("#driveImu"),
      stop: $("#driveStopButton"),
      stopFill: $("#driveStopFill"),
      stopLabel: $("#driveStopLabel"),
      speed: $("#driveSpeed"),
      speedUnit: $("#driveSpeedUnit"),
      lapClock: $("#driveLapClock"),
      delta: $("#driveDelta"),
      lastLap: $("#driveLastLap"),
      bestLap: $("#driveBestLap"),
      lapCount: $("#driveLapCount"),
      trackName: $("#driveTrackName"),
      driftAngle: $("#driveDriftAngle"),
      driftDirection: $("#driveDriftDirection"),
      driftCurrent: $("#driveDriftCurrent"),
      driftLast: $("#driveDriftLast"),
      driftBest: $("#driveDriftBest"),
      dragState: $("#driveDragState"),
      dragElapsed: $("#driveDragElapsed"),
      dragTarget: $("#driveDragTarget"),
      dragTargetLabel: $("#driveDragTargetLabel"),
      dragEighth: $("#driveDragEighth"),
      dragQuarter: $("#driveDragQuarter"),
      dragTrap: $("#driveDragTrap"),
      dragBest: $("#driveDragBest"),
      logDistance: $("#driveLogDistance"),
      logMax: $("#driveLogMax"),
      logAverage: $("#driveLogAverage"),
      flash: $("#driveFlash"),
      mapMount: $("#driveMap"),
      followButton: $("#driveFollowButton"),
      gCanvas: $("#driveGCanvas"),
      gLat: $("#driveGLat"),
      gLong: $("#driveGLong"),
      gTotal: $("#driveGTotal"),
      gPeakLeft: $("#driveGPeakLeft"),
      gPeakRight: $("#driveGPeakRight"),
      gPeakBrake: $("#driveGPeakBrake"),
      gPeakAccel: $("#driveGPeakAccel"),
      gNote: $("#driveGNote"),
      gReset: $("#driveGResetButton"),
    };
    this.tabButtons = [...root.querySelectorAll(".drive-tab")];
    this.panes = [...root.querySelectorAll(".drive-pane")];
    this.trail = [];
    this.map = null;
    this.follow = true;
    this.lastMapUpdate = 0;
    this.resetSession();
    this.bind();
  }

  bind() {
    for (const button of this.tabButtons) {
      button.addEventListener("click", () => this.setTab(button.dataset.tab));
    }
    this.el.followButton.addEventListener("click", () => {
      this.follow = !this.follow;
      this.el.followButton.classList.toggle("active", this.follow);
    });
    this.el.gReset.addEventListener("click", () => this.resetPeaks());

    // Hold to stop: a bump on a rough track must not end the session.
    let holdTimer = null;
    const cancel = () => {
      window.clearTimeout(holdTimer);
      holdTimer = null;
      this.el.stop.classList.remove("holding");
    };
    this.el.stop.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (this.armedOnly) {
        this.onDisarm?.();
        return;
      }
      this.el.stop.classList.add("holding");
      holdTimer = window.setTimeout(() => {
        cancel();
        this.onStop?.();
      }, HOLD_TO_STOP_MS);
    });
    for (const type of ["pointerup", "pointerleave", "pointercancel"]) {
      this.el.stop.addEventListener(type, cancel);
    }
  }

  resetSession() {
    this.peaks = { left: 0, right: 0, brake: 0, accel: 0 };
    this.trail = [];
    this.trailPoints = [];
    this.trailLine?.setLatLngs([]);
    this.updateTrack({ lapSeconds: null, delta: null, lastLap: null, bestLap: null, lapCount: 0 });
    this.updateDrift({ angle: null, chainScore: null, lastScore: null, bestScore: null });
  }

  setMode(mode) {
    this.root.dataset.mode = mode;
    this.el.modeLabel.textContent = { logger: "Logger", track: "Track", drift: "Drift", drag: "Drag" }[mode] ?? mode;
    this.el.dragTargetLabel.textContent = this.getUnits() === "mph" ? "0-60 mph" : "0-100 km/h";
  }

  setTab(tab) {
    this.tab = tab;
    for (const button of this.tabButtons) button.classList.toggle("active", button.dataset.tab === tab);
    for (const pane of this.panes) pane.classList.toggle("active", pane.dataset.tab === tab);
    if (tab === "map") {
      this.ensureMap();
      window.setTimeout(() => this.map?.invalidateSize(), 50);
    } else if (tab === "g") {
      this.drawG(this.lastProjection, performance.timeOrigin + performance.now());
    }
  }

  setStatus({ recording, armed, elapsedMs, gnssText, imuText }) {
    this.armedOnly = armed && !recording;
    this.root.classList.toggle("is-recording", recording);
    this.root.classList.toggle("is-armed", this.armedOnly);
    this.el.stateLabel.textContent = recording ? "REC" : armed ? "ARMED" : "IDLE";
    this.el.elapsed.textContent = recording ? formatClock(elapsedMs) : armed ? "waiting for speed" : "";
    this.el.gnss.textContent = gnssText;
    this.el.imu.textContent = imuText;
    this.el.stopLabel.textContent = this.armedOnly ? "Disarm" : "Hold to stop";
  }

  // Called every frame. Half-unit hysteresis keeps the last digit from flickering between two
  // values, and the DOM is only touched when the shown number changes.
  updateSpeed(kmh) {
    const units = this.getUnits();
    const value = Number.isFinite(kmh) ? Math.max(0, kmh * speedFactor(units)) : 0;
    if (this.shownSpeed == null || Math.abs(value - this.shownSpeed) >= 0.6 || (value < 0.5 && this.shownSpeed !== 0)) {
      this.shownSpeed = Math.round(value);
      this.el.speed.textContent = String(this.shownSpeed);
    }
    if (this.shownUnits !== units) {
      this.shownUnits = units;
      this.el.speedUnit.textContent = speedUnit(units);
    }
  }

  updateTrack({ lapSeconds, delta, lastLap, bestLap, lapCount, trackName }) {
    this.el.lapClock.textContent = lapSeconds == null ? "--:--.-" : formatLapTime(lapSeconds, 1);
    this.el.delta.textContent = delta == null ? "delta --" : formatDelta(delta);
    this.el.delta.classList.toggle("ahead", delta != null && delta < 0);
    this.el.delta.classList.toggle("behind", delta != null && delta >= 0);
    this.el.lastLap.textContent = formatLapTime(lastLap);
    this.el.bestLap.textContent = formatLapTime(bestLap);
    this.el.lapCount.textContent = String(lapCount ?? 0);
    if (trackName !== undefined) this.el.trackName.textContent = trackName;
  }

  updateDrift({ angle, chainScore, lastScore, bestScore }) {
    this.el.driftAngle.textContent = Number.isFinite(angle) ? Math.abs(angle).toFixed(0) : "--";
    this.el.driftDirection.textContent = Number.isFinite(angle) && Math.abs(angle) >= 3 ? (angle > 0 ? "L" : "R") : "";
    this.root.classList.toggle("drifting", chainScore != null);
    this.el.driftCurrent.textContent = chainScore == null ? "--" : String(chainScore);
    this.el.driftLast.textContent = lastScore == null ? "--" : String(lastScore);
    this.el.driftBest.textContent = bestScore == null ? "--" : String(bestScore);
  }

  updateDrag(timer, now) {
    const labels = { waiting: "Stop fully to stage", staged: "STAGED - launch!", running: "Running", done: "Done - stop to re-stage" };
    this.el.dragState.textContent = labels[timer.state] ?? timer.state;
    this.el.dragState.dataset.state = timer.state;
    const elapsed = timer.elapsed(now);
    this.el.dragElapsed.textContent = elapsed != null ? elapsed.toFixed(2) : timer.result.quarter != null ? timer.result.quarter.toFixed(2) : "0.00";
    const seconds = (value) => (value != null ? `${value.toFixed(2)} s` : "--");
    this.el.dragTarget.textContent = seconds(timer.result.target);
    this.el.dragEighth.textContent = seconds(timer.result.eighth);
    this.el.dragQuarter.textContent = seconds(timer.result.quarter);
    const units = this.getUnits();
    this.el.dragTrap.textContent = timer.result.trapKmh != null
      ? `${Math.round(timer.result.trapKmh * speedFactor(units))} ${speedUnit(units)}`
      : "--";
    this.el.dragBest.textContent = `${seconds(timer.best.target)} / ${seconds(timer.best.quarter)}`;
  }

  updateLogger({ distanceMeters, maxKmh, averageKmh }) {
    const units = this.getUnits();
    this.el.logDistance.textContent = formatDistance(distanceMeters, units);
    this.el.logMax.textContent = `${Math.round(maxKmh * speedFactor(units))} ${speedUnit(units)}`;
    this.el.logAverage.textContent = `${Math.round(averageKmh * speedFactor(units))} ${speedUnit(units)}`;
  }

  flash(text, tone = "neutral") {
    const element = this.el.flash;
    element.textContent = text;
    element.dataset.tone = tone;
    element.hidden = false;
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      element.hidden = true;
    }, 4000);
  }

  // ---------- G tab ----------

  resetPeaks() {
    this.peaks = { left: 0, right: 0, brake: 0, accel: 0 };
  }

  setGNote(text) {
    this.el.gNote.textContent = text;
  }

  drawG(projection, now) {
    this.lastProjection = projection;
    const ready = projection?.forwardReady;
    const lateral = ready ? projection.latG : 0;
    const longitudinal = ready ? projection.longG : 0;
    if (ready) {
      this.trail.push({ t: now, x: lateral, y: longitudinal });
      this.peaks.right = Math.max(this.peaks.right, lateral);
      this.peaks.left = Math.max(this.peaks.left, -lateral);
      this.peaks.accel = Math.max(this.peaks.accel, longitudinal);
      this.peaks.brake = Math.max(this.peaks.brake, -longitudinal);
    }
    while (this.trail.length && now - this.trail[0].t > TRAIL_MS) this.trail.shift();
    if (this.tab !== "g") return;

    const canvas = this.el.gCanvas;
    const context = canvas.getContext("2d");
    const { width, height } = canvas;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) * 0.4;
    const scale = radius / G_RANGE;
    const toCanvas = (x, y) => [
      centerX + Math.max(-G_RANGE, Math.min(G_RANGE, x)) * scale,
      centerY - Math.max(-G_RANGE, Math.min(G_RANGE, y)) * scale,
    ];

    context.clearRect(0, 0, width, height);
    context.strokeStyle = "rgba(255,255,255,0.16)";
    context.lineWidth = 2;
    for (const ring of [1.5, 1, 0.5]) {
      context.beginPath();
      context.arc(centerX, centerY, scale * ring, 0, Math.PI * 2);
      context.stroke();
    }
    context.beginPath();
    context.moveTo(centerX - radius, centerY);
    context.lineTo(centerX + radius, centerY);
    context.moveTo(centerX, centerY - radius);
    context.lineTo(centerX, centerY + radius);
    context.stroke();

    // Peak envelope: one marker per direction.
    context.fillStyle = "rgba(255,211,108,0.9)";
    for (const [x, y] of [
      [-this.peaks.left, 0],
      [this.peaks.right, 0],
      [0, this.peaks.accel],
      [0, -this.peaks.brake],
    ]) {
      const [px, py] = toCanvas(x, y);
      context.beginPath();
      context.arc(px, py, 6, 0, Math.PI * 2);
      context.fill();
    }

    if (this.trail.length > 1) {
      context.strokeStyle = "rgba(255,122,47,0.45)";
      context.lineWidth = 4;
      context.beginPath();
      this.trail.forEach((point, index) => {
        const [x, y] = toCanvas(point.x, point.y);
        if (index) context.lineTo(x, y);
        else context.moveTo(x, y);
      });
      context.stroke();
    }

    const [pointX, pointY] = toCanvas(lateral, longitudinal);
    context.fillStyle = ready ? "#ff7a2f" : "rgba(255,122,47,0.25)";
    context.beginPath();
    context.arc(pointX, pointY, 16, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = "#9db0bb";
    context.font = "600 22px Barlow";
    context.textAlign = "center";
    context.fillText("Brake", centerX, centerY + radius + 30);
    context.fillText("Accel", centerX, centerY - radius - 14);
    context.fillText("L", centerX - radius - 20, centerY + 7);
    context.fillText("R", centerX + radius + 20, centerY + 7);
    context.font = "600 16px Barlow";
    context.fillText("1 g", centerX + scale * 0.72, centerY - scale * 0.72);

    this.el.gLat.textContent = ready ? formatG(lateral) : "-- g";
    this.el.gLong.textContent = ready ? formatG(longitudinal) : "-- g";
    this.el.gTotal.textContent = ready ? formatG(Math.hypot(lateral, longitudinal)) : "-- g";
    this.el.gPeakLeft.textContent = formatG(this.peaks.left);
    this.el.gPeakRight.textContent = formatG(this.peaks.right);
    this.el.gPeakBrake.textContent = formatG(this.peaks.brake);
    this.el.gPeakAccel.textContent = formatG(this.peaks.accel);
  }

  // ---------- Map tab ----------

  ensureMap() {
    if (this.map || typeof L === "undefined") return;
    this.map = L.map(this.el.mapMount, { zoomControl: false, attributionControl: true, preferCanvas: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(this.map);
    this.map.setView([0, 0], 2);
    this.trailLine = L.polyline(this.trailPoints, { color: "#ff7a2f", weight: 4 }).addTo(this.map);
    this.gateLayer = L.layerGroup().addTo(this.map);
    // Added to the map on the first position, so nothing is drawn at 0,0 before GNSS is live.
    this.marker = L.marker([0, 0], {
      icon: L.divIcon({ className: "heading-marker", html: '<div class="heading-arrow"></div>', iconSize: [28, 28] }),
    });
    this.map.on("dragstart", () => {
      this.follow = false;
      this.el.followButton.classList.remove("active");
    });
    this.hasCentered = false;
    this.drawGates(this.gates);
  }

  setGates(gates) {
    this.gates = gates;
    this.drawGates(gates);
  }

  drawGates(gates) {
    if (!this.gateLayer) return;
    this.gateLayer.clearLayers();
    for (const gate of gates ?? []) {
      L.polyline([
        [gate.a.lat, gate.a.lon],
        [gate.b.lat, gate.b.lon],
      ], { color: gate.color ?? "#ffffff", weight: 5 }).addTo(this.gateLayer);
    }
  }

  // estimate: fused position {lat, lon, course}. The trail is recorded even while the tab is hidden.
  updatePosition(estimate, now) {
    if (!estimate || now - this.lastMapUpdate < MAP_UPDATE_MS) return;
    this.lastMapUpdate = now;
    this.trailPoints.push([estimate.lat, estimate.lon]);
    if (this.trailPoints.length > MAP_TRAIL_POINTS) this.trailPoints.shift();
    if (!this.map || this.tab !== "map") return;
    this.trailLine.setLatLngs(this.trailPoints);
    this.marker.setLatLng([estimate.lat, estimate.lon]);
    if (!this.hasCentered) this.marker.addTo(this.map);
    const arrow = this.marker.getElement()?.querySelector(".heading-arrow");
    if (arrow) {
      arrow.style.transform = `rotate(${estimate.course ?? 0}deg)`;
      arrow.classList.toggle("no-heading", estimate.course == null);
    }
    if (!this.hasCentered) {
      this.map.setView([estimate.lat, estimate.lon], 17);
      this.hasCentered = true;
    } else if (this.follow) {
      this.map.panTo([estimate.lat, estimate.lon], { animate: false });
    }
  }
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mmss = `${String(minutes).padStart(hours ? 2 : 1, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours ? `${hours}:${mmss}` : mmss;
}
