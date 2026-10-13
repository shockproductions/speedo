import { formatLapTime } from "./analysis.js";
import { MapView } from "./mapview.js";
import { speedFactor, speedUnit } from "./settings.js";

const RATES = [0.5, 1, 2, 4, 8, 16];

function clock(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, "0")}`;
}

// Plays a session back from the 10 Hz analysis series: marker on the map, live gauges, scrubber.
export class Replay {
  constructor(container, run, { units, gates, onCursor }) {
    this.container = container;
    this.run = run;
    this.units = units;
    this.gates = gates;
    this.onCursor = onCursor;
    this.series = run.analysis.series;
    this.laps = run.analysis.laps;
    this.playing = false;
    this.rate = 1;
    this.frame = null;
    this.render();
  }

  render() {
    const series = this.series;
    if (!series.length) {
      this.container.innerHTML = '<div class="details-empty"><p>Nothing to replay: no positions recorded.</p></div>';
      return;
    }
    this.t0 = series[0].t;
    this.t1 = series[series.length - 1].t;
    this.t = this.t0;
    const lapOptions = this.laps
      .map((lap) => `<option value="${lap.start}">Lap ${lap.number} (${formatLapTime(lap.time)})</option>`)
      .join("");
    this.container.innerHTML = `
      <div class="replay">
        <section class="replay-map"></section>
        <div class="replay-gauges">
          <article class="replay-gauge replay-speed"><span class="label">Speed</span><strong data-r="speed">0</strong><small>${speedUnit(this.units)}</small></article>
          <article class="replay-gauge"><span class="label">Lap</span><strong data-r="lap">-</strong><small data-r="laptime">--</small></article>
          <article class="replay-gauge"><span class="label">Long / Lat</span><strong data-r="g">--</strong><small data-r="drift"></small></article>
          <canvas class="replay-g" width="160" height="160"></canvas>
        </div>
        <div class="replay-controls">
          <button type="button" class="primary-button replay-play" data-r="play">Play</button>
          <select data-r="rate" class="replay-rate">${RATES.map((rate) => `<option value="${rate}"${rate === 1 ? " selected" : ""}>${rate}x</option>`).join("")}</select>
          ${lapOptions ? `<select data-r="lapjump" class="replay-rate"><option value="">Jump to...</option>${lapOptions}</select>` : ""}
          <span class="replay-time" data-r="time">0:00.0</span>
        </div>
        <input type="range" class="replay-scrubber" data-r="scrub" min="${this.t0}" max="${this.t1}" step="0.1" value="${this.t0}" />
      </div>`;
    const $ = (name) => this.container.querySelector(`[data-r="${name}"]`);
    this.el = {
      speed: $("speed"),
      lap: $("lap"),
      lapTime: $("laptime"),
      g: $("g"),
      drift: $("drift"),
      play: $("play"),
      rate: $("rate"),
      lapJump: $("lapjump"),
      time: $("time"),
      scrub: $("scrub"),
      canvas: this.container.querySelector(".replay-g"),
    };

    this.mapView = new MapView(this.container.querySelector(".replay-map"));
    this.mapView.render({
      points: series.filter((_, index) => index % 2 === 0).map((row) => ({ lat: row.la, lon: row.lo, v: row.v })),
      gates: this.gates,
    });
    this.mapView.useHeadingMarker();

    this.el.play.addEventListener("click", () => (this.playing ? this.pause() : this.play()));
    this.el.rate.addEventListener("change", () => {
      this.rate = Number(this.el.rate.value);
    });
    this.el.lapJump?.addEventListener("change", () => {
      if (this.el.lapJump.value) this.seek(Number(this.el.lapJump.value));
      this.el.lapJump.value = "";
    });
    this.el.scrub.addEventListener("input", () => this.seek(Number(this.el.scrub.value)));
    this.seek(this.t0);
  }

  play() {
    if (this.t >= this.t1) this.t = this.t0;
    this.playing = true;
    this.el.play.textContent = "Pause";
    let last = performance.now();
    const step = (now) => {
      if (!this.playing) return;
      this.seek(this.t + ((now - last) / 1000) * this.rate);
      last = now;
      if (this.t >= this.t1) {
        this.pause();
        return;
      }
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  pause() {
    this.playing = false;
    this.el.play.textContent = "Play";
    cancelAnimationFrame(this.frame);
  }

  seek(t) {
    this.t = Math.min(this.t1, Math.max(this.t0, t));
    const series = this.series;
    const row = series[Math.min(series.length - 1, Math.max(0, Math.round((this.t - this.t0) / 0.1)))];
    if (!row) return;
    this.el.scrub.value = String(this.t);
    this.el.time.textContent = `${clock(this.t - this.t0)} / ${clock(this.t1 - this.t0)}`;
    this.el.speed.textContent = Math.round(row.v * speedFactor(this.units)).toString();
    const lap = this.laps.find((item) => this.t >= item.start && this.t < item.end);
    this.el.lap.textContent = lap ? String(lap.number) : "-";
    this.el.lapTime.textContent = lap ? formatLapTime(this.t - lap.start, 1) : "--";
    this.el.g.textContent = Number.isFinite(row.lon) ? `${row.lon.toFixed(2)} / ${row.lat.toFixed(2)}` : "--";
    this.el.drift.textContent = Number.isFinite(row.beta) && Math.abs(row.beta) >= 5 ? `drift ${Math.abs(row.beta).toFixed(0)}° ${row.beta > 0 ? "L" : "R"}` : "";
    this.mapView.setCursor(row.la, row.lo, row.hdg);
    this.drawG(row);
    this.onCursor?.(row);
  }

  drawG(row) {
    const context = this.el.canvas.getContext("2d");
    const { width, height } = this.el.canvas;
    const cx = width / 2;
    const cy = height / 2;
    const scale = (Math.min(width, height) * 0.42) / 1.5;
    context.clearRect(0, 0, width, height);
    context.strokeStyle = "rgba(255,255,255,0.18)";
    context.lineWidth = 1.5;
    for (const ring of [1.5, 1, 0.5]) {
      context.beginPath();
      context.arc(cx, cy, scale * ring, 0, Math.PI * 2);
      context.stroke();
    }
    if (!Number.isFinite(row.lon)) return;
    const index = Math.round((row.t - this.t0) / 0.1);
    context.strokeStyle = "rgba(255,122,47,0.45)";
    context.lineWidth = 3;
    context.beginPath();
    for (let k = Math.max(0, index - 15); k <= index; k += 1) {
      const sample = this.series[k];
      if (!sample || !Number.isFinite(sample.lon)) continue;
      const x = cx + Math.max(-1.5, Math.min(1.5, sample.lat)) * scale;
      const y = cy - Math.max(-1.5, Math.min(1.5, sample.lon)) * scale;
      if (k === Math.max(0, index - 15)) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
    context.fillStyle = "#ff7a2f";
    context.beginPath();
    context.arc(cx + Math.max(-1.5, Math.min(1.5, row.lat)) * scale, cy - Math.max(-1.5, Math.min(1.5, row.lon)) * scale, 7, 0, Math.PI * 2);
    context.fill();
  }

  destroy() {
    this.pause();
    this.mapView?.destroy();
  }
}
