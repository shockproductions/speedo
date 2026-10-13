import { formatDelta, formatDuration, formatLapTime, formatNumber } from "./analysis.js";
import { bearingDegrees, haversineMeters } from "./geo.js";
import { GraphsTab } from "./graphbuilder.js";
import { createGate } from "./laptiming.js";
import { CHANNELS_3D, Map3D } from "./map3d.js";
import { MapView } from "./mapview.js";
import { Replay } from "./replay.js";
import { formatDistance, formatSpeed, speedFactor, speedUnit } from "./settings.js";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function stat(label, value) {
  return `<article class="detail-stat"><span>${label}</span><strong>${value}</strong></article>`;
}

const TABS = [
  ["overview", "Overview"],
  ["map", "Map"],
  ["graphs", "Graphs"],
  ["replay", "Replay"],
];

// Post-processing view for one session.
export class AnalysisView {
  constructor(container, callbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.run = null;
    this.tab = "overview";
    this.selection = { lapA: null, lapB: null };
    this.mapMode = "2d";
    this.channel3d = "speed";
    this.terrain = false;
    this.pickMode = null;
    this.children = [];
  }

  get units() {
    return this.callbacks.getUnits();
  }

  destroy() {
    for (const child of this.children) child.destroy?.();
    this.children = [];
  }

  render(run, { keepSelection = false } = {}) {
    const sameRun = this.run?.id === run.id;
    this.run = run;
    if (!keepSelection || !sameRun || !run.analysis.laps.some((lap) => lap.number === this.selection.lapA)) {
      this.selection = { lapA: run.analysis.summary.bestLapNumber ?? null, lapB: null };
    }
    this.container.innerHTML = `
      <nav class="sub-tabs" role="tablist">
        ${TABS.map(([id, label]) => `<button type="button" class="sub-tab${id === this.tab ? " active" : ""}" data-tab="${id}">${label}</button>`).join("")}
      </nav>
      <div class="sub-pane"></div>`;
    for (const button of this.container.querySelectorAll(".sub-tab")) {
      button.addEventListener("click", () => this.showTab(button.dataset.tab));
    }
    this.showTab(this.tab);
  }

  showTab(tab) {
    this.tab = tab;
    this.destroy();
    this.pickMode = null;
    for (const button of this.container.querySelectorAll(".sub-tab")) {
      button.classList.toggle("active", button.dataset.tab === tab);
    }
    const pane = this.container.querySelector(".sub-pane");
    if (tab === "overview") this.renderOverview(pane);
    else if (tab === "map") this.renderMap(pane);
    else if (tab === "graphs") {
      this.children.push(
        new GraphsTab(pane, { run: this.run, units: this.units, selection: this.selection }),
      );
    } else if (tab === "replay") {
      this.children.push(new Replay(pane, this.run, { units: this.units, gates: this.gates() }));
    }
  }

  gates() {
    const track = this.run.analysis.track;
    if (!track) return [];
    return [
      { ...track.startFinish, color: "#ffffff", label: "S/F" },
      ...(track.sectors ?? []).map((gate, index) => ({ ...gate, color: "#c792ea", label: `S${index + 1}` })),
    ];
  }

  // ---------- Overview ----------

  renderOverview(pane) {
    pane.innerHTML = `
      <div class="detail-grid">${this.summaryMarkup()}</div>
      ${this.trackMarkup()}
      ${this.lapTableMarkup()}
      ${this.driftMarkup()}`;
    pane.querySelector('[data-action="assign"]')?.addEventListener("change", (event) => {
      this.callbacks.assignTrack(this.run, event.target.value);
    });
    pane.querySelector('[data-action="edit-track"]')?.addEventListener("click", () => this.showTab("map"));
    for (const button of pane.querySelectorAll("[data-lap-a]")) {
      button.addEventListener("click", () => {
        this.selection.lapA = Number(button.dataset.lapA);
        if (this.selection.lapB === this.selection.lapA) this.selection.lapB = null;
        this.refreshChips(pane);
      });
    }
    for (const button of pane.querySelectorAll("[data-lap-b]")) {
      button.addEventListener("click", () => {
        const number = Number(button.dataset.lapB);
        this.selection.lapB = this.selection.lapB === number || this.selection.lapA === number ? null : number;
        this.refreshChips(pane);
      });
    }
  }

  refreshChips(pane) {
    for (const button of pane.querySelectorAll("[data-lap-a]")) {
      button.classList.toggle("chip-a", Number(button.dataset.lapA) === this.selection.lapA);
    }
    for (const button of pane.querySelectorAll("[data-lap-b]")) {
      button.classList.toggle("chip-b", Number(button.dataset.lapB) === this.selection.lapB);
    }
  }

