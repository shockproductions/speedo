import { formatLapTime } from "./analysis.js";
import { ChartPanel, SERIES_COLORS } from "./charts.js";
import { speedFactor, speedUnit } from "./settings.js";

const PALETTE = ["#ff7a2f", "#7cc4ff", "#ffd36c", "#c792ea", "#5cd678", "#ff6a9a", "#9db0bb"];

export function channelDefinitions(units) {
  const factor = speedFactor(units);
  return {
    speed: { label: "Speed", unit: speedUnit(units), value: (row) => row.v * factor },
    long: { label: "Longitudinal g", unit: "g", value: (row) => row.lon },
    lat: { label: "Lateral g", unit: "g", value: (row) => row.lat },
    combined: {
      label: "Combined g",
      unit: "g",
      value: (row) => (Number.isFinite(row.lon) ? Math.hypot(row.lon, row.lat) : null),
    },
    vert: { label: "Vertical g", unit: "g", value: (row) => row.vert ?? null },
    yaw: { label: "Yaw rate", unit: "deg/s", value: (row) => row.yaw },
    beta: { label: "Drift angle", unit: "deg", value: (row) => row.beta },
    heading: { label: "Heading", unit: "deg", value: (row) => row.hdg ?? null },
  };
}

export function decimate(rows, maxPoints = 1500) {
  if (rows.length <= maxPoints) return rows;
  const step = rows.length / maxPoints;
  const result = [];
  for (let index = 0; index < rows.length; index += step) result.push(rows[Math.floor(index)]);
  return result;
}

export function lapRows(run, lapNumber) {
  const lap = run.analysis.laps.find((item) => item.number === lapNumber);
  if (!lap) return null;
  const rows = run.analysis.series.filter((row) => row.t >= lap.start && row.t <= lap.end);
  if (rows.length < 2) return null;
  const d0 = rows[0].d;
  return { lap, rows: rows.map((row) => ({ ...row, x: row.d - d0, lapT: row.t - lap.start })) };
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
  return a.t + (b.t - a.t) * (b.x > a.x ? (distance - a.x) / (b.x - a.x) : 0);
}

function ggPoints(rows) {
  return decimate(rows.filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lon)), 2500).map((row) => ({
    x: row.lat,
    y: row.lon,
  }));
}

export class GraphsTab {
  constructor(container, { run, units, selection, onSelectionChange }) {
    this.container = container;
    this.run = run;
    this.units = units;
    this.selection = selection;
    this.onSelectionChange = onSelectionChange;
    this.panels = [];
    this.render();
  }

  destroy() {
    for (const panel of this.panels) panel.destroy();
    this.panels = [];
  }

  render() {
    const { laps, hasG, hasGyro } = this.run.analysis;
    const channels = channelDefinitions(this.units);
    const available = Object.entries(channels).filter(([key]) => {
      if (["long", "lat", "combined", "vert"].includes(key)) return hasG;
      if (["yaw", "beta"].includes(key)) return hasGyro;
      return true;
    });
    const lapOptions = (selected, allowNone) =>
      [
        allowNone ? `<option value="">None</option>` : "",
        ...laps.map(
          (lap) => `<option value="${lap.number}"${lap.number === selected ? " selected" : ""}>Lap ${lap.number} - ${formatLapTime(lap.time)}</option>`,
        ),
      ].join("");

    this.container.innerHTML = `
      ${laps.length ? `
        <section class="graph-section">
          <div class="graph-head">
            <h3>Lap Comparison</h3>
            <div class="graph-controls">
              <label class="field compact-field"><span>Lap A</span><select data-g="lapA">${lapOptions(this.selection.lapA, false)}</select></label>
              <label class="field compact-field"><span>Lap B</span><select data-g="lapB">${lapOptions(this.selection.lapB, true)}</select></label>
            </div>
          </div>
          <div class="chart-grid" data-g="compare"></div>
        </section>` : ""}
      <section class="graph-section">
        <div class="graph-head">
          <h3>Custom Graph</h3>
        </div>
        <div class="graph-controls">
          <label class="field compact-field"><span>X axis</span>
            <select data-g="x"><option value="time">Time</option><option value="distance">Distance</option></select>
          </label>
          <label class="field compact-field"><span>Range</span>
            <select data-g="range"><option value="session">Whole session</option>${laps.map((lap) => `<option value="${lap.number}">Lap ${lap.number}</option>`).join("")}</select>
          </label>
        </div>
        <div class="channel-picks">
          ${available.map(([key, channel], index) => `<label class="toggle"><input type="checkbox" value="${key}"${index === 0 ? " checked" : ""}/> ${channel.label}</label>`).join("")}
        </div>
        <button type="button" class="secondary-button" data-g="add">Add Graph</button>
        <div class="custom-graphs" data-g="custom"></div>
      </section>`;

    const $ = (name) => this.container.querySelector(`[data-g="${name}"]`);
    $("lapA")?.addEventListener("change", (event) => {
      this.selection.lapA = Number(event.target.value);
      if (this.selection.lapB === this.selection.lapA) this.selection.lapB = null;
      this.onSelectionChange?.();
      this.renderComparison();
    });
    $("lapB")?.addEventListener("change", (event) => {
      this.selection.lapB = event.target.value ? Number(event.target.value) : null;
      this.onSelectionChange?.();
      this.renderComparison();
    });
    $("add").addEventListener("click", () => this.addCustomGraph());
    this.renderComparison();
    this.addCustomGraph();
  }

