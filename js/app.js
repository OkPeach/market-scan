// Main UI controller. Loads data, wires up sub-modules.

import { renderMovers } from "./stocks.js";
import { renderNews } from "./news.js";
import { renderForecast } from "./predictions.js";
import { initWatchlistEditor, getVisibleTickers } from "./watchlist.js";
import { createLogger } from "./logger.js";

const log = createLogger("app");

const REFRESH_INTERVAL_MS = 60_000;
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

// Filter stocks/history/news to only the visible watchlist (base minus hidden
// + extras). Extras without quote data simply drop out of movers/forecasts.
function applyWatchlist(data) {
  const baseTickers = data.tickers.tickers ?? [];
  const visible = getVisibleTickers(baseTickers);
  const visibleSet = new Set(visible.map((t) => t.symbol));

  const rawStocks = data.stocks.stocks ?? [];
  const stocks = rawStocks.filter((s) => visibleSet.has(s.ticker));

  const rawHistory = data.history.history ?? {};
  const history = {};
  for (const sym of visibleSet) {
    if (rawHistory[sym]) history[sym] = rawHistory[sym];
  }

  const rawNews = data.news.items ?? [];
  // Keep news items that aren't tagged with a ticker (general market news)
  // plus any tagged with a visible ticker.
  const news = rawNews.filter((it) => !it.ticker || visibleSet.has(it.ticker));

  log.debug(
    `applyWatchlist: visible=${visible.length} stocks=${stocks.length}/${rawStocks.length} ` +
      `news=${news.length}/${rawNews.length}`,
  );
  return { baseTickers, visible, stocks, history, news };
}

async function refresh(state, { reason = "auto" } = {}) {
  log.info(`refresh: start (reason=${reason})`);
  const t0 = performance.now();
  try {
    const data = await loadAll();
    state.data = data;

    const view = applyWatchlist(data);
    state.view = view;

    renderMovers({
      bestEl: document.getElementById("best-list"),
      worstEl: document.getElementById("worst-list"),
      stocks: view.stocks,
      history: view.history,
    });

    renderNews({
      listEl: document.getElementById("news-list"),
      items: view.news,
      stocks: view.stocks,
    });

    renderForecast({
      risersEl: document.getElementById("risers-list"),
      fallersEl: document.getElementById("fallers-list"),
      stocks: view.stocks,
      history: view.history,
      news: view.news,
    });

    document.getElementById("last-updated").textContent = formatTimestamp(
      data.stocks.timestamp,
    );

    if (state.watchlistUi) state.watchlistUi.rerender();

    const dt = (performance.now() - t0).toFixed(1);
    log.info(`refresh: done in ${dt}ms`);
  } catch (err) {
    log.error("refresh failed:", err);
    throw err;
  }
}

async function main() {
  log.info("main: boot");
  const state = { data: null, view: null, refreshing: false, watchlistUi: null };

  state.watchlistUi = initWatchlistEditor({
    editorEl: document.getElementById("watchlist-editor"),
    toggleBtn: document.getElementById("watchlist-toggle"),
    getContext: () => ({
      baseTickers: state.data?.tickers?.tickers ?? [],
      stocks: state.data?.stocks?.stocks ?? [],
    }),
    onChange: () => refresh(state, { reason: "watchlist-change" }),
  });

  const refreshBtn = document.getElementById("refresh-btn");
  if (!refreshBtn) {
    log.error("main: refresh-btn not found in DOM");
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
