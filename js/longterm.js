// Long-term outlook panel.
//
// Shows, per ticker, the raw "other people's predictions" from Finnhub:
//   * analyst consensus distribution (strong buy → strong sell)
//   * 12-month price target mean/low/high + upside% vs current price
//   * next earnings date within 90 days (catalyst)
//   * a composite 6m score (0.7 * targetUpside + 0.3 * consensus*10), only
//     computed when BOTH inputs exist so we never fabricate a number.
//
// Also computes a self-reported accuracy number from longterm-history.json:
// for every pair of snapshots at least N days apart, count tickers whose
// score6m sign matched the subsequent actual price move. Transparent and
// measurable — trustworthiness is what you verify, not what you assert.

import { createLogger } from "./logger.js";

const log = createLogger("longterm");

const CONSENSUS_LABELS = ["strongBuy", "buy", "hold", "sell", "strongSell"];
const CONSENSUS_COLORS = {
  strongBuy: "#30d158",
  buy: "#5be884",
  hold: "#8e8e93",
  sell: "#ff9f8a",
  strongSell: "#ff453a",
};

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtPct(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

function fmtPrice(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function fmtDate(isoDate) {
  if (!isoDate) return "—";
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function daysUntil(isoDate) {
  if (!isoDate) return null;
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function consensusLabel(score) {
  if (score == null) return "—";
  if (score >= 1.5) return "Strong Buy";
  if (score >= 0.5) return "Buy";
  if (score >= -0.5) return "Hold";
  if (score >= -1.5) return "Sell";
  return "Strong Sell";
}

function consensusClass(score) {
  if (score == null) return "neutral";
  if (score >= 0.5) return "pos";
  if (score <= -0.5) return "neg";
  return "neutral";
}

function renderConsensusBar(distribution) {
  if (!distribution) return '<div class="consensus-bar empty"></div>';
  const total = CONSENSUS_LABELS.reduce((a, k) => a + (distribution[k] ?? 0), 0);
  if (total === 0) return '<div class="consensus-bar empty"></div>';
  const segments = CONSENSUS_LABELS
    .map((k) => {
      const n = distribution[k] ?? 0;
      if (n === 0) return "";
      const pct = (n / total) * 100;
      return `<span class="seg" style="width:${pct}%;background:${CONSENSUS_COLORS[k]};" title="${k}: ${n}"></span>`;
    })
    .join("");
  return `<div class="consensus-bar">${segments}</div>`;
}

function renderTrendArrow(trend) {
  if (trend == null) return "";
  if (Math.abs(trend) < 0.1) return '<span class="trend flat" title="stable vs 3m ago">→</span>';
  if (trend > 0) return `<span class="trend pos" title="+${trend.toFixed(2)} vs 3m ago">↑</span>`;
  return `<span class="trend neg" title="${trend.toFixed(2)} vs 3m ago">↓</span>`;
}

function renderRow(entry) {
  const score = entry.score6m;
  const scoreCls = score == null ? "neutral" : score > 0 ? "pos" : "neg";

  const consScoreVal = entry.consensus?.score;
  const consCls = consensusClass(consScoreVal);
  const consLabel = consensusLabel(consScoreVal);
  const analystCount = entry.consensus?.total ?? 0;

  const upside = entry.targetUpsidePct;
  const upCls = upside == null ? "neutral" : upside > 0 ? "pos" : "neg";

  const pt = entry.priceTarget ?? {};
  const ptRange = pt.low && pt.high
    ? `${fmtPrice(pt.low)} – ${fmtPrice(pt.high)} (mean ${fmtPrice(pt.mean)})`
    : "—";

  const earningsIn = daysUntil(entry.nextEarnings?.date);
  const earningsBadge = earningsIn != null
    ? `<span class="earnings ${earningsIn <= 7 ? "soon" : ""}" title="EPS est: ${entry.nextEarnings.epsEstimate ?? "—"}">
         ${fmtDate(entry.nextEarnings.date)}${earningsIn >= 0 ? ` · in ${earningsIn}d` : ""}
       </span>`
    : '<span class="earnings none">no event</span>';

  const tooltipLines = [];
  if (entry.consensus) {
    tooltipLines.push(
      `Consensus ${consScoreVal.toFixed(2)} from ${analystCount} analysts (${entry.distribution?.period ?? "latest"})`,
    );
  }
  if (pt.mean) {
    tooltipLines.push(
      `12m target ${fmtPrice(pt.mean)} (${pt.analysts ?? "?"} analysts, updated ${pt.lastUpdated ?? "?"})`,
    );
  }
  if (entry.nextEarnings?.date) {
    tooltipLines.push(`Next earnings ${entry.nextEarnings.date} ${entry.nextEarnings.hour ?? ""}`.trim());
  }
  if (entry.errors?.length) tooltipLines.push(`Errors: ${entry.errors.join("; ")}`);
  const tooltip = tooltipLines.join("\n");

  return `
    <tr title="${esc(tooltip)}">
      <td class="ticker-cell">
        <span class="ticker">${esc(entry.symbol)}</span>
        <span class="name" title="${esc(entry.name ?? "")}">${esc(entry.name ?? "")}</span>
      </td>
      <td class="consensus-cell">
        <div class="consensus-row">
          <span class="consensus-label ${consCls}">${consLabel}</span>
          ${renderTrendArrow(entry.consensusTrend)}
          <span class="analyst-count">n=${analystCount}</span>
        </div>
        ${renderConsensusBar(entry.distribution)}
      </td>
      <td class="target-cell">
        <div class="upside ${upCls}">${fmtPct(upside)}</div>
        <div class="target-range">${ptRange}</div>
      </td>
      <td class="earnings-cell">${earningsBadge}</td>
      <td class="score-cell">
        <span class="score-pill ${scoreCls}">${score == null ? "—" : fmtPct(score)}</span>
      </td>
    </tr>
  `;
}

// --- Self-reported accuracy ------------------------------------------------

// For each snapshot pair (earlier, later) at least N days apart, count how
// often the sign of earlier.score6m matched the sign of (later.price -
// earlier.price). Also report a "no-skill baseline" = fraction of tickers
// that went up regardless of prediction, so the user can judge whether the
// hit rate is actually better than always saying "up".
export function computeAccuracy(history, daysBack = 30) {
  const snaps = Array.isArray(history?.snapshots) ? history.snapshots : [];
  if (snaps.length < 2) return null;
  const msWindow = daysBack * 24 * 60 * 60 * 1000;
  const tolMs = 2 * 24 * 60 * 60 * 1000; // ±2 days

  let pairs = 0;
  let hits = 0;
  let upMoves = 0;

  for (let i = 0; i < snaps.length; i++) {
    const later = snaps[i];
    // Find an earlier snapshot closest to `daysBack` behind.
    let earlier = null;
    for (let j = i - 1; j >= 0; j--) {
      const dt = later.t - snaps[j].t;
      if (dt >= msWindow - tolMs && dt <= msWindow + tolMs) {
        earlier = snaps[j];
        break;
      }
      if (dt > msWindow + tolMs) break;
    }
    if (!earlier) continue;

    for (const [sym, e] of Object.entries(earlier.tickers ?? {})) {
      const l = later.tickers?.[sym];
      if (!l || e.price == null || l.price == null || e.score6m == null) continue;
      if (e.price === 0) continue;
      const actualMove = l.price - e.price;
      if (actualMove === 0) continue;
      pairs++;
      if (Math.sign(actualMove) > 0) upMoves++;
      if (Math.sign(e.score6m) === Math.sign(actualMove)) hits++;
    }
  }

  if (pairs === 0) return null;
  return {
    daysBack,
    pairs,
    hitRate: hits / pairs,
    baselineUp: upMoves / pairs, // fraction going up — the "always bullish" baseline
  };
}

function renderAccuracy(acc) {
  if (!acc) {
    return `
      <div class="accuracy empty">
        Not enough history yet — accuracy will appear once the daily workflow
        has run for ≥ ${30}+2 days.
      </div>
    `;
  }
  const rate = (acc.hitRate * 100).toFixed(1);
  const base = (acc.baselineUp * 100).toFixed(1);
  const edge = (acc.hitRate - acc.baselineUp) * 100;
  const edgeCls = edge > 2 ? "pos" : edge < -2 ? "neg" : "neutral";
  return `
    <div class="accuracy">
      <div class="accuracy-main">
        <span class="accuracy-rate">${rate}%</span>
        <span class="accuracy-label">direction hit rate over ${acc.daysBack}d (${acc.pairs} predictions)</span>
      </div>
      <div class="accuracy-edge ${edgeCls}">
        ${edge > 0 ? "+" : ""}${edge.toFixed(1)} pts vs "always up" baseline (${base}%)
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------

export function renderLongterm({
  containerEl,
  accuracyEl,
  longterm,
  history,
  visibleTickers,
}) {
  if (!containerEl) {
    log.warn("renderLongterm: no container");
    return;
  }

  const entriesObj = longterm?.tickers ?? {};
  const visibleSet = new Set((visibleTickers ?? []).map((t) => t.symbol));

  const entries = Object.values(entriesObj)
    .filter((e) => !visibleSet.size || visibleSet.has(e.symbol))
    .filter((e) => e.consensus || e.priceTarget);

  if (entries.length === 0) {
    containerEl.innerHTML = `
      <p class="empty">
        No long-term data yet — the daily workflow hasn't run for this
        watchlist. Trigger <code>update-longterm.yml</code> from the Actions
        tab, or use Force refresh tickers.
      </p>
    `;
    if (accuracyEl) accuracyEl.innerHTML = renderAccuracy(null);
    return;
  }

  // Sort by composite score (null-last), then by consensus, then by upside.
  entries.sort((a, b) => {
    const sa = a.score6m ?? null;
    const sb = b.score6m ?? null;
    if (sa != null && sb != null) return sb - sa;
    if (sa != null) return -1;
    if (sb != null) return 1;
    const ca = a.consensus?.score ?? -999;
    const cb = b.consensus?.score ?? -999;
    return cb - ca;
  });

  const rows = entries.map(renderRow).join("");
  containerEl.innerHTML = `
    <table class="longterm-table">
      <thead>
        <tr>
          <th>Ticker</th>
          <th>Analyst consensus</th>
          <th>12m price target</th>
          <th>Next earnings</th>
          <th class="score-head" title="0.7 * target upside% + 0.3 * consensus*10. Only computed when both inputs exist.">
            6m score
          </th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  if (accuracyEl) {
    const acc = computeAccuracy(history, 30);
    accuracyEl.innerHTML = renderAccuracy(acc);
  }

  log.info(`renderLongterm: ${entries.length} rows`);
}