  summaryMarkup() {
    const { summary, laps, calibrationQuality, hasG, drift, calibration, gnssLagMs } = this.run.analysis;
    const units = this.units;
    const gSuffix = summary.gSource === "gnss" ? " (GPS est.)" : "";
    const parts = [
      stat("Duration", formatDuration(summary.durationSeconds * 1000)),
      stat("Distance", formatDistance(summary.distanceMeters, units)),
      stat("Max Speed", formatSpeed(summary.maxSpeedKmh, units, 1)),
    ];
    if (laps.length) {
      parts.push(
        stat("Best Lap", `${formatLapTime(summary.bestLap)} <small>(L${summary.bestLapNumber})</small>`),
        stat("Laps", String(summary.lapCount)),
        stat("Average Lap", formatLapTime(summary.averageLap)),
      );
      if (Number.isFinite(summary.theoreticalBest)) parts.push(stat("Theoretical Best", formatLapTime(summary.theoreticalBest)));
    }
    parts.push(
      stat(`Max Lateral${gSuffix}`, formatNumber(summary.maxLatG, 2, " g")),
      stat(`Peak Braking${gSuffix}`, formatNumber(summary.peakBrakeG, 2, " g")),
      stat(`Peak Accel${gSuffix}`, formatNumber(summary.peakAccelG, 2, " g")),
    );
    if (drift.chains.length) {
      parts.push(
        stat("Drift Score", String(summary.driftScore)),
        stat("Best Drift", String(summary.bestDriftScore)),
        stat("Max Angle", formatNumber(summary.maxDriftAngle, 0, "&deg;")),
      );
    }
    if (Number.isFinite(summary.zeroToHundredSeconds)) parts.push(stat("0-100 km/h", formatNumber(summary.zeroToHundredSeconds, 2, " s")));
    if (Number.isFinite(summary.quarterMileSeconds)) parts.push(stat("1/4 Mile", formatNumber(summary.quarterMileSeconds, 2, " s")));
    const alignment = { trajectory: "trajectory", solver: "GPS solver", live: "live" }[calibration?.alignment] ?? "";
    parts.push(
      stat("IMU Alignment", hasG ? `${Math.round((calibrationQuality ?? 0) * 100)}% fit${alignment ? ` <small>(${alignment})</small>` : ""}` : "GPS only"),
    );
    if (Number.isFinite(gnssLagMs)) parts.push(stat("GNSS Latency", `${gnssLagMs} ms`));
    return parts.join("");
  }

  trackMarkup() {
    const track = this.run.analysis.track;
    const tracks = this.callbacks.getTracks();
    const assigned = this.run.trackId ?? "auto";
    const options = [
      `<option value="auto"${assigned === "auto" ? " selected" : ""}>Auto (nearest saved track)</option>`,
      ...tracks.map((item) => `<option value="${escapeHtml(item.id)}"${assigned === item.id ? " selected" : ""}>${escapeHtml(item.name)}</option>`),
      `<option value="none"${assigned === "none" ? " selected" : ""}>No lap timing</option>`,
    ].join("");
    const label = track ? (track.id ? escapeHtml(track.name) : "Auto start/finish (not saved)") : "No start/finish line";
    return `
      <section class="track-bar">
        <div class="track-bar-head">
          <div><p class="eyebrow">Track</p><strong>${label}</strong></div>
          <label class="field compact-field"><span>Lap timing source</span><select data-action="assign">${options}</select></label>
        </div>
        <div class="detail-actions">
          <button class="secondary-button" data-action="edit-track" type="button">Edit Lines on Map</button>
        </div>
      </section>`;
  }

