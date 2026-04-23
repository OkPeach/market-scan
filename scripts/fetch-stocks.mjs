#!/usr/bin/env node
// Fetches /quote for each ticker in config/tickers.json from Finnhub,
// writes data/stocks.json and appends to data/history.json (24h rolling).

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const API_KEY = process.env.FINNHUB_API_KEY;
if (!API_KEY) {
  console.error("FINNHUB_API_KEY env var is required");
  process.exit(1);
}

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
  const res = await fetch(url);
  if (!res.ok) throw new Error(`quote ${symbol}: ${res.status} ${res.statusText}`);
  const data = await res.json();
  // Finnhub /quote: { c: current, d: change, dp: percentChange, h, l, o, pc, t }
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

  const tickersFile = await readJson(tickersPath, { tickers: [] });
  const tickers = tickersFile.tickers ?? [];
  if (tickers.length === 0) {
    console.error("No tickers configured");
    process.exit(1);
  }

  const history = await readJson(historyPath, { history: {} });
  history.history ??= {};

  const now = Date.now();
  const stocks = [];

  for (let i = 0; i < tickers.length; i++) {
    const { symbol, name } = tickers[i];
    try {
      const q = await fetchQuote(symbol);
      if (q.price == null || q.price === 0) {
        console.warn(`skip ${symbol}: empty quote`);
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
      }
    } catch (err) {
      console.warn(`error ${symbol}:`, err.message);
    }
    if (i < tickers.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  // Prune history older than 24h and drop tickers no longer in the watchlist.
  const cutoff = now - HISTORY_WINDOW_MS;
  const validSymbols = new Set(tickers.map((t) => t.symbol));
  const prunedHistory = {};
  for (const [sym, series] of Object.entries(history.history)) {
    if (!validSymbols.has(sym)) continue;
    const kept = series.filter((pt) => pt.t >= cutoff);
    if (kept.length > 0) prunedHistory[sym] = kept;
  }

  await writeFile(
    stocksPath,
    JSON.stringify({ timestamp: now, stocks }, null, 2) + "\n",
  );
  await writeFile(
    historyPath,
    JSON.stringify({ history: prunedHistory }, null, 2) + "\n",
  );

  console.log(`wrote ${stocks.length} quotes, history covers ${Object.keys(prunedHistory).length} tickers`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
