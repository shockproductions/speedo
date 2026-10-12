const TICK_COLOR = "#9db0bb";
const GRID_COLOR = "rgba(255,255,255,0.06)";
const LEGEND_COLOR = "#f4f8fb";
export const SERIES_COLORS = {
  primary: "#ff7a2f",
  compare: "#7cc4ff",
  accent: "#ffd36c",
  delta: "#c792ea",
};

function baseOptions({ xTitle, yTitle, onHoverX }) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    parsing: false,
    normalized: true,
    interaction: { intersect: false, mode: "nearest", axis: "x" },
    onHover: (_, elements, chart) => {
      if (!onHoverX || !elements.length) return;
      const element = elements[0];
      const point = chart.data.datasets[element.datasetIndex].data[element.index];
      if (point) onHoverX(point.x, element.datasetIndex);
    },
    plugins: {
      legend: { labels: { color: LEGEND_COLOR, boxWidth: 12 } },
      tooltip: { enabled: true },
    },
    scales: {
      x: {
        type: "linear",
        title: { display: Boolean(xTitle), text: xTitle, color: TICK_COLOR },
        ticks: { color: TICK_COLOR, maxTicksLimit: 8 },
        grid: { color: GRID_COLOR },
      },
      y: {
        title: { display: Boolean(yTitle), text: yTitle, color: TICK_COLOR },
        ticks: { color: TICK_COLOR },
        grid: { color: GRID_COLOR },
      },
    },
  };
}

function lineDataset(label, data, color, extra = {}) {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.15,
    spanGaps: false,
    ...extra,
  };
}

export class ChartPanel {
  constructor(container) {
    this.container = container;
    this.charts = [];
  }

  destroy() {
    for (const chart of this.charts) chart.destroy();
    this.charts = [];
    this.container.innerHTML = "";
  }

  addCard(title) {
    const card = document.createElement("div");
    card.className = "chart-card";
    card.innerHTML = `<h3>${title}</h3><canvas></canvas>`;
    this.container.appendChild(card);
    return card.querySelector("canvas");
  }

  // datasets: [{label, data: [{x, y}], color}]
  line(title, datasets, { xTitle, yTitle, onHoverX, zeroLine = false } = {}) {
    const canvas = this.addCard(title);
    const options = baseOptions({ xTitle, yTitle, onHoverX });
    if (zeroLine) {
      options.scales.y.grid = {
        color: (context) => (context.tick.value === 0 ? "rgba(255,255,255,0.35)" : GRID_COLOR),
      };
    }
    const chart = new Chart(canvas, {
      type: "line",
      data: {
        datasets: datasets.map((dataset) => lineDataset(dataset.label, dataset.data, dataset.color, dataset.extra)),
      },
      options,
    });
    this.charts.push(chart);
    return chart;
  }

  // Friction circle: lateral g on x, longitudinal g on y.
  gg(title, datasets) {
    const canvas = this.addCard(title);
    const options = baseOptions({ xTitle: "lateral g (right +)", yTitle: "long g (accel +)" });
    options.interaction = { intersect: true, mode: "nearest" };
    options.aspectRatio = 1;
    options.scales.x.min = -1.5;
    options.scales.x.max = 1.5;
    options.scales.y.min = -1.5;
    options.scales.y.max = 1.5;
    const chart = new Chart(canvas, {
      type: "scatter",
      data: {
        datasets: datasets.map((dataset) => ({
          label: dataset.label,
          data: dataset.data,
          backgroundColor: `${dataset.color}66`,
          borderColor: "transparent",
          pointRadius: 2,
        })),
      },
      options,
    });
    this.charts.push(chart);
    return chart;
  }
}