  lapTableMarkup() {
    const { laps, summary, outLap, inLap } = this.run.analysis;
    if (!laps.length) {
      return '<div class="details-empty"><p>No laps detected. Open the Map tab to set a start/finish line, or save a track.</p></div>';
    }
    const sectorCount = Math.max(0, ...laps.map((lap) => lap.sectors?.length ?? 0));
    const bestSectors = summary.bestSectors ?? [];
    const factor = speedFactor(this.units);
    const head = `<tr><th>Lap</th><th>Time</th><th>&Delta;</th>${Array.from({ length: sectorCount }, (_, i) => `<th>S${i + 1}</th>`).join("")}<th>Top ${speedUnit(this.units)}</th><th>Max lat</th><th>Compare</th></tr>`;
    const rows = laps.map((lap) => {
      const best = lap.number === summary.bestLapNumber;
      const sectors = Array.from({ length: sectorCount }, (_, index) => {
        const value = lap.sectors?.[index];
        const purple = Number.isFinite(value) && Math.abs(value - bestSectors[index]) < 1e-6;
        return `<td class="${purple ? "best-sector" : ""}">${Number.isFinite(value) ? value.toFixed(2) : "-"}</td>`;
      }).join("");
      return `
        <tr class="${best ? "best-lap" : ""}">
          <td>${lap.number}</td>
          <td><strong>${formatLapTime(lap.time)}</strong></td>
          <td>${best ? "best" : formatDelta(lap.time - summary.bestLap)}</td>
          ${sectors}
          <td>${formatNumber(lap.topSpeedKmh * factor, 0)}</td>
          <td>${formatNumber(lap.maxLatG, 2)}</td>
          <td class="compare-cell">
            <button type="button" class="chip${this.selection.lapA === lap.number ? " chip-a" : ""}" data-lap-a="${lap.number}">A</button>
            <button type="button" class="chip${this.selection.lapB === lap.number ? " chip-b" : ""}" data-lap-b="${lap.number}">B</button>
          </td>
        </tr>`;
    }).join("");
    const partial = [outLap ? `Out-lap ${formatLapTime(outLap.time, 1)}` : null, inLap ? `In-lap ${formatLapTime(inLap.time, 1)}` : null]
      .filter(Boolean).join(" &middot; ");
    return `
      <section class="lap-table-wrap">
        <table class="lap-table"><thead>${head}</thead><tbody>${rows}</tbody></table>
        <p class="table-note">${partial ? `${partial} (not counted). ` : ""}A/B picks the laps compared in Graphs.</p>
      </section>`;
  }

  driftMarkup() {
    const chains = this.run.analysis.drift.chains;
    if (!chains.length) return "";
    const best = Math.max(...chains.map((chain) => chain.score));
    const rows = chains.map((chain, index) => `
      <tr class="${chain.score === best ? "best-lap" : ""}">
        <td>${index + 1}</td><td>${formatDuration(chain.start * 1000)}</td>
        <td>${chain.direction}${chain.transitions ? ` +${chain.transitions}` : ""}</td>
        <td>${chain.duration.toFixed(1)} s</td><td>${chain.peakAngle.toFixed(0)}&deg;</td><td>${chain.averageAngle.toFixed(0)}&deg;</td>
        <td>${formatSpeed(chain.averageSpeedKmh, this.units)}</td><td><strong>${chain.score}</strong></td>
      </tr>`).join("");
    return `
      <section class="lap-table-wrap">
        <h3 class="table-title">Drifts</h3>
        <table class="lap-table">
          <thead><tr><th>#</th><th>At</th><th>Dir</th><th>Length</th><th>Peak</th><th>Avg</th><th>Speed</th><th>Score</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="table-note">Score = angle &times; speed &times; time, +10% per transition.</p>
      </section>`;
  }

  // ---------- Map ----------

  renderMap(pane) {
    const laps = this.run.analysis.laps;
    const savedTrack = Boolean(this.run.analysis.track?.id);
    const hasAutoTrack = this.run.analysis.track && !savedTrack;
    pane.innerHTML = `
      <div class="map-toolbar">
        <div class="segmented">
          <button type="button" data-mode="2d" class="${this.mapMode === "2d" ? "active" : ""}">2D</button>
          <button type="button" data-mode="3d" class="${this.mapMode === "3d" ? "active" : ""}">3D</button>
        </div>
        <label class="field compact-field"><span>Show</span>
          <select data-action="lap">
            <option value="">Whole session</option>
            ${laps.map((lap) => `<option value="${lap.number}"${lap.number === this.selection.lapA ? " selected" : ""}>Lap ${lap.number} - ${formatLapTime(lap.time)}</option>`).join("")}
          </select>
        </label>
        ${this.mapMode === "3d" ? `
          <label class="field compact-field"><span>Height &amp; colour</span>
            <select data-action="channel">${Object.entries(CHANNELS_3D).map(([key, channel]) => `<option value="${key}"${key === this.channel3d ? " selected" : ""}>${channel.label}</option>`).join("")}</select>
          </label>
          <label class="toggle"><input type="checkbox" data-action="terrain"${this.terrain ? " checked" : ""}/> Terrain</label>` : ""}
      </div>
      ${this.mapMode === "2d" ? `
        <div class="detail-actions track-tools">
          ${hasAutoTrack ? '<button class="secondary-button" data-action="save-track" type="button">Save as Track</button>' : ""}
          <button class="secondary-button" data-action="pick-sf" type="button">Set Start/Finish</button>
          <button class="secondary-button" data-action="pick-sector" type="button"${savedTrack ? "" : " disabled"}>Add Sector</button>
          ${savedTrack && this.run.analysis.track.sectors.length ? '<button class="secondary-button" data-action="clear-sectors" type="button">Clear Sectors</button>' : ""}
        </div>
        <p class="pick-hint" hidden></p>` : ""}
      <section class="map-mount"></section>`;

    for (const button of pane.querySelectorAll(".segmented button")) {
      button.addEventListener("click", () => {
        this.mapMode = button.dataset.mode;
        this.showTab("map");
      });
    }
    const lapSelect = pane.querySelector('[data-action="lap"]');
    const drawMap = () => this.drawMap(pane, lapSelect.value ? Number(lapSelect.value) : null);
    lapSelect.addEventListener("change", drawMap);
    pane.querySelector('[data-action="channel"]')?.addEventListener("change", (event) => {
      this.channel3d = event.target.value;
      drawMap();
    });
    pane.querySelector('[data-action="terrain"]')?.addEventListener("change", (event) => {
      this.terrain = event.target.checked;
      drawMap();
    });
    this.bindTrackTools(pane);
    drawMap();
  }

