// Main UI controller. Loads data, wires up sub-modules.

import { renderMovers, populateTickerSelect } from "./stocks.js";
import { renderNews } from "./news.js";
import {
  initPredictionForm,
  resolveExpired,
  renderPredictionLists,
} from "./predictions.js";
import { createLogger } from "./logger.js";

const log = createLogger("app");

const REFRESH_INTERVAL_MS = 60_000; // poll JSON files once a minute
// Minimum visible spinner time for the manual refresh, so the user gets
// visual feedback even when the underlying fetches finish in a few ms.
const MIN_SPIN_MS = 350;

log.info("module loaded");

async function loadJson(path, fallback) {
  const url = `${path}?_=${Date.now()}`;
  log.debug(`fetch ${url}`);
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
    const text = await res.text();
    const parsed = text.trim() ? JSON.parse(text) : fallback;
    log.debug(`ok ${path} (${text.length} bytes)`);
    return parsed;
  } catch (err) {
    log.warn(`failed to load ${path}:`, err.message);
    return fallback;
  }
}

function formatTimestamp(ms) {
  if (!ms) return "never";
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function loadAll() {
  log.info("loadAll: start");
  const t0 = performance.now();
  const [stocks, news, history, tickers] = await Promise.all([
    loadJson("data/stocks.json", { timestamp: null, stocks: [] }),
    loadJson("data/news.json", { timestamp: null, items: [] }),
    loadJson("data/history.json", { history: {} }),
    loadJson("config/tickers.json", { tickers: [] }),
  ]);
  const dt = (performance.now() - t0).toFixed(1);
  log.info(
    `loadAll: done in ${dt}ms — stocks=${stocks.stocks?.length ?? 0}, ` +
      `news=${news.items?.length ?? 0}, ` +
      `history=${Object.keys(history.history ?? {}).length} tickers, ` +
      `tickers=${tickers.tickers?.length ?? 0}`,
  );
  return { stocks, news, history, tickers };
}

async function refresh(state, { reason = "auto" } = {}) {
  log.info(`refresh: start (reason=${reason})`);
  const t0 = performance.now();
  try {
    const data = await loadAll();
    state.data = data;

    populateTickerSelect(
      document.getElementById("pf-ticker"),
      data.tickers.tickers ?? [],
    );

    renderMovers({
      bestEl: document.getElementById("best-list"),
      worstEl: document.getElementById("worst-list"),
      stocks: data.stocks.stocks ?? [],
      history: data.history.history ?? {},
    });

    renderNews({
      listEl: document.getElementById("news-list"),
      items: data.news.items ?? [],
      stocks: data.stocks.stocks ?? [],
    });

    const stockMap = new Map(
      (data.stocks.stocks ?? []).map((s) => [s.ticker, s]),
    );
    resolveExpired({
      stockMap,
      history: data.history.history ?? {},
      now: Date.now(),
    });
    renderPredictionLists({
      openEl: document.getElementById("open-list"),
      buyEl: document.getElementById("buy-leaderboard"),
      sellEl: document.getElementById("sell-leaderboard"),
      bestEl: document.getElementById("best-predictions"),
    });

    document.getElementById("last-updated").textContent = formatTimestamp(
      data.stocks.timestamp,
    );

    const dt = (performance.now() - t0).toFixed(1);
    log.info(`refresh: done in ${dt}ms`);
  } catch (err) {
    log.error("refresh failed:", err);
    throw err;
  }
}

async function main() {
  log.info("main: boot");
  const state = { data: null, refreshing: false };

  const formEl = document.getElementById("prediction-form");
  if (!formEl) log.warn("main: prediction-form not found");
  initPredictionForm({
    formEl,
    onChange: () => refresh(state, { reason: "prediction-change" }),
  });

  const refreshBtn = document.getElementById("refresh-btn");
  if (!refreshBtn) {
    log.error("main: refresh-btn not found in DOM — button will be inert");
  } else {
    log.info("main: refresh button wired");
    refreshBtn.addEventListener("click", async (e) => {
      log.info("refresh button: click", { target: e.target?.id });
      if (state.refreshing) {
        log.warn("refresh button: ignored (already refreshing)");
        return;
      }
      state.refreshing = true;
      refreshBtn.disabled = true;
      refreshBtn.classList.add("is-loading");
      const t0 = performance.now();
      try {
        await refresh(state, { reason: "manual" });
      } catch (err) {
        log.error("refresh button: refresh threw", err);
      } finally {
        const elapsed = performance.now() - t0;
        if (elapsed < MIN_SPIN_MS) {
          await new Promise((r) => setTimeout(r, MIN_SPIN_MS - elapsed));
        }
        state.refreshing = false;
        refreshBtn.disabled = false;
        refreshBtn.classList.remove("is-loading");
        log.info("refresh button: done");
      }
    });
  }

  await refresh(state, { reason: "boot" });

  setInterval(() => {
    log.debug("interval: refreshing");
    refresh(state, { reason: "interval" }).catch((err) =>
      log.error("interval refresh failed:", err),
    );
  }, REFRESH_INTERVAL_MS);
  log.info(`main: polling every ${REFRESH_INTERVAL_MS / 1000}s`);
}

main().catch((err) => {
  log.error("app boot failed:", err);
  const list = document.getElementById("news-list");
  if (list) {
    list.innerHTML = `<p class="empty">Failed to load: ${err.message}</p>`;
  }
});