  renderComparison() {
    const mount = this.container.querySelector('[data-g="compare"]');
    if (!mount) return;
    this.comparePanel?.destroy();
    this.comparePanel = new ChartPanel(mount);
    const a = this.selection.lapA != null ? lapRows(this.run, this.selection.lapA) : null;
    if (!a) return;
    const b = this.selection.lapB != null ? lapRows(this.run, this.selection.lapB) : null;
    const factor = speedFactor(this.units);
    const unit = speedUnit(this.units);
    const panel = this.comparePanel;

    const speedSets = [{ label: `Lap ${a.lap.number}`, color: SERIES_COLORS.primary, data: decimate(a.rows).map((row) => ({ x: row.x, y: row.v * factor })) }];
    if (b) speedSets.push({ label: `Lap ${b.lap.number}`, color: SERIES_COLORS.compare, data: decimate(b.rows).map((row) => ({ x: row.x, y: row.v * factor })) });
    panel.line("Speed vs Distance", speedSets, { xTitle: "m", yTitle: unit });

    if (b) {
      // Normalise B's distance to A's lap length so small line differences do not accumulate.
      const lengthA = a.rows[a.rows.length - 1].x;
      const lengthB = b.rows[b.rows.length - 1].x || 1;
      const bRows = b.rows.map((row) => ({ x: row.x * (lengthA / lengthB), t: row.lapT }));
      panel.line(
        `Delta: Lap ${b.lap.number} vs Lap ${a.lap.number} (+ = slower)`,
        [{ label: "s", color: SERIES_COLORS.delta, data: decimate(a.rows).map((row) => ({ x: row.x, y: interpolateTimeAtDistance(bRows, row.x) - row.lapT })) }],
        { xTitle: "m", yTitle: "s", zeroLine: true },
      );
    }
    if (this.run.analysis.hasG) {
      const rows = decimate(a.rows);
      panel.line(
        `G-Forces, Lap ${a.lap.number}`,
        [
          { label: "long g", color: SERIES_COLORS.accent, data: rows.map((row) => ({ x: row.x, y: row.lon })) },
          { label: "lat g", color: SERIES_COLORS.primary, data: rows.map((row) => ({ x: row.x, y: row.lat })) },
        ],
        { xTitle: "m", yTitle: "g", zeroLine: true },
      );
      const sets = [{ label: `Lap ${a.lap.number}`, color: SERIES_COLORS.primary, data: ggPoints(a.rows) }];
      if (b) sets.push({ label: `Lap ${b.lap.number}`, color: SERIES_COLORS.compare, data: ggPoints(b.rows) });
      panel.gg("Friction Circle (g-g)", sets);
    }
    if (this.run.analysis.hasGyro && a.rows.some((row) => row.beta != null)) {
      const sets = [{ label: `Lap ${a.lap.number}`, color: SERIES_COLORS.delta, data: decimate(a.rows).map((row) => ({ x: row.x, y: row.beta })) }];
      if (b) sets.push({ label: `Lap ${b.lap.number}`, color: SERIES_COLORS.compare, data: decimate(b.rows).map((row) => ({ x: row.x, y: row.beta })) });
      panel.line("Drift Angle (L +)", sets, { xTitle: "m", yTitle: "deg", zeroLine: true });
    }
  }

  addCustomGraph() {
    const $ = (name) => this.container.querySelector(`[data-g="${name}"]`);
    const keys = [...this.container.querySelectorAll(".channel-picks input:checked")].map((input) => input.value);
    if (!keys.length) return;
    const xAxis = $("x").value;
    const range = $("range").value;
    const channels = channelDefinitions(this.units);

    let rows;
    let title;
    if (range === "session") {
      rows = this.run.analysis.series.map((row) => ({ ...row, x: xAxis === "time" ? row.t : row.d }));
      title = "Session";
    } else {
      const lap = lapRows(this.run, Number(range));
      if (!lap) return;
      rows = lap.rows.map((row) => ({ ...row, x: xAxis === "time" ? row.lapT : row.x }));
      title = `Lap ${range}`;
    }
    rows = decimate(rows, 2500);

    const wrapper = document.createElement("div");
    wrapper.className = "custom-graph";
    wrapper.innerHTML = '<button type="button" class="chip custom-graph-close" aria-label="Remove graph">&times;</button>';
    const mount = document.createElement("div");
    mount.className = "chart-grid";
    wrapper.appendChild(mount);
    $("custom").prepend(wrapper);

    const panel = new ChartPanel(mount);
    this.panels.push(panel);
    const units = [...new Set(keys.map((key) => channels[key].unit))];
    panel.line(
      `${keys.map((key) => channels[key].label).join(", ")} - ${title}`,
      keys.map((key, index) => ({
        label: `${channels[key].label} (${channels[key].unit})`,
        color: PALETTE[index % PALETTE.length],
        data: rows.map((row) => ({ x: row.x, y: channels[key].value(row) ?? null })),
      })),
      { xTitle: xAxis === "time" ? "s" : "m", yTitle: units.join(" / "), zeroLine: true },
    );
    wrapper.querySelector(".custom-graph-close").addEventListener("click", () => {
      panel.destroy();
      this.panels = this.panels.filter((item) => item !== panel);
      wrapper.remove();
    });
  }
}
