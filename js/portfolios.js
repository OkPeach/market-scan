// Configurable portfolio widgets (SEC 13F + Congressional trades).
//
// Each entry in data/portfolios.json renders as: a donut chart (Chart.js,
// already loaded via CDN) where hovering a slice reveals the position label
// + weight; a list of "Stock — % in portfolio" rows under the chart.
//
// We register a Chart instance per <canvas> in a WeakMap so re-renders
// destroy the old chart cleanly.

import { createLogger } from "./logger.js";

const log = createLogger("portfolios");

const CHART_REGISTRY = new WeakMap();

// 12-color palette tuned for the dark glass theme — high-saturation but
// not eye-melting; the "others" slice gets a muted gray.
const PALETTE = [
  "#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#ff375f",
  "#64d2ff", "#ffd60a", "#ff453a", "#5e5ce6", "#34c759",
  "#ff6482", "#a78bfa",
];
const OTHERS_COLOR = "#5b6470";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtPct(weight, digits = 1) {
  if (weight == null || !Number.isFinite(weight)) return "—";
  return `${(weight * 100).toFixed(digits)}%`;
}

function colorFor(idx, isOther) {
  if (isOther) return OTHERS_COLOR;
  return PALETTE[idx % PALETTE.length];
}

function renderDonut(canvas, positions) {
  if (!canvas || typeof window.Chart === "undefined") return;
  if (!positions || positions.length === 0) return;

  const existing = CHART_REGISTRY.get(canvas);
  if (existing) existing.destroy();

  const labels = positions.map((p) => p.label);
  const data = positions.map((p) => p.weight * 100);
  const colors = positions.map((p, i) => colorFor(i, p.isOther));

  const chart = new window.Chart(canvas.getContext("2d"), {
    type: "doughnut",
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: colors,
          borderColor: "rgba(0,0,0,0.4)",
          borderWidth: 1.5,
          hoverOffset: 6,
          spacing: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      cutout: "62%",
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(28,28,30,0.95)",
          borderColor: "rgba(255,255,255,0.14)",
          borderWidth: 1,
          padding: 10,
          titleFont: { family: "-apple-system, SF Pro Display, sans-serif", weight: "600" },
          bodyFont: { family: "ui-monospace, SF Mono, Menlo, monospace" },
          callbacks: {
            label: (ctx) => `${ctx.parsed.toFixed(2)}%`,
          },
        },
      },
    },
  });
  CHART_REGISTRY.set(canvas, chart);
}

function renderEntry(entry) {
  if (!entry.ok) {
    return `
      <article class="portfolio-card error" data-id="${esc(entry.id ?? "")}">
        <header class="portfolio-card-head">
          <h3>${esc(entry.name ?? entry.id ?? "Portfolio")}</h3>
          <span class="portfolio-sub">${esc(entry.subtitle ?? "")}</span>
        </header>
        <p class="empty">Couldn't fetch — ${esc(entry.error ?? "unknown error")}</p>
      </article>
    `;
  }

  const positions = entry.positions ?? [];
  if (positions.length === 0) {
    return `
      <article class="portfolio-card" data-id="${esc(entry.id ?? "")}">
        <header class="portfolio-card-head">
          <h3>${esc(entry.name ?? "Portfolio")}</h3>
          <span class="portfolio-sub">${esc(entry.subtitle ?? "")}</span>
        </header>
        <p class="empty">No positions yet — waiting for first workflow run.</p>
      </article>
    `;
  }

  const rows = positions
    .map((p, i) => {
      const swatch = `<span class="swatch" style="background:${colorFor(i, p.isOther)}"></span>`;
      const cls = p.isOther ? "other" : "";
      return `
        <li class="portfolio-row ${cls}">
          <span class="portfolio-row-name" title="${esc(p.label)}">${swatch}${esc(p.label)}</span>
          <span class="portfolio-row-weight">${fmtPct(p.weight)}</span>
        </li>
      `;
    })
    .join("");

  const sourceLink = entry.sourceUrl
    ? `<a href="${esc(entry.sourceUrl)}" target="_blank" rel="noopener">${esc(entry.sourceLabel ?? "source")}</a>`
    : esc(entry.sourceLabel ?? "");

  const note = entry.note
    ? `<p class="portfolio-note-small">${esc(entry.note)}</p>`
    : "";

  return `
    <article class="portfolio-card" data-id="${esc(entry.id ?? "")}">
      <div class="portfolio-chart-wrap">
        <canvas class="portfolio-chart"></canvas>
      </div>
      <header class="portfolio-card-head">
        <h3>${esc(entry.name ?? "Portfolio")}</h3>
        <span class="portfolio-sub">${esc(entry.subtitle ?? "")}</span>
      </header>
      <ol class="portfolio-list">${rows}</ol>
      <footer class="portfolio-foot">
        <span>${sourceLink}</span>
        ${entry.asOf ? `<span class="sep">·</span><span>as of ${esc(entry.asOf)}</span>` : ""}
      </footer>
      ${note}
    </article>
  `;
}

export function renderPortfolios({ containerEl, portfoliosFile }) {
  if (!containerEl) {
    log.warn("renderPortfolios: no container");
    return;
  }
  const portfolios = portfoliosFile?.portfolios ?? [];
  if (portfolios.length === 0) {
    containerEl.innerHTML = `
      <p class="empty">
        No portfolios configured. Edit <code>config/portfolios.json</code> and
        run <code>update-portfolios.yml</code> from the Actions tab.
      </p>
    `;
    return;
  }

  containerEl.innerHTML = portfolios.map(renderEntry).join("");

  // Defer chart creation one frame so each canvas has dimensions.
  requestAnimationFrame(() => {
    const cards = containerEl.querySelectorAll(".portfolio-card");
    cards.forEach((card, i) => {
      const canvas = card.querySelector(".portfolio-chart");
      if (!canvas) return;
      const entry = portfolios[i];
      if (!entry?.ok || !entry.positions?.length) return;
      renderDonut(canvas, entry.positions);
    });
  });

  log.info(`renderPortfolios: ${portfolios.length} cards`);
}
