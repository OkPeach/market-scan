#!/usr/bin/env node
// Fetches /quote for each ticker in config/tickers.json from Finnhub,
// writes data/stocks.json and appends to data/history.json (24h rolling).

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function ts() {
  return new Date().toISOString();
}
const log = {
  info: (...a) => console.log(`${ts()} [fetch-stocks]`, ...a),
  warn: (...a) => console.warn(`${ts()} [fetch-stocks] WARN`, ...a),
  error: (...a) => console.error(`${ts()} [fetch-stocks] ERROR`, ...a),
};

const API_KEY = process.env.FINNHUB_API_KEY;
if (!API_KEY) {
  log.error("FINNHUB_API_KEY env var NOT set — aborting");
  process.exit(1);
}
log.info(`FINNHUB_API_KEY loaded OK (length=${API_KEY.length})`);

// 50 req/min => ~1.2s between requests. Use 1300ms for a bit of safety margin.
const REQUEST_DELAY_MS = 1300;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(path, fallback) {
  try {
    const raw = await readFile(path, "utf8");
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function fetchQuote(symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${API_KEY}`;
  const t0 = Date.now();
  const res = await fetch(url);
  const dt = Date.now() - t0;
  if (!res.ok) {
    throw new Error(`quote ${symbol}: ${res.status} ${res.statusText} (${dt}ms)`);
  }
  const data = await res.json();
  return {
    price: data.c ?? null,
    changeAbs: data.d ?? null,
    changePct: data.dp ?? null,
    previousClose: data.pc ?? null,
    finnhubTimestamp: data.t ?? null,
  };
}

async function main() {
  const tickersPath = resolve(ROOT, "config/tickers.json");
  const stocksPath = resolve(ROOT, "data/stocks.json");
  const historyPath = resolve(ROOT, "data/history.json");
  log.info(`root=${ROOT}`);

  const tickersFile = await readJson(tickersPath, { tickers: [] });
  const tickers = tickersFile.tickers ?? [];
  if (tickers.length === 0) {
    log.error("no tickers configured in config/tickers.json");
    process.exit(1);
  }
  log.info(`loaded ${tickers.length} tickers from config`);

  const history = await readJson(historyPath, { history: {} });
  history.history ??= {};
  log.info(
    `loaded history for ${Object.keys(history.history).length} existing tickers`,
  );

  const now = Date.now();
  const stocks = [];
  let okCount = 0;
  let errCount = 0;

  for (let i = 0; i < tickers.length; i++) {
    const { symbol, name } = tickers[i];
    try {
      const q = await fetchQuote(symbol);
      if (q.price == null || q.price === 0) {
        log.warn(`${symbol}: empty quote, skipping`);
      } else {
        stocks.push({
          ticker: symbol,
          name,
          price: q.price,
          changePct: q.changePct,
          changeAbs: q.changeAbs,
          previousClose: q.previousClose,
          timestamp: now,
        });
        const series = (history.history[symbol] ??= []);
        series.push({ t: now, p: q.price });
        okCount++;
        log.info(
          `${symbol}: price=${q.price} change=${q.changePct?.toFixed(2)}%`,
        );
      }
    } catch (err) {
      errCount++;
      log.warn(`${symbol}: ${err.message}`);
    }
    if (i < tickers.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  const cutoff = now - HISTORY_WINDOW_MS;
  const validSymbols = new Set(tickers.map((t) => t.symbol));
  const prunedHistory = {};
  let prunedPoints = 0;
  for (const [sym, series] of Object.entries(history.history)) {
    if (!validSymbols.has(sym)) {
      prunedPoints += series.length;
      continue;
    }
    const kept = series.filter((pt) => pt.t >= cutoff);
    prunedPoints += series.length - kept.length;
    if (kept.length > 0) prunedHistory[sym] = kept;
  }
  log.info(
    `pruned ${prunedPoints} history points older than 24h or off-watchlist`,
  );

  await writeFile(
    stocksPath,
    JSON.stringify({ timestamp: now, stocks }, null, 2) + "\n",
  );
  await writeFile(
    historyPath,
    JSON.stringify({ history: prunedHistory }, null, 2) + "\n",
  );

  log.info(
    `wrote stocks.json (${stocks.length} quotes, ok=${okCount} err=${errCount}), ` +
      `history.json (${Object.keys(prunedHistory).length} tickers)`,
  );
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
