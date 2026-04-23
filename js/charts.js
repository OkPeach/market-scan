// Tiny Chart.js sparklines.
// Chart is loaded via CDN as a global; we read it lazily per call so
// modules don't crash if the script is still loading on first paint.

const sparkRegistry = new WeakMap();

export function renderSparkline(canvas, points, { color }) {
  if (!canvas || typeof window.Chart === "undefined") return;
  if (!points || points.length < 2) return;

  const data = points.map((p) => p.p);
  const labels = points.map(() => "");

  const existing = sparkRegistry.get(canvas);
  if (existing) existing.destroy();

  const chart = new window.Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          data,
          borderColor: color,
          backgroundColor: color + "20",
          borderWidth: 1.5,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: false },
      },
      elements: { line: { capBezierPoints: true } },
    },
  });
  sparkRegistry.set(canvas, chart);
}
