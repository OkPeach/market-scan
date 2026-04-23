// Predictions: localStorage CRUD, expiry resolution, leaderboards.

import { createLogger } from "./logger.js";

const log = createLogger("predictions");
//
// Schema:
// {
//   id: string,
//   ticker: string,
//   direction: "buy" | "sell",
//   targetPct: number,        // target % move from start price
//   windowHours: number,
//   createdAt: number,        // ms epoch
//   expiresAt: number,        // ms epoch
//   startPrice: number,       // captured from current quote at submit time
//   resolved: boolean,
//   actualPct: number | null, // signed % move from startPrice to endPrice
//   endPrice: number | null,
//   hit: boolean | null,      // direction matched and |actualPct| >= targetPct
// }

const STORAGE_KEY = "market-scan/predictions/v1";
const LEADERBOARD_WINDOW_MS = 24 * 60 * 60 * 1000;

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    log.warn("load: failed to parse localStorage, starting empty:", err.message);
    return [];
  }
}

function save(predictions) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(predictions));
    log.debug(`save: ${predictions.length} predictions persisted`);
  } catch (err) {
    log.warn("save: could not persist predictions:", err.message);
  }
}

function uid() {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtRelative(ms) {
  const diff = ms - Date.now();
  const sign = diff >= 0 ? "in " : "";
  const suffix = diff >= 0 ? "" : " ago";
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  if (min < 60) return `${sign}${min}m${suffix}`;
  const h = Math.round(min / 60);
  if (h < 24) return `${sign}${h}h${suffix}`;
  const d = Math.round(h / 24);
  return `${sign}${d}d${suffix}`;
}

export function initPredictionForm({ formEl, onChange }) {
  if (!formEl) {
    log.warn("initPredictionForm: no form element");
    return;
  }
  log.info("initPredictionForm: wired");

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const ticker = formEl.querySelector("#pf-ticker").value;
    const direction = formEl.querySelector("#pf-direction").value;
    const targetPct = parseFloat(formEl.querySelector("#pf-target").value);
    const windowHours = parseInt(formEl.querySelector("#pf-window").value, 10);

    log.info(
      `submit: ticker=${ticker} dir=${direction} target=${targetPct}% window=${windowHours}h`,
    );

    if (!ticker || !direction || !Number.isFinite(targetPct) || !Number.isFinite(windowHours)) {
      log.warn("submit: invalid form values, ignoring");
      return;
    }

    const startPrice = currentPriceFor(ticker);
    if (startPrice == null) {
      log.warn(`submit: no current price for ${ticker}, cannot record`);
      alert(
        `No current price available for ${ticker} yet. Wait for the next data refresh.`,
      );
      return;
    }

    const now = Date.now();
    const prediction = {
      id: uid(),
      ticker,
      direction,
      targetPct,
      windowHours,
      createdAt: now,
      expiresAt: now + windowHours * 60 * 60 * 1000,
      startPrice,
      resolved: false,
      actualPct: null,
      endPrice: null,
      hit: null,
    };

    const all = load();
    all.push(prediction);
    save(all);
    log.info(
      `submit: recorded prediction ${prediction.id} (startPrice=${startPrice})`,
    );

    formEl.querySelector("#pf-target").value = "1";
    formEl.querySelector("#pf-window").value = "4";

    if (onChange) onChange();
  });

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".prediction .delete");
    if (!btn) return;
    const id = btn.dataset.id;
    if (!id) return;
    const before = load();
    const filtered = before.filter((p) => p.id !== id);
    save(filtered);
    log.info(`delete: removed ${id} (${before.length} -> ${filtered.length})`);
    if (onChange) onChange();
  });
}

// Cached snapshot of the most recent stock map, set by resolveExpired so
// the form can read a current price during submit without an extra param.
let currentStockMap = new Map();
function currentPriceFor(ticker) {
  const s = currentStockMap.get(ticker);
  return s?.price ?? null;
}