  drawMap(pane, lapNumber) {
    for (const child of this.children) child.destroy?.();
    this.children = [];
    const mount = pane.querySelector(".map-mount");
    const lap = this.run.analysis.laps.find((item) => item.number === lapNumber);
    const rows = this.run.analysis.series.filter((row) => !lap || (row.t >= lap.start && row.t <= lap.end));
    if (this.mapMode === "3d") {
      const view = new Map3D(mount);
      this.children.push(view);
      view.render({ rows, gates: this.gates(), channel: this.channel3d, terrain: this.terrain });
    } else {
      const view = new MapView(mount);
      this.children.push(view);
      this.mapView = view;
      view.render({ points: rows.map((row) => ({ lat: row.la, lon: row.lo, v: row.v })), gates: this.gates() });
    }
  }

  bindTrackTools(pane) {
    const hint = pane.querySelector(".pick-hint");
    if (!hint) return;
    pane.querySelector('[data-action="save-track"]')?.addEventListener("click", () => {
      const name = window.prompt("Track name", "My track");
      if (!name) return;
      const { auto: _auto, ...gate } = this.run.analysis.track.startFinish;
      this.callbacks.saveTrackForRun(this.run, { name, startFinish: gate, sectors: [] });
    });
    pane.querySelector('[data-action="clear-sectors"]')?.addEventListener("click", () => {
      this.callbacks.updateTrack(this.run, { sectors: [] });
    });
    const startPick = (mode, message) => {
      this.pickMode = mode;
      hint.hidden = false;
      hint.textContent = message;
      this.mapView?.setPickHandler((position) => this.handlePick(position, hint));
    };
    pane.querySelector('[data-action="pick-sf"]').addEventListener("click", () =>
      startPick("sf", "Tap the map where the start/finish line should be. It snaps to your driven line."),
    );
    pane.querySelector('[data-action="pick-sector"]').addEventListener("click", () =>
      startPick("sector", "Tap the map where the sector line should be."),
    );
  }

  // Snap a map tap to the nearest recorded point and build a gate across the driving direction.
  handlePick(position, hint) {
    const points = this.run.analysis.points;
    let bestIndex = -1;
    let bestDistance = Infinity;
    points.forEach((point, index) => {
      const distance = haversineMeters(point, position);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    if (bestIndex < 0 || bestDistance > 60) {
      hint.textContent = "Too far from the recorded line. Tap closer to where you drove.";
      return;
    }
    const point = points[bestIndex];
    const heading = point.course ?? bearingDegrees(points[Math.max(0, bestIndex - 1)], points[Math.min(points.length - 1, bestIndex + 1)]);
    const gate = createGate(point, heading);
    this.mapView.setPickHandler(null);
    if (this.pickMode === "sf") {
      if (this.run.analysis.track?.id) {
        this.callbacks.updateTrack(this.run, { startFinish: gate, bestLap: null });
      } else {
        const name = window.prompt("Name this track", "My track");
        if (name) this.callbacks.saveTrackForRun(this.run, { name, startFinish: gate, sectors: [] });
      }
    } else if (this.pickMode === "sector") {
      const sectors = [...(this.run.analysis.track.sectors ?? []), gate];
      this.callbacks.updateTrack(this.run, { sectors: this.orderSectors(sectors) });
    }
    this.pickMode = null;
  }

  orderSectors(sectors) {
    const lap = this.run.analysis.laps[0];
    if (!lap) return sectors;
    const lapPoints = this.run.analysis.points.filter((point) => point.t >= lap.start && point.t <= lap.end);
    const progress = (gate) => {
      let best = 0;
      let bestDistance = Infinity;
      lapPoints.forEach((point, index) => {
        const distance = haversineMeters(point, gate.center);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      });
      return best;
    };
    return [...sectors].sort((a, b) => progress(a) - progress(b));
  }
}
