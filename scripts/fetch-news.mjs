#!/usr/bin/env node
// Fetches /company-news for each ticker and the general market /news feed,
// deduplicates, keeps the most recent 100 items, writes data/news.json.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function ts() {
  return new Date().toISOString();
}
const log = {
  info: (...a) => console.log(`${ts()} [fetch-news]`, ...a),
  warn: (...a) => console.warn(`${ts()} [fetch-news] WARN`, ...a),
  error: (...a) => console.error(`${ts()} [fetch-news] ERROR`, ...a),
};

const API_KEY = process.env.FINNHUB_API_KEY;
if (!API_KEY) {
  log.error("FINNHUB_API_KEY env var NOT set — aborting");
  process.exit(1);
}
log.info(`FINNHUB_API_KEY loaded OK (length=${API_KEY.length})`);

const REQUEST_DELAY_MS = 1300; // ~50 req/min
const MAX_ITEMS = 100;
const WINDOW_MS = 24 * 60 * 60 * 1000;

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

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchCompanyNews(symbol, fromDate, toDate) {
  const url =
    `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}` +
    `&from=${fromDate}&to=${toDate}&token=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`company-news ${symbol}: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchGeneralNews() {
  const url = `https://finnhub.io/api/v1/news?category=general&token=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`general news: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function normalize(raw, ticker) {
  // Finnhub news: { category, datetime (sec), headline, id, image, related, source, summary, url }
  return {
    id: raw.id ?? raw.url,
    headline: raw.headline ?? "",
    source: raw.source ?? "",
    url: raw.url ?? "",
    summary: raw.summary ?? "",
    image: raw.image ?? "",
    datetime: (raw.datetime ?? 0) * 1000, // ms
    ticker: ticker ?? (raw.related ? String(raw.related).split(",")[0] : null),
    category: raw.category ?? "general",
  };
}

async function main() {
  const tickersPath = resolve(ROOT, "config/tickers.json");
  const newsPath = resolve(ROOT, "data/news.json");
  log.info(`root=${ROOT}`);

  const tickersFile = await readJson(tickersPath, { tickers: [] });
  const tickers = tickersFile.tickers ?? [];
  log.info(`loaded ${tickers.length} tickers from config`);

  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const today = new Date(now);
  const yesterday = new Date(now - WINDOW_MS);

  const fromDate = isoDate(yesterday);
  const toDate = isoDate(today);

  const items = [];
  let generalCount = 0;
  let perTickerCount = 0;

  try {
    const gen = await fetchGeneralNews();
    generalCount = gen.length;
    for (const r of gen) items.push(normalize(r, null));
    log.info(`general news: ${generalCount} items`);
  } catch (err) {
    log.warn(`general news error: ${err.message}`);
  }
  if (tickers.length > 0) await sleep(REQUEST_DELAY_MS);

  for (let i = 0; i < tickers.length; i++) {
    const { symbol } = tickers[i];
    try {
      const list = await fetchCompanyNews(symbol, fromDate, toDate);
      for (const r of list) items.push(normalize(r, symbol));
      perTickerCount += list.length;
      log.info(`${symbol}: ${list.length} items`);
    } catch (err) {
      log.warn(`${symbol}: ${err.message}`);
    }
    if (i < tickers.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  // Deduplicate by URL (fall back to id).
  const seen = new Map();
  for (const it of items) {
    const key = it.url || it.id;
    if (!key) continue;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, it);
    } else if (!prev.ticker && it.ticker) {
      // Prefer the ticker-tagged version when available.
      seen.set(key, it);
    }
  }

  const merged = Array.from(seen.values())
    .filter((it) => it.datetime >= cutoff)
    .sort((a, b) => b.datetime - a.datetime)
    .slice(0, MAX_ITEMS);

  await writeFile(
    newsPath,
    JSON.stringify({ timestamp: now, items: merged }, null, 2) + "\n",
  );

  log.info(
    `wrote news.json: ${merged.length} merged items ` +
      `(general=${generalCount}, per-ticker=${perTickerCount}, ` +
      `deduped=${seen.size}, within-24h=${merged.length})`,
  );
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