export function resolveExpired({ stockMap, history, now }) {
  currentStockMap = stockMap;
  const all = load();
  let changed = 0;
  let skipped = 0;

  for (const p of all) {
    if (p.resolved) continue;
    if (now < p.expiresAt) continue;

    const endPrice = priceAtOrAfter(history[p.ticker], p.expiresAt) ??
      stockMap.get(p.ticker)?.price ?? null;

    if (endPrice == null || p.startPrice == null || p.startPrice === 0) {
      skipped++;
      continue;
    }

    const actualPct = ((endPrice - p.startPrice) / p.startPrice) * 100;
    const directionMatch =
      (p.direction === "buy" && actualPct > 0) ||
      (p.direction === "sell" && actualPct < 0);
    const magnitudeMet = Math.abs(actualPct) >= p.targetPct;

    p.resolved = true;
    p.actualPct = actualPct;
    p.endPrice = endPrice;
    p.hit = directionMatch && magnitudeMet;
    changed++;
    log.info(
      `resolve: ${p.id} ${p.ticker} ${p.direction} actual=${actualPct.toFixed(2)}% hit=${p.hit}`,
    );
  }

  if (changed) save(all);
  log.debug(
    `resolveExpired: total=${all.length} resolved=${changed} skipped=${skipped}`,
  );
}

function priceAtOrAfter(series, t) {
  if (!Array.isArray(series) || series.length === 0) return null;
  // Find the first sample at or after t.
  for (const pt of series) {
    if (pt.t >= t) return pt.p;
  }
  // Otherwise fall back to the most recent sample (best available).
  return series[series.length - 1].p;
}

function predictionRow(p, { withDelete = false } = {}) {
  const dirClass = p.direction === "buy" ? "buy" : "sell";
  const dirLabel = p.direction.toUpperCase();
  const ticker = `<span class="ticker-badge">${p.ticker}</span>`;
  const dir = `<span class="dir-tag ${dirClass}">${dirLabel}</span>`;
  const target = `target ${fmtPct(p.targetPct)} / ${p.windowHours}h`;
  const start = `start ${p.startPrice?.toFixed(2) ?? "—"}`;

  let outcome;
  let cls = "prediction";
  if (p.resolved) {
    cls += p.hit ? " hit" : " miss";
    outcome = `${fmtPct(p.actualPct)} ${p.hit ? "✓" : "✗"}`;
  } else {
    outcome = `expires ${fmtRelative(p.expiresAt)}`;
  }

  const del = withDelete
    ? `<button class="delete" data-id="${p.id}" title="Delete">×</button>`
    : "";

  return `
    <li class="${cls}">
      <span>${ticker} ${dir}</span>
      <span class="meta">${target} · ${start}</span>
      <span class="outcome">${outcome} ${del}</span>
    </li>
  `;
}

function renderList(el, items, opts) {
  if (!el) return;
  if (items.length === 0) return; // keep existing empty placeholder
  el.innerHTML = items.map((p) => predictionRow(p, opts)).join("");
}

export function renderPredictionLists({ openEl, buyEl, sellEl, bestEl }) {
  const all = load();
  const now = Date.now();
  const cutoff = now - LEADERBOARD_WINDOW_MS;

  const open = all
    .filter((p) => !p.resolved)
    .sort((a, b) => a.expiresAt - b.expiresAt);

  const recent = all.filter((p) => p.resolved && p.createdAt >= cutoff);
  const buys = recent.filter((p) => p.direction === "buy");
  const sells = recent.filter((p) => p.direction === "sell");

  const accuracy = (p) =>
    p.actualPct == null ? -Infinity : Math.abs(p.actualPct);
  const sortByAccuracy = (a, b) => accuracy(b) - accuracy(a);

  const bestSorted = recent
    .filter((p) => p.hit)
    .sort(sortByAccuracy);

  if (openEl) {
    openEl.innerHTML = open.length
      ? open.map((p) => predictionRow(p, { withDelete: true })).join("")
      : '<li class="empty">No open predictions.</li>';
  }
  if (buyEl) {
    buyEl.innerHTML = buys.length
      ? buys.sort(sortByAccuracy).map((p) => predictionRow(p)).join("")
      : '<li class="empty">No resolved buy predictions yet.</li>';
  }
  if (sellEl) {
    sellEl.innerHTML = sells.length
      ? sells.sort(sortByAccuracy).map((p) => predictionRow(p)).join("")
      : '<li class="empty">No resolved sell predictions yet.</li>';
  }
  if (bestEl) {
    bestEl.innerHTML = bestSorted.length
      ? bestSorted.map((p) => predictionRow(p)).join("")
      : '<li class="empty">No hits yet.</li>';
  }
  log.debug(
    `renderPredictionLists: open=${open.length} buy=${buys.length} ` +
      `sell=${sells.length} hits=${bestSorted.length}`,
  );
}
