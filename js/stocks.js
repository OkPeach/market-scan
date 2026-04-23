// Render best/worst lists and populate the ticker dropdown.

import { renderSparkline } from "./charts.js";

const POS_COLOR = "#3fb950";
const NEG_COLOR = "#f85149";

function fmtPrice(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 100) return n.toFixed(2);
  return n.toFixed(2);
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function populateTickerSelect(selectEl, tickers) {
  if (!selectEl) return;
  // Preserve the currently selected value if still present.
  const prev = selectEl.value;
  selectEl.innerHTML = "";
  for (const t of tickers) {
    const opt = document.createElement("option");
    opt.value = t.symbol;
    opt.textContent = `${t.symbol} — ${t.name}`;
    selectEl.appendChild(opt);
  }
  if (prev && tickers.some((t) => t.symbol === prev)) {
    selectEl.value = prev;
  }
}

function renderRow(stock, history) {
  const li = document.createElement("li");
  li.className = "mover";

  const pct = stock.changePct;
  const pctClass = pct == null ? "" : pct >= 0 ? "pos" : "neg";

  li.innerHTML = `
    <span class="ticker">${stock.ticker}</span>
    <span class="name" title="${stock.name ?? ""}">${stock.name ?? ""}</span>
    <span class="price">${fmtPrice(stock.price)}</span>
    <span class="pct ${pctClass}">${fmtPct(pct)}</span>
    <canvas class="spark"></canvas>
  `;

  const canvas = li.querySelector(".spark");
  const series = history[stock.ticker];
  // Defer one tick so the canvas has dimensions before Chart.js measures it.
  requestAnimationFrame(() => {
    renderSparkline(canvas, series, {
      color: pct == null || pct >= 0 ? POS_COLOR : NEG_COLOR,
    });
  });

  return li;
}

export function renderMovers({ bestEl, worstEl, stocks, history }) {
  if (!bestEl || !worstEl) return;
  bestEl.innerHTML = "";
  worstEl.innerHTML = "";

  const ranked = stocks
    .filter((s) => s.changePct != null && Number.isFinite(s.changePct))
    .slice()
    .sort((a, b) => b.changePct - a.changePct);

  if (ranked.length === 0) {
    bestEl.innerHTML = '<li class="empty">No data yet — waiting for first workflow run.</li>';
    worstEl.innerHTML = '<li class="empty">No data yet — waiting for first workflow run.</li>';
    return;
  }

  const best = ranked.slice(0, 5);
  const worst = ranked.slice(-5).reverse();

  for (const s of best) bestEl.appendChild(renderRow(s, history));
  for (const s of worst) worstEl.appendChild(renderRow(s, history));
}
