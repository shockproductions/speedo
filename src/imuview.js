const GRAVITY = 9.80665;

function formatG(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)} g` : "0.00 g";
}

export class IMUView {
  constructor(container) {
    this.container = container;
    this.chart = null;
    this.series = [];
    this.lastChartUpdate = 0;
    this.render();
  }

  render() {
    this.container.innerHTML = `
      <div class="imu-layout">
        <div class="detail-grid">
          <article class="detail-stat"><span>Device X</span><strong id="imuX">0.00 g</strong></article>
          <article class="detail-stat"><span>Device Y</span><strong id="imuY">0.00 g</strong></article>
          <article class="detail-stat"><span>Device Z</span><strong id="imuZ">0.00 g</strong></article>
          <article class="detail-stat"><span>Resultant</span><strong id="imuTotal">0.00 g</strong></article>
        </div>
        <div class="chart-card">
          <h3>Live IMU Trace</h3>
          <canvas id="imuChart"></canvas>
        </div>
      </div>
    `;

    this.xValue = this.container.querySelector("#imuX");
    this.yValue = this.container.querySelector("#imuY");
    this.zValue = this.container.querySelector("#imuZ");
    this.totalValue = this.container.querySelector("#imuTotal");

    this.chart = new Chart(this.container.querySelector("#imuChart"), {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "X",
            data: [],
            borderColor: "#ff7a2f",
            pointRadius: 0,
            tension: 0.22,
          },
          {
            label: "Y",
            data: [],
            borderColor: "#ffd36c",
            pointRadius: 0,
            tension: 0.22,
          },
          {
            label: "Z",
            data: [],
            borderColor: "#ff9958",
            pointRadius: 0,
            tension: 0.22,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: {
            labels: {
              color: "#f4f8fb",
            },
          },
        },
        scales: {
          x: {
            ticks: { color: "#9db0bb" },
            grid: { color: "rgba(255,255,255,0.06)" },
          },
          y: {
            ticks: { color: "#9db0bb" },
            grid: { color: "rgba(255,255,255,0.06)" },
          },
        },
      },
    });
  }

  update(motion) {
    const x = (motion.accelX ?? 0) / GRAVITY;
    const y = (motion.accelY ?? 0) / GRAVITY;
    const z = (motion.accelZ ?? 0) / GRAVITY;
    const total = Math.sqrt(x ** 2 + y ** 2 + z ** 2);

    this.xValue.textContent = formatG(x);
    this.yValue.textContent = formatG(y);
    this.zValue.textContent = formatG(z);
    this.totalValue.textContent = formatG(total);

    this.series.push({
      t: motion.timestamp,
      x,
      y,
      z,
    });

    const cutoff = motion.timestamp - 12000;
    this.series = this.series.filter((item) => item.t >= cutoff);

    if (motion.timestamp - this.lastChartUpdate < 120) {
      return;
    }

    this.lastChartUpdate = motion.timestamp;
    this.chart.data.labels = this.series.map((item) => ((item.t - this.series[0].t) / 1000).toFixed(1));
    this.chart.data.datasets[0].data = this.series.map((item) => item.x);
    this.chart.data.datasets[1].data = this.series.map((item) => item.y);
    this.chart.data.datasets[2].data = this.series.map((item) => item.z);
    this.chart.update("none");
  }
}
