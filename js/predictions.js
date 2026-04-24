// 24h predictions panel.
//
// The composite score is now computed server-side in
// scripts/compute-predictions.mjs. This module only renders the result and
// computes a client-side accuracy widget from predictions-history.json.
//
// Each prediction row in predictions.json looks like:
//   {
//     ticker, name, price,
//     base,            // today's %change from previous close
//     momentum,        // recent-half minus earlier-half % of 24h history
//     stddev,          // rolling %-return stddev (null if not enough history)
//     usedFallbackStddev: bool,
//     zBase, zMom,     // vol-normalized z-scores (in sigma units)
//     sentimentScore,  // null, or normalized [-1, +1] from /news-sentiment
//     sentimentBuzz,   // null or ~[0, 1]
//     newsCount,
//     newsSignal,      // contribution to composite
//     score            // composite (unit: roughly sigma)
//   }

import { createLogger } from "./logger.js";

const log = createLogger("predictions");

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtPct(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

function fmtSigma(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}σ`;
}

function fmtPrice(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function reasonTags(p) {
  const tags = [];
  if (Math.abs(p.base) >= 0.05) {
    tags.push(
      `<span class="tag ${p.base >= 0 ? "pos" : "neg"}">${fmtPct(p.base)} today</span>`,
    );
  }
  if (p.stddev != null) {
    tags.push(
      `<span class="tag neutral" title="30-point rolling stddev of %-returns in the 24h price series">${p.stddev.toFixed(2)}% vol</span>`,
    );
  } else if (p.usedFallbackStddev) {
    tags.push(
      `<span class="tag neutral" title="Not enough history — using 1.5% fallback vol">fallback vol</span>`,
    );
  }
  if (Math.abs(p.momentum) >= 0.05) {
    const dir = p.momentum >= 0 ? "↗" : "↘";
    const cls = p.momentum >= 0 ? "pos" : "neg";
    tags.push(
      `<span class="tag ${cls}" title="Recent half vs earlier half of 24h history">${dir} ${fmtPct(p.momentum)}</span>`,
    );
  }
  if (p.sentimentScore != null) {
    const sCls = p.sentimentScore > 0.05 ? "pos" : p.sentimentScore < -0.05 ? "neg" : "neutral";
    const label = p.sentimentScore > 0 ? "bullish" : p.sentimentScore < 0 ? "bearish" : "neutral";
    tags.push(
      `<span class="tag ${sCls}" title="companyNewsScore from /news-sentiment (weekly bullish/bearish aggregate)">
         ${label} ${(p.sentimentScore * 100).toFixed(0)}%
       </span>`,
    );
  } else if (p.newsCount > 0) {
    tags.push(
      `<span class="tag neutral">${p.newsCount} news item${p.newsCount === 1 ? "" : "s"}</span>`,
    );
  }
  return tags.join("");
}

function forecastRow(p, kind) {
  const scoreCls = kind === "up" ? "pos" : "neg";
  const tooltip = [
    `zBase: ${p.zBase?.toFixed(2) ?? "—"}σ`,
    `zMom:  ${p.zMom?.toFixed(2) ?? "—"}σ`,
    `news:  ${p.newsSignal?.toFixed(2) ?? "—"}`,
    p.stddev != null ? `stddev: ${p.stddev.toFixed(2)}%` : "stddev: fallback",
  ].join("\n");
  return `
    <li class="forecast" title="${esc(tooltip)}">
      <div class="forecast-head">
        <span class="ticker">${esc(p.ticker)}</span>
        <span class="name" title="${esc(p.name ?? "")}">${esc(p.name ?? "")}</span>
        <span class="price">${fmtPrice(p.price)}</span>
        <span class="score ${scoreCls}">${fmtSigma(p.score)}</span>
      </div>
      <div class="forecast-reasons">${reasonTags(p)}</div>
    </li>
  `;
}

// --- 24h self-reported accuracy --------------------------------------------

// For each pair of snapshots roughly 24h apart (±2h), count how often the
// prediction score's sign matched the subsequent actual 24h price move.
// Also reports the "always up" baseline (fraction of tickers that went up
// regardless of prediction) so the hit rate can be judged against noise.
export function computeAccuracy(history, hoursBack = 24) {
  const snaps = Array.isArray(history?.snapshots) ? history.snapshots : [];
  if (snaps.length < 2) return null;
  const msWindow = hoursBack * 60 * 60 * 1000;
  const tolMs = 2 * 60 * 60 * 1000;

  let pairs = 0;
  let hits = 0;
  let upMoves = 0;

  for (let i = 0; i < snaps.length; i++) {
    const later = snaps[i];
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
      if (!l || e.price == null || l.price == null || e.score == null) continue;
      if (e.price === 0) continue;
      const move = l.price - e.price;
      if (move === 0) continue;
      pairs++;
      if (Math.sign(move) > 0) upMoves++;
      if (Math.sign(e.score) === Math.sign(move)) hits++;
    }
  }

  if (pairs === 0) return null;
  return {
    hoursBack,
    pairs,
    hitRate: hits / pairs,
    baselineUp: upMoves / pairs,
  };
}

function renderAccuracy(acc) {
  if (!acc) {
    return `
      <div class="accuracy empty">
        Not enough 24h history yet — accuracy appears once the stocks
        workflow has run for ≥ 25 hours.
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
        <span class="accuracy-label">24h direction hit rate (${acc.pairs} predictions)</span>
      </div>
      <div class="accuracy-edge ${edgeCls}">
        ${edge > 0 ? "+" : ""}${edge.toFixed(1)} pts vs "always up" baseline (${base}%)
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------

export function renderForecast({
  risersEl,
  fallersEl,
  accuracyEl,
  predictionsFile,
  predictionsHistory,
  visibleSet,
}) {
  if (!risersEl || !fallersEl) {
    log.warn("renderForecast: missing list elements");
    return;
  }

  const all = Array.isArray(predictionsFile?.predictions) ? predictionsFile.predictions : [];
  const visible = visibleSet && visibleSet.size
    ? all.filter((p) => visibleSet.has(p.ticker))
    : all;

  if (visible.length === 0) {
    const empty = '<li class="empty">No data yet — waiting for first workflow run.</li>';
    risersEl.innerHTML = empty;
    fallersEl.innerHTML = empty;
    if (accuracyEl) accuracyEl.innerHTML = renderAccuracy(null);
    return;
  }

  const sorted = visible.slice().sort((a, b) => b.score - a.score);
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

  if (accuracyEl) {
    const acc = computeAccuracy(predictionsHistory, 24);
    accuracyEl.innerHTML = renderAccuracy(acc);
  }

  log.info(
    `renderForecast: risers=[${risers.map((p) => p.ticker).join(",")}] ` +
      `fallers=[${fallers.map((p) => p.ticker).join(",")}]`,
  );
}
