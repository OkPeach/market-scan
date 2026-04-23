// Render news, sorted by impact = |same-day % move| of the mentioned ticker.

import { createLogger } from "./logger.js";

const log = createLogger("news");

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtRelative(ms) {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function impactScore(item, stockMap) {
  if (!item.ticker) return 0;
  const s = stockMap.get(item.ticker);
  if (!s || s.changePct == null) return 0;
  return Math.abs(s.changePct);
}

function tickerBadge(item, stockMap) {
  if (!item.ticker) return "";
  const s = stockMap.get(item.ticker);
  const pct = s?.changePct;
  const cls = pct == null ? "" : pct >= 0 ? "pos" : "neg";
  return `<span class="ticker-badge ${cls}">${escapeHtml(item.ticker)} ${fmtPct(pct)}</span>`;
}

export function renderNews({ listEl, items, stocks }) {
  if (!listEl) {
    log.warn("renderNews: no list element");
    return;
  }
  if (!items || items.length === 0) {
    log.info("renderNews: no items, showing empty state");
    listEl.innerHTML =
      '<p class="empty">No news yet — waiting for first workflow run.</p>';
    return;
  }

  const stockMap = new Map(stocks.map((s) => [s.ticker, s]));

  const sorted = items
    .slice()
    .sort((a, b) => {
      const ia = impactScore(a, stockMap);
      const ib = impactScore(b, stockMap);
      if (ib !== ia) return ib - ia;
      return (b.datetime ?? 0) - (a.datetime ?? 0);
    });

  const html = sorted
    .map((item) => {
      const headline = escapeHtml(item.headline || "(no headline)");
      const source = escapeHtml(item.source || "");
      const summary = item.summary
        ? `<p class="news-summary">${escapeHtml(item.summary).slice(0, 240)}${item.summary.length > 240 ? "…" : ""}</p>`
        : "";
      const url = item.url || "#";
      const safeUrl = /^https?:\/\//i.test(url) ? url : "#";
      return `
        <article class="news-card">
          <div class="news-meta">
            ${tickerBadge(item, stockMap)}
            <span>${source}</span>
            <span>·</span>
            <span>${fmtRelative(item.datetime)}</span>
          </div>
          <h4 class="news-headline">
            <a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${headline}</a>
          </h4>
          ${summary}
        </article>
      `;
    })
    .join("");

  listEl.innerHTML = html;
  const withTicker = sorted.filter((it) => it.ticker).length;
  log.info(
    `renderNews: rendered ${sorted.length} items (${withTicker} with a ticker)`,
  );
}
