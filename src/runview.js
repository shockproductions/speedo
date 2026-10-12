import { formatDelta, formatDuration, formatLapTime, formatNumber } from "./analysis.js";
import { ChartPanel, SERIES_COLORS } from "./charts.js";
import { bearingDegrees, haversineMeters } from "./geo.js";
import { createGate } from "./laptiming.js";
import { MapView } from "./mapview.js";
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

function interpolateTimeAtDistance(rows, distance) {
  let low = 0;
  let high = rows.length - 1;
  if (distance <= rows[0].x) return rows[0].t;
  if (distance >= rows[high].x) return rows[high].t;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (rows[middle].x < distance) low = middle;
    else high = middle;
  }
  const a = rows[low];
  const b = rows[high];
  const fraction = b.x > a.x ? (distance - a.x) / (b.x - a.x) : 0;
  return a.t + (b.t - a.t) * fraction;
}

function decimate(rows, maxPoints = 1500) {
  if (rows.length <= maxPoints) return rows;
  const step = rows.length / maxPoints;
  const result = [];
  for (let index = 0; index < rows.length; index += step) result.push(rows[Math.floor(index)]);
  return result;
}

export class RunView {
  constructor(container, callbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.mapView = null;
    this.charts = null;
    this.run = null;
    this.lapA = null;
    this.lapB = null;
    this.pickMode = null;
  }

  get units() {
    return this.callbacks.getUnits();
  }

  render(run, { keepSelection = false } = {}) {
    const sameRun = this.run?.id === run.id;
    this.run = run;
    this.pickMode = null;
    const laps = run.analysis.laps;
    if (!keepSelection || !sameRun || !laps.some((lap) => lap.number === this.lapA)) {
      this.lapA = run.analysis.summary.bestLapNumber ?? null;
      this.lapB = null;
    }

    this.container.innerHTML = `
      <div class="detail-grid">${this.summaryMarkup()}</div>
      ${this.trackBarMarkup()}
      <section class="map-mount"></section>
      ${this.lapTableMarkup()}
      <section class="chart-grid chart-mount"></section>
      ${this.driftMarkup()}
    `;
    this.bindTrackBar();
    this.bindLapTable();
    this.mapView = new MapView(this.container.querySelector(".map-mount"));
    this.charts = new ChartPanel(this.container.querySelector(".chart-mount"));
    this.renderVisuals();
  }

  destroy() {
    this.charts?.destroy();
    this.mapView?.destroy();
  }

  summaryMarkup() {
    const { summary, laps, calibrationQuality, hasG, drift } = this.run.analysis;
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
      if (Number.isFinite(summary.theoreticalBest)) {
        parts.push(stat("Theoretical Best", formatLapTime(summary.theoreticalBest)));
      }
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
    if (Number.isFinite(summary.zeroToHundredSeconds)) {
      parts.push(stat("0-100 km/h", formatNumber(summary.zeroToHundredSeconds, 2, " s")));
    }
    if (Number.isFinite(summary.quarterMileSeconds)) {
      parts.push(stat("1/4 Mile", formatNumber(summary.quarterMileSeconds, 2, " s")));
    }
    parts.push(
      stat(
        "IMU Calibration",
        hasG ? `${Math.round((calibrationQuality ?? 0) * 100)}% fit` : "GPS only",
      ),
    );
    return parts.join("");
  }

  trackBarMarkup() {
    const track = this.run.analysis.track;
    const tracks = this.callbacks.getTracks();
    const assigned = this.run.trackId ?? "auto";
    const options = [
      `<option value="auto"${assigned === "auto" ? " selected" : ""}>Auto (nearest saved track)</option>`,
      ...tracks.map(
        (item) =>
          `<option value="${escapeHtml(item.id)}"${assigned === item.id ? " selected" : ""}>${escapeHtml(item.name)}</option>`,
      ),
      `<option value="none"${assigned === "none" ? " selected" : ""}>No lap timing</option>`,
    ].join("");
    const label = track
      ? track.id
        ? escapeHtml(track.name)
        : "Auto start/finish (not saved)"
      : "No start/finish line";
    const saved = Boolean(track?.id);
    return `
      <section class="track-bar">
        <div class="track-bar-head">
          <div>
            <p class="eyebrow">Track</p>
            <strong>${label}</strong>
          </div>
          <label class="field compact-field">
            <span>Lap timing source</span>
            <select data-action="assign">${options}</select>
          </label>
        </div>
        <div class="detail-actions">
          ${track && !saved ? '<button class="secondary-button" data-action="save-track" type="button">Save as Track</button>' : ""}
          <button class="secondary-button" data-action="pick-sf" type="button">Set Start/Finish on Map</button>
          <button class="secondary-button" data-action="pick-sector" type="button" ${saved ? "" : "disabled"}>Add Sector on Map</button>
          ${saved && track.sectors.length ? '<button class="secondary-button" data-action="clear-sectors" type="button">Clear Sectors</button>' : ""}
        </div>
        <p class="pick-hint" hidden></p>
      </section>
    `;
  }

