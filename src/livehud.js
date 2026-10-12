import { formatDelta, formatLapTime } from "./analysis.js";

const TRAIL_MS = 1500;
const G_RANGE = 1.6;

function formatG(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)} g` : "-- g";
}

export class LiveHud {
  constructor(root) {
    this.root = root;
    this.canvas = root.querySelector("#gForceCanvas");
    this.elements = {
      lapClock: root.querySelector("#lapClock"),
      deltaPill: root.querySelector("#deltaPill"),
      lastLap: root.querySelector("#lastLap"),
      bestLap: root.querySelector("#bestLap"),
      lapNumber: root.querySelector("#lapNumber"),
      driftAngle: root.querySelector("#driftAngle"),
      driftDirection: root.querySelector("#driftDirection"),
      driftChainScore: root.querySelector("#driftChainScore"),
      driftLastScore: root.querySelector("#driftLastScore"),
      driftBestScore: root.querySelector("#driftBestScore"),
      lateralG: root.querySelector("#lateralG"),
      longitudinalG: root.querySelector("#longitudinalG"),
      verticalG: root.querySelector("#verticalG"),
      gNote: root.querySelector("#gNote"),
      lapFlash: root.querySelector("#lapFlash"),
    };
    this.trail = [];
    this.flashTimer = null;
  }

  setMode(mode) {
    this.root.dataset.mode = mode;
  }

  resetTiming() {
    this.updateTrack({ lapSeconds: null, delta: null, lastLap: null, bestLap: null, lapNumber: 0 });
    this.updateDrift({ angle: null, chainScore: null, lastScore: null, bestScore: null });
  }

  updateTrack({ lapSeconds, delta, lastLap, bestLap, lapNumber }) {
    const { lapClock, deltaPill } = this.elements;
    lapClock.textContent = lapSeconds == null ? "--:--.-" : formatLapTime(lapSeconds, 1);
    deltaPill.textContent = delta == null ? "delta --" : formatDelta(delta);
    deltaPill.classList.toggle("ahead", delta != null && delta < 0);
    deltaPill.classList.toggle("behind", delta != null && delta >= 0);
    this.elements.lastLap.textContent = formatLapTime(lastLap);
    this.elements.bestLap.textContent = formatLapTime(bestLap);
    this.elements.lapNumber.textContent = String(lapNumber ?? 0);
  }

  updateDrift({ angle, chainScore, lastScore, bestScore }) {
    const { driftAngle, driftDirection } = this.elements;
    driftAngle.textContent = Number.isFinite(angle) ? Math.abs(angle).toFixed(0) : "--";
    driftDirection.textContent = Number.isFinite(angle) && Math.abs(angle) >= 3 ? (angle > 0 ? "L" : "R") : "";
    this.root.classList.toggle("drifting", chainScore != null);
    this.elements.driftChainScore.textContent = chainScore == null ? "--" : String(chainScore);
    this.elements.driftLastScore.textContent = lastScore == null ? "--" : String(lastScore);
    this.elements.driftBestScore.textContent = bestScore == null ? "--" : String(bestScore);
  }

  flash(text, tone = "neutral") {
    const element = this.elements.lapFlash;
    element.textContent = text;
    element.dataset.tone = tone;
    element.hidden = false;
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      element.hidden = true;
    }, 4000);
  }

  drawG(projection, now) {
    const context = this.canvas.getContext("2d");
    const { width, height } = this.canvas;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) * 0.34;
    const scale = radius / G_RANGE;
    const ready = projection?.forwardReady;
    const lateral = ready ? projection.latG : 0;
    const longitudinal = ready ? projection.longG : 0;

    if (ready) {
      this.trail.push({ t: now, x: lateral, y: longitudinal });
    }
    while (this.trail.length && now - this.trail[0].t > TRAIL_MS) this.trail.shift();

    const toCanvas = (x, y) => [
      centerX + Math.max(-G_RANGE, Math.min(G_RANGE, x)) * scale,
      centerY - Math.max(-G_RANGE, Math.min(G_RANGE, y)) * scale,
    ];

    context.clearRect(0, 0, width, height);
    context.strokeStyle = "rgba(255,255,255,0.16)";
    context.lineWidth = 2;
    for (const ring of [1, 0.5]) {
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

    if (this.trail.length > 1) {
      context.strokeStyle = "rgba(255,122,47,0.45)";
      context.lineWidth = 3;
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
    context.arc(pointX, pointY, 12, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = "#9db0bb";
    context.font = "600 14px Barlow";
    context.textAlign = "center";
    context.fillText("Brake", centerX, centerY + radius + 24);
    context.fillText("Accel", centerX, centerY - radius - 14);
    context.fillText("L", centerX - radius - 16, centerY + 4);
    context.fillText("R", centerX + radius + 16, centerY + 4);
    context.fillText("1 g", centerX + scale * 0.72, centerY - scale * 0.72);

    this.elements.lateralG.textContent = ready ? formatG(lateral) : "-- g";
    this.elements.longitudinalG.textContent = ready ? formatG(longitudinal) : "-- g";
    this.elements.verticalG.textContent = projection?.gravityReady ? formatG(projection.vertG) : "-- g";
  }

  setGNote(text) {
    this.elements.gNote.textContent = text;
  }
}
