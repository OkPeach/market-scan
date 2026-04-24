#!/usr/bin/env node
// Pulls long-horizon signals for each ticker in config/tickers.json:
//   * /stock/recommendation      — analyst buy/hold/sell distribution by month
//   * /stock/price-target        — 12-month consensus target (mean/median/hi/lo)
//   * /calendar/earnings         — next earnings event (catalyst) within 90d
//
// Writes data/longterm.json (snapshot for the UI) and appends to
// data/longterm-history.json (rolling snapshot log for accuracy tracking).
//
// Only uses Finnhub free-tier endpoints. Rate-limited like the other scripts.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function ts() {
  return new Date().toISOString();
}
const log = {
  info: (...a) => console.log(`${ts()} [fetch-longterm]`, ...a),
  warn: (...a) => console.warn(`${ts()} [fetch-longterm] WARN`, ...a),
  error: (...a) => console.error(`${ts()} [fetch-longterm] ERROR`, ...a),
};

const API_KEY = process.env.FINNHUB_API_KEY;
if (!API_KEY) {
  log.error("FINNHUB_API_KEY env var NOT set — aborting");
  process.exit(1);
}
log.info(`FINNHUB_API_KEY loaded OK (length=${API_KEY.length})`);

const REQUEST_DELAY_MS = 1300;
const EARNINGS_LOOKAHEAD_DAYS = 90;
const MAX_HISTORY_SNAPSHOTS = 400;

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

async function getJson(label, url) {
  const t0 = Date.now();
  const res = await fetch(url);
  const dt = Date.now() - t0;
  if (!res.ok) throw new Error(`${label}: ${res.status} ${res.statusText} (${dt}ms)`);
  return await res.json();
}

async function fetchRecommendation(symbol) {
  const url = `https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(symbol)}&token=${API_KEY}`;
  const data = await getJson(`rec ${symbol}`, url);
  // Finnhub returns newest first; each entry covers roughly one month.
  return Array.isArray(data) ? data : [];
}

async function fetchPriceTarget(symbol) {
  const url = `https://finnhub.io/api/v1/stock/price-target?symbol=${encodeURIComponent(symbol)}&token=${API_KEY}`;
  const data = await getJson(`pt ${symbol}`, url);
  if (!data || typeof data !== "object") return null;
  // Finnhub returns empty object for unknown tickers.
  if (!data.targetMean && !data.targetMedian) return null;
  return data;
}

async function fetchEarnings(symbol, from, to) {
  const url =
    `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}` +
    `&symbol=${encodeURIComponent(symbol)}&token=${API_KEY}`;
  const data = await getJson(`earn ${symbol}`, url);
  const list = Array.isArray(data?.earningsCalendar) ? data.earningsCalendar : [];
  list.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  return list[0] ?? null;
}

// Normalize analyst distribution into a single [-2, +2] score:
//   strongBuy +2, buy +1, hold 0, sell -1, strongSell -2 — averaged per analyst.
function consensusScore(entry) {
  if (!entry) return null;
  const sb = entry.strongBuy ?? 0;
  const b = entry.buy ?? 0;
  const h = entry.hold ?? 0;
  const s = entry.sell ?? 0;
  const ss = entry.strongSell ?? 0;
  const total = sb + b + h + s + ss;
  if (total === 0) return null;
  const weighted = sb * 2 + b * 1 + h * 0 + s * -1 + ss * -2;
  return { score: weighted / total, total };
}

