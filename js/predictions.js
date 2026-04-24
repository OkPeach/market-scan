// Algorithmic 24h forecast.
//
// For each ticker with quote + 24h history + news, we compute a signed
// "outlook score" that blends three signals:
//
//   base     = today's % change vs previous close  (from Finnhub /quote.dp)
//   momentum = % delta between the recent half and the earlier half of the
//              24h price history — negative when losing steam, positive when
//              gaining steam, even if the overall change is still red/green.
//   news     = log(1 + newsCount) * 0.2 — diminishing attention premium.
//
// Alignment: news amplifies the base signal only when momentum points the
// same way, otherwise it's damped (mixed signals = lower conviction).
//
//   score = base * (1 + |momentum| * alignment * 0.3) * (1 + newsBoost)
//
// Top positive scores → "predicted to rise"
// Top negative scores → "predicted to fall"

import { createLogger } from "./logger.js";

const log = createLogger("predictions");

function computeMomentum(series) {
  if (!Array.isArray(series) || series.length < 4) return 0;
  const n = series.length;
  const half = Math.floor(n / 2);
  const earlier = series.slice(0, half);
  const recent = series.slice(half);
  const avg = (arr) => arr.reduce((a, p) => a + p.p, 0) / arr.length;
  const e = avg(earlier);
  const r = avg(recent);
  if (!e) return 0;
  return ((r - e) / e) * 100;
}

function newsCountByTicker(news) {
  const counts = {};
  for (const item of news ?? []) {
    if (item && item.ticker) {
      counts[item.ticker] = (counts[item.ticker] ?? 0) + 1;
    }
  }
  return counts;
}

export function computePredictions({ stocks, history, news }) {
  const newsCounts = newsCountByTicker(news);
  const out = [];

  for (const s of stocks ?? []) {
    const base = Number.isFinite(s.changePct) ? s.changePct : 0;
    const momentum = computeMomentum(history?.[s.ticker]);
    const newsN = newsCounts[s.ticker] ?? 0;
    const newsBoost = Math.log(1 + newsN) * 0.2;

    // Alignment: 1 if both signals point the same way, 0.4 otherwise.
    const signsMatch = Math.sign(base) === Math.sign(momentum) && base !== 0 && momentum !== 0;
    const alignment = signsMatch ? 1 : 0.4;

    const score = base * (1 + Math.abs(momentum) * alignment * 0.3) * (1 + newsBoost);

    out.push({
      ticker: s.ticker,
      name: s.name,
      price: s.price,
      base,
      momentum,
      newsCount: newsN,
      score,
    });
  }
  return out;
}

function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtPrice(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function reasonTags(p) {
  const tags = [];
  if (Math.abs(p.base) >= 0.1) {
    tags.push(
      `<span class="tag ${p.base >= 0 ? "pos" : "neg"}">${fmtPct(p.base)} today</span>`,
    );
  }
  if (Math.abs(p.momentum) >= 0.1) {
    const dir = p.momentum >= 0 ? "↗" : "↘";
    const cls = p.momentum >= 0 ? "pos" : "neg";
    tags.push(`<span class="tag ${cls}">${dir} ${fmtPct(p.momentum)} momentum</span>`);
  }
  if (p.newsCount > 0) {
    tags.push(
      `<span class="tag neutral">${p.newsCount} news item${p.newsCount === 1 ? "" : "s"}</span>`,
    );
  }
  return tags.join(" ");
}

function forecastRow(p, kind) {
  const scoreCls = kind === "up" ? "pos" : "neg";
  const scoreTxt = fmtPct(p.score);
  return `
    <li class="forecast">
      <div class="forecast-head">
        <span class="ticker">${esc(p.ticker)}</span>
        <span class="name" title="${esc(p.name ?? "")}">${esc(p.name ?? "")}</span>
        <span class="price">${fmtPrice(p.price)}</span>
        <span class="score ${scoreCls}">${scoreTxt}</span>
      </div>
      <div class="forecast-reasons">${reasonTags(p)}</div>
    </li>
  `;
}

export function renderForecast({ risersEl, fallersEl, stocks, history, news }) {
  if (!risersEl || !fallersEl) {
    log.warn("renderForecast: missing list elements");
    return;
  }

  if (!stocks || stocks.length === 0) {
    const empty = '<li class="empty">No data yet — waiting for first workflow run.</li>';
    risersEl.innerHTML = empty;
    fallersEl.innerHTML = empty;
    return;
  }

  const preds = computePredictions({ stocks, history, news });
  const sorted = preds.slice().sort((a, b) => b.score - a.score);

  const risers = sorted.filter((p) => p.score > 0).slice(0, 5);
  const fallers = sorted
    .filter((p) => p.score < 0)
    .slice(-5)
    .reverse();

  risersEl.innerHTML = risers.length
    ? risers.map((p) => forecastRow(p, "up")).join("")
    : '<li class="empty">No bullish signals right now.</li>';

  fallersEl.innerHTML = fallers.length
    ? fallers.map((p) => forecastRow(p, "down")).join("")
    : '<li class="empty">No bearish signals right now.</li>';

  log.info(
    `renderForecast: risers=[${risers.map((p) => p.ticker).join(",")}] ` +
      `fallers=[${fallers.map((p) => p.ticker).join(",")}]`,
  );
}