  lapTableMarkup() {
    const { laps, summary, outLap, inLap } = this.run.analysis;
    if (!laps.length) {
      return '<div class="details-empty"><p>No laps detected. Set a start/finish line on the map, or save a track, to time laps.</p></div>';
    }
    const sectorCount = Math.max(0, ...laps.map((lap) => lap.sectors?.length ?? 0));
    const bestSectors = summary.bestSectors ?? [];
    const factor = speedFactor(this.units);
    const head = `
      <tr>
        <th>Lap</th><th>Time</th><th>&Delta;</th>
        ${Array.from({ length: sectorCount }, (_, index) => `<th>S${index + 1}</th>`).join("")}
        <th>Top ${speedUnit(this.units)}</th><th>Max lat</th><th>Compare</th>
      </tr>`;
    const rows = laps
      .map((lap) => {
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
              <button type="button" class="chip${this.lapA === lap.number ? " chip-a" : ""}" data-lap-a="${lap.number}">A</button>
              <button type="button" class="chip${this.lapB === lap.number ? " chip-b" : ""}" data-lap-b="${lap.number}">B</button>
            </td>
          </tr>`;
      })
      .join("");
    const partial = [
      outLap ? `Out-lap ${formatLapTime(outLap.time, 1)}` : null,
      inLap ? `In-lap ${formatLapTime(inLap.time, 1)}` : null,
    ].filter(Boolean).join(" &middot; ");
    return `
      <section class="lap-table-wrap">
        <table class="lap-table"><thead>${head}</thead><tbody>${rows}</tbody></table>
        ${partial ? `<p class="table-note">${partial} (not counted)</p>` : ""}
      </section>`;
  }

  driftMarkup() {
    const chains = this.run.analysis.drift.chains;
    if (!chains.length) {
      return "";
    }
    const best = Math.max(...chains.map((chain) => chain.score));
    const units = this.units;
    const rows = chains
      .map(
        (chain, index) => `
          <tr class="${chain.score === best ? "best-lap" : ""}" data-drift-start="${chain.start}">
            <td>${index + 1}</td>
            <td>${formatDuration(chain.start * 1000)}</td>
            <td>${chain.direction}${chain.transitions ? ` +${chain.transitions}` : ""}</td>
            <td>${chain.duration.toFixed(1)} s</td>
            <td>${chain.peakAngle.toFixed(0)}&deg;</td>
            <td>${chain.averageAngle.toFixed(0)}&deg;</td>
            <td>${formatSpeed(chain.averageSpeedKmh, units)}</td>
            <td><strong>${chain.score}</strong></td>
          </tr>`,
      )
      .join("");
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

  bindTrackBar() {
    const bar = this.container.querySelector(".track-bar");
    const hint = bar.querySelector(".pick-hint");
    bar.querySelector('[data-action="assign"]').addEventListener("change", (event) => {
      this.callbacks.assignTrack(this.run, event.target.value);
    });
    bar.querySelector('[data-action="save-track"]')?.addEventListener("click", () => {
      const name = window.prompt("Track name", "My track");
      if (!name) return;
      const { startFinish } = this.run.analysis.track;
      const { auto: _auto, ...gate } = startFinish;
      this.callbacks.saveTrackForRun(this.run, { name, startFinish: gate, sectors: [] });
    });
    bar.querySelector('[data-action="clear-sectors"]')?.addEventListener("click", () => {
      this.callbacks.updateTrack(this.run, { sectors: [] });
    });

    const startPick = (mode, message) => {
      this.pickMode = mode;
      hint.hidden = false;
      hint.textContent = message;
      this.mapView.setPickHandler((position) => this.handlePick(position));
    };
    bar.querySelector('[data-action="pick-sf"]').addEventListener("click", () =>
      startPick("sf", "Tap the map where the start/finish line should be. It snaps to your driven line."),
    );
    bar.querySelector('[data-action="pick-sector"]').addEventListener("click", () =>
      startPick("sector", "Tap the map where the sector line should be."),
    );
  }

  // Snap a map tap to the nearest recorded point and build a gate across the driving direction.
  handlePick(position) {
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
      this.container.querySelector(".pick-hint").textContent =
        "Too far from the recorded line. Tap closer to where you drove.";
      return;
    }

    const point = points[bestIndex];
    const neighbor = points[Math.min(points.length - 1, bestIndex + 1)];
    const previous = points[Math.max(0, bestIndex - 1)];
    const heading = point.course ?? bearingDegrees(previous, neighbor);
    const gate = createGate(point, heading);
    this.mapView.setPickHandler(null);

    if (this.pickMode === "sf") {
      if (this.run.analysis.track?.id) {
        this.callbacks.updateTrack(this.run, { startFinish: gate, bestLap: null });
      } else {
        const name = window.prompt("Name this track", "My track");
        if (!name) return;
        this.callbacks.saveTrackForRun(this.run, { name, startFinish: gate, sectors: [] });
      }
    } else if (this.pickMode === "sector") {
      const sectors = [...(this.run.analysis.track.sectors ?? []), gate];
      this.callbacks.updateTrack(this.run, { sectors: this.orderSectors(sectors) });
    }
    this.pickMode = null;
  }

  // Sectors must be ordered along the lap; sort by where the first lap passes each gate.
  orderSectors(sectors) {
    const lap = this.run.analysis.laps[0];
    const points = this.run.analysis.points;
    if (!lap) return sectors;
    const lapPoints = points.filter((point) => point.t >= lap.start && point.t <= lap.end);
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

  bindLapTable() {
    for (const button of this.container.querySelectorAll("[data-lap-a]")) {
      button.addEventListener("click", () => {
        const number = Number(button.dataset.lapA);
        this.lapA = number;
        if (this.lapB === number) this.lapB = null;
        this.refreshSelection();
      });
    }
    for (const button of this.container.querySelectorAll("[data-lap-b]")) {
      button.addEventListener("click", () => {
        const number = Number(button.dataset.lapB);
        this.lapB = this.lapB === number || this.lapA === number ? null : number;
        this.refreshSelection();
      });
    }
  }

  refreshSelection() {
    for (const button of this.container.querySelectorAll("[data-lap-a]")) {
      button.classList.toggle("chip-a", Number(button.dataset.lapA) === this.lapA);
    }
    for (const button of this.container.querySelectorAll("[data-lap-b]")) {
      button.classList.toggle("chip-b", Number(button.dataset.lapB) === this.lapB);
    }
    this.renderVisuals();
  }

  lapRows(lapNumber) {
    const lap = this.run.analysis.laps.find((item) => item.number === lapNumber);
    if (!lap) return null;
    const rows = this.run.analysis.series.filter((row) => row.t >= lap.start && row.t <= lap.end);
    if (rows.length < 2) return null;
    const d0 = rows[0].d;
    const t0 = lap.start;
    return { lap, rows: rows.map((row) => ({ ...row, x: row.d - d0, lapT: row.t - t0 })) };
  }

  gates() {
    const track = this.run.analysis.track;
    if (!track) return [];
    return [
      { ...track.startFinish, color: "#ffffff", label: "S/F" },
      ...(track.sectors ?? []).map((gate, index) => ({ ...gate, color: "#c792ea", label: `S${index + 1}` })),
    ];
  }

  renderVisuals() {
    this.charts.destroy();
    const analysis = this.run.analysis;
    const factor = speedFactor(this.units);
    const unit = speedUnit(this.units);
    const selectedA = this.lapA != null ? this.lapRows(this.lapA) : null;
    const selectedB = this.lapB != null ? this.lapRows(this.lapB) : null;

    if (selectedA) {
      const { lap } = selectedA;
      const lapPoints = analysis.points.filter((point) => point.t >= lap.start && point.t <= lap.end);
      this.mapView.render({ points: lapPoints, gates: this.gates() });
      this.renderLapCharts(selectedA, selectedB, factor, unit);
    } else {
      this.mapView.render({ points: analysis.points, gates: this.gates() });
      this.renderSessionCharts(factor, unit);
    }
  }

  renderLapCharts(a, b, factor, unit) {
    const cursorFromLap = (rows) => (x) => {
      let nearest = rows[0];
      for (const row of rows) {
        if (Math.abs(row.x - x) < Math.abs(nearest.x - x)) nearest = row;
      }
      this.mapView.setCursor(nearest.la, nearest.lo);
    };
    const onHoverX = cursorFromLap(a.rows);
    const speedSets = [
      { label: `Lap ${a.lap.number}`, color: SERIES_COLORS.primary, data: decimate(a.rows).map((row) => ({ x: row.x, y: row.v * factor })) },
    ];
    if (b) {
      speedSets.push({
        label: `Lap ${b.lap.number}`,
        color: SERIES_COLORS.compare,
        data: decimate(b.rows).map((row) => ({ x: row.x, y: row.v * factor })),
      });
    }
    this.charts.line("Speed vs Distance", speedSets, { xTitle: "m", yTitle: unit, onHoverX });

    if (b) {
      // Normalise B's distance to A's lap length so small line differences do not accumulate.
      const lengthA = a.rows[a.rows.length - 1].x;
      const lengthB = b.rows[b.rows.length - 1].x || 1;
      const bRows = b.rows.map((row) => ({ x: row.x * (lengthA / lengthB), t: row.lapT }));
      const delta = decimate(a.rows).map((row) => ({ x: row.x, y: interpolateTimeAtDistance(bRows, row.x) - row.lapT }));
      this.charts.line(
        `Delta: Lap ${b.lap.number} vs Lap ${a.lap.number} (+ = slower)`,
        [{ label: "s", color: SERIES_COLORS.delta, data: delta }],
        { xTitle: "m", yTitle: "s", onHoverX, zeroLine: true },
      );
    }

    if (this.run.analysis.hasG) {
      const rows = decimate(a.rows);
      this.charts.line(
        `G-Forces, Lap ${a.lap.number}`,
        [
          { label: "long g", color: SERIES_COLORS.accent, data: rows.map((row) => ({ x: row.x, y: row.lon })) },
          { label: "lat g", color: SERIES_COLORS.primary, data: rows.map((row) => ({ x: row.x, y: row.lat })) },
        ],
        { xTitle: "m", yTitle: "g", onHoverX, zeroLine: true },
      );
      const ggSets = [{ label: `Lap ${a.lap.number}`, color: SERIES_COLORS.primary, data: this.ggPoints(a.rows) }];
      if (b) ggSets.push({ label: `Lap ${b.lap.number}`, color: SERIES_COLORS.compare, data: this.ggPoints(b.rows) });
      this.charts.gg("Friction Circle (g-g)", ggSets);
    }

    if (this.run.analysis.hasGyro && a.rows.some((row) => row.beta != null)) {
      this.charts.line(
        `Drift Angle, Lap ${a.lap.number}`,
        [{ label: "deg (L +)", color: SERIES_COLORS.delta, data: decimate(a.rows).map((row) => ({ x: row.x, y: row.beta })) }],
        { xTitle: "m", yTitle: "deg", onHoverX, zeroLine: true },
      );
    }
  }

  renderSessionCharts(factor, unit) {
    const series = this.run.analysis.series;
    if (!series.length) return;
    const rows = decimate(series, 2000);
    const onHoverX = (x) => {
      const row = series[Math.min(series.length - 1, Math.max(0, Math.round((x - series[0].t) / 0.1)))];
      if (row) this.mapView.setCursor(row.la, row.lo);
    };
    this.charts.line(
      "Speed vs Time",
      [{ label: unit, color: SERIES_COLORS.primary, data: rows.map((row) => ({ x: row.t, y: row.v * factor })) }],
      { xTitle: "s", yTitle: unit, onHoverX },
    );
    if (this.run.analysis.hasG) {
      this.charts.line(
        "G-Forces vs Time",
        [
          { label: "long g", color: SERIES_COLORS.accent, data: rows.map((row) => ({ x: row.t, y: row.lon })) },
          { label: "lat g", color: SERIES_COLORS.primary, data: rows.map((row) => ({ x: row.t, y: row.lat })) },
        ],
        { xTitle: "s", yTitle: "g", onHoverX, zeroLine: true },
      );
      this.charts.gg("Friction Circle (g-g)", [
        { label: "Session", color: SERIES_COLORS.primary, data: this.ggPoints(series) },
      ]);
    }
    if (this.run.analysis.hasGyro && series.some((row) => row.beta != null)) {
      this.charts.line(
        "Drift Angle vs Time",
        [{ label: "deg (L +)", color: SERIES_COLORS.delta, data: rows.map((row) => ({ x: row.t, y: row.beta })) }],
        { xTitle: "s", yTitle: "deg", onHoverX, zeroLine: true },
      );
    }
  }

  ggPoints(rows) {
    return decimate(rows.filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lon)), 2500).map((row) => ({
      x: row.lat,
      y: row.lon,
    }));
  }
}
