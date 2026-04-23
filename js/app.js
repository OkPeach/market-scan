// Main UI controller. Loads data, wires up sub-modules.

import { renderMovers, populateTickerSelect } from "./stocks.js";
import { renderNews } from "./news.js";
import {
  initPredictionForm,
  resolveExpired,
  renderPredictionLists,
} from "./predictions.js";

const REFRESH_INTERVAL_MS = 60_000; // poll JSON files once a minute

async function loadJson(path, fallback) {
  try {
    const res = await fetch(`${path}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    const text = await res.text();
    return text.trim() ? JSON.parse(text) : fallback;
  } catch (err) {
    console.warn(`failed to load ${path}:`, err.message);
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
  const [stocks, news, history, tickers] = await Promise.all([
    loadJson("data/stocks.json", { timestamp: null, stocks: [] }),
    loadJson("data/news.json", { timestamp: null, items: [] }),
    loadJson("data/history.json", { history: {} }),
    loadJson("config/tickers.json", { tickers: [] }),
  ]);
  return { stocks, news, history, tickers };
}

async function refresh(state) {
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

  // Resolve any expired predictions against current price data, then render.
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
}

async function main() {
  const state = { data: null, refreshing: false };

  initPredictionForm({
    formEl: document.getElementById("prediction-form"),
    onChange: () => refresh(state),
  });

  const refreshBtn = document.getElementById("refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      if (state.refreshing) return;
      state.refreshing = true;
      refreshBtn.disabled = true;
      refreshBtn.classList.add("is-loading");
      try {
        await refresh(state);
      } finally {
        state.refreshing = false;
        refreshBtn.disabled = false;
        refreshBtn.classList.remove("is-loading");
      }
    });
  }

  await refresh(state);

  // Periodically reload JSON files so a workflow commit shows up without a hard refresh.
  setInterval(() => refresh(state), REFRESH_INTERVAL_MS);
}

main().catch((err) => {
  console.error("app boot failed:", err);
  document.getElementById("news-list").innerHTML =
    `<p class="empty">Failed to load: ${err.message}</p>`;
});