async function main() {
  const tickersPath = resolve(ROOT, "config/tickers.json");
  const stocksPath = resolve(ROOT, "data/stocks.json");
  const longtermPath = resolve(ROOT, "data/longterm.json");
  const historyPath = resolve(ROOT, "data/longterm-history.json");
  log.info(`root=${ROOT}`);

  const tickersFile = await readJson(tickersPath, { tickers: [] });
  const tickers = tickersFile.tickers ?? [];
  if (tickers.length === 0) {
    log.error("no tickers configured");
    process.exit(1);
  }
  log.info(`loaded ${tickers.length} tickers`);

  // Pull current prices from the stocks snapshot (if present) so we can
  // compute target upside without burning another API request per ticker.
  const stocksFile = await readJson(stocksPath, { stocks: [] });
  const priceMap = new Map();
  for (const s of stocksFile.stocks ?? []) {
    if (s.ticker && Number.isFinite(s.price)) priceMap.set(s.ticker, s.price);
  }
  log.info(`prices available for ${priceMap.size} tickers`);

  const now = Date.now();
  const from = isoDate(new Date(now));
  const to = isoDate(new Date(now + EARNINGS_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000));

  const entries = {};
  let okCount = 0;
  let errCount = 0;

  for (let i = 0; i < tickers.length; i++) {
    const { symbol, name } = tickers[i];
    const entry = {
      symbol,
      name,
      fetchedAt: now,
      price: priceMap.get(symbol) ?? null,
      consensus: null,
      consensus3mAgo: null,
      consensusTrend: null,
      distribution: null,
      priceTarget: null,
      targetUpsidePct: null,
      nextEarnings: null,
      score6m: null,
      errors: [],
    };

    try {
      const recs = await fetchRecommendation(symbol);
      const cur = recs[0] ?? null;
      const old = recs[2] ?? null; // Roughly 3 months ago (one entry per month).
      const c = consensusScore(cur);
      const c3 = consensusScore(old);
      entry.consensus = c;
      entry.consensus3mAgo = c3;
      entry.consensusTrend = c && c3 ? c.score - c3.score : null;
      if (cur) {
        entry.distribution = {
          strongBuy: cur.strongBuy ?? 0,
          buy: cur.buy ?? 0,
          hold: cur.hold ?? 0,
          sell: cur.sell ?? 0,
          strongSell: cur.strongSell ?? 0,
          period: cur.period ?? null,
        };
      }
    } catch (err) {
      log.warn(`${symbol} rec: ${err.message}`);
      entry.errors.push(`rec: ${err.message}`);
    }
    await sleep(REQUEST_DELAY_MS);

    try {
      const pt = await fetchPriceTarget(symbol);
      if (pt) {
        entry.priceTarget = {
          mean: pt.targetMean ?? null,
          median: pt.targetMedian ?? null,
          high: pt.targetHigh ?? null,
          low: pt.targetLow ?? null,
          analysts: pt.numberOfAnalysts ?? null,
          lastUpdated: pt.lastUpdated ?? null,
        };
        if (entry.price && pt.targetMean) {
          entry.targetUpsidePct = ((pt.targetMean - entry.price) / entry.price) * 100;
        }
      }
    } catch (err) {
      log.warn(`${symbol} pt: ${err.message}`);
      entry.errors.push(`pt: ${err.message}`);
    }
    await sleep(REQUEST_DELAY_MS);

    try {
      const earn = await fetchEarnings(symbol, from, to);
      if (earn) {
        entry.nextEarnings = {
          date: earn.date ?? null,
          hour: earn.hour ?? null,
          epsEstimate: earn.epsEstimate ?? null,
          revenueEstimate: earn.revenueEstimate ?? null,
        };
      }
    } catch (err) {
      log.warn(`${symbol} earn: ${err.message}`);
      entry.errors.push(`earn: ${err.message}`);
    }

    // Composite 6-month score:
    //   0.7 * targetUpsidePct + 0.3 * (consensus * 10)
    // consensus ∈ [-2, +2] scaled to [-20, +20] so it's comparable to %
    // upside. Only computed when we have both inputs, so the number is
    // never fabricated from nothing.
    if (entry.targetUpsidePct != null && entry.consensus?.score != null) {
      entry.score6m =
        0.7 * entry.targetUpsidePct + 0.3 * entry.consensus.score * 10;
    }

    entries[symbol] = entry;
    if (entry.consensus || entry.priceTarget) okCount++;
    else errCount++;

    const consStr = entry.consensus
      ? `${entry.consensus.score.toFixed(2)} (${entry.consensus.total} analysts)`
      : "—";
    const ptStr = entry.targetUpsidePct != null
      ? `${entry.targetUpsidePct > 0 ? "+" : ""}${entry.targetUpsidePct.toFixed(1)}%`
      : "—";
    log.info(`${symbol}: consensus=${consStr} targetUpside=${ptStr} earnings=${entry.nextEarnings?.date ?? "—"}`);

    if (i < tickers.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  await writeFile(
    longtermPath,
    JSON.stringify({ timestamp: now, tickers: entries }, null, 2) + "\n",
  );

  // Append a compact snapshot to history so the UI can compute self-reported
  // accuracy once enough snapshots have accumulated.
  const historyFile = await readJson(historyPath, { snapshots: [] });
  const snapshot = {
    t: now,
    tickers: {},
  };
  for (const [sym, e] of Object.entries(entries)) {
    if (e.price == null && e.score6m == null) continue;
    snapshot.tickers[sym] = {
      price: e.price,
      targetMean: e.priceTarget?.mean ?? null,
      consensus: e.consensus?.score ?? null,
      score6m: e.score6m ?? null,
    };
  }
  historyFile.snapshots = Array.isArray(historyFile.snapshots)
    ? historyFile.snapshots
    : [];
  historyFile.snapshots.push(snapshot);
  if (historyFile.snapshots.length > MAX_HISTORY_SNAPSHOTS) {
    historyFile.snapshots = historyFile.snapshots.slice(-MAX_HISTORY_SNAPSHOTS);
  }
  await writeFile(
    historyPath,
    JSON.stringify(historyFile, null, 2) + "\n",
  );

  log.info(
    `wrote longterm.json (${Object.keys(entries).length} tickers, ok=${okCount} err=${errCount}), ` +
      `history=${historyFile.snapshots.length} snapshots`,
  );
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
