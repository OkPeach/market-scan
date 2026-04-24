#!/usr/bin/env node
// Computes 24h predictions server-side from the latest snapshots written by
// fetch-stocks.mjs and fetch-news.mjs. Runs on the same 10-min cadence as
// fetch-stocks and writes:
//
//   data/predictions.json         — current snapshot for the UI to render
//   data/predictions-history.json — hourly snapshots for 24h accuracy tracking
//
// Signals:
//   zBase      = changePct / rolling stddev of returns (vol-normalized move)
//   zMomentum  = (recent half avg - earlier half avg) / stddev
//   newsSignal = companyNewsScore (if /news-sentiment available) * buzz boost
//                else: sign(changePct) * log(1 + count) * 0.15
//   score      = zBase * (1 + |zMom| * alignment * 0.3) + newsSignal * 0.6
//
// Alignment: 1.0 when zBase and zMomentum share sign, else 0.4 — mixed
// signals dampen conviction.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function ts() {
  return new Date().toISOString();
}
const log = {
  info: (...a) => console.log(`${ts()} [compute-predictions]`, ...a),
  warn: (...a) => console.warn(`${ts()} [compute-predictions] WARN`, ...a),
  error: (...a) => console.error(`${ts()} [compute-predictions] ERROR`, ...a),
};

// History file: capped to ~9 days at hourly cadence. 24h accuracy pairs only
// need 24h window, so this is plenty.
const HISTORY_CAP = 220;
const SNAPSHOT_INTERVAL_MS = 50 * 60 * 1000;
// Fallback daily volatility when we don't have enough history. Typical
// large-cap stock moves ~1.5%/day stddev.
const FALLBACK_STDDEV_PCT = 1.5;
// Floor on the effective stddev used in z-score denominators. Prevents the
// score from exploding when a ticker happens to have a near-monotonic 24h
// price series (very low stddev of returns) — a real-world rarity but one
// that blows up the UI when it happens.
const MIN_EFFECTIVE_STDDEV_PCT = 0.35;

async function readJson(path, fallback) {
  try {
    const raw = await readFile(path, "utf8");
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

// Rolling stddev of percentage returns between consecutive history points.
// series: [{ t, p }, ...]
function pctReturnsStddev(series) {
  if (!Array.isArray(series) || series.length < 3) return null;
  const rets = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1].p;
    const cur = series[i].p;
    if (!prev || !Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    rets.push(((cur - prev) / prev) * 100);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance);
}

function computeMomentum(series) {
  if (!Array.isArray(series) || series.length < 4) return 0;
  const n = series.length;
  const half = Math.floor(n / 2);
  const earlier = series.slice(0, half);
  const recent = series.slice(half);
  const avg = (arr) => arr.reduce((a, p) => a + p.p, 0) / arr.length;
  const e = avg(earlier);
  const r = avg(recent);
  if (!e) return 0;
  return ((r - e) / e) * 100;
}

function signOrZero(x) {
  if (!Number.isFinite(x) || x === 0) return 0;
  return x > 0 ? 1 : -1;
}

async function main() {
  const stocksPath = resolve(ROOT, "data/stocks.json");
  const historyPath = resolve(ROOT, "data/history.json");
  const newsPath = resolve(ROOT, "data/news.json");
  const sentimentPath = resolve(ROOT, "data/sentiment.json");
  const outPath = resolve(ROOT, "data/predictions.json");
  const snapshotPath = resolve(ROOT, "data/predictions-history.json");

  const stocks = await readJson(stocksPath, { timestamp: null, stocks: [] });
  const history = await readJson(historyPath, { history: {} });
  const news = await readJson(newsPath, { timestamp: null, items: [] });
  const sentiment = await readJson(sentimentPath, { timestamp: null, tickers: {} });

  if (!stocks.stocks || stocks.stocks.length === 0) {
    log.warn("no stocks data yet — writing empty prediction snapshot");
    await writeFile(
      outPath,
      JSON.stringify(
        { timestamp: Date.now(), predictions: [], risers: [], fallers: [] },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  log.info(
    `inputs: stocks=${stocks.stocks.length} news=${(news.items ?? []).length} ` +
      `sentiment=${Object.keys(sentiment.tickers ?? {}).length}`,
  );

  // News counts per ticker (fallback signal when no sentiment).
  const newsCounts = {};
  for (const item of news.items ?? []) {
    if (item && item.ticker) {
      newsCounts[item.ticker] = (newsCounts[item.ticker] ?? 0) + 1;
    }
  }

  const predictions = [];
  let haveSentiment = 0;
  let haveStddev = 0;

  for (const s of stocks.stocks) {
    const series = history.history?.[s.ticker] ?? [];
    const stddev = pctReturnsStddev(series);
    if (stddev != null) haveStddev++;
    const effStddev = Math.max(
      MIN_EFFECTIVE_STDDEV_PCT,
      stddev && stddev > 0 ? stddev : FALLBACK_STDDEV_PCT,
    );

    const base = Number.isFinite(s.changePct) ? s.changePct : 0;
    const zBase = base / effStddev;

    const momentum = computeMomentum(series);
    const zMom = momentum / effStddev;

    const signsMatch = signOrZero(zBase) === signOrZero(zMom) && zBase !== 0 && zMom !== 0;
    const alignment = signsMatch ? 1 : 0.4;

    const sent = sentiment.tickers?.[s.ticker];
    let newsSignal = 0;
    let sentimentNorm = null;
    if (sent && Number.isFinite(sent.normalizedScore)) {
      haveSentiment++;
      sentimentNorm = sent.normalizedScore; // already in [-1, +1]
      const buzz = Math.log(1 + Math.max(0, sent.buzz ?? 0));
      // Scale sentiment into the same ballpark as zBase (units of sigma).
      // A maximum-bullish story on a high-buzz day ≈ ±1.5σ equivalent.
      newsSignal = sentimentNorm * (1 + buzz * 0.3) * 1.5;
    } else {
      // Fallback: signed log-attention, capped to avoid dominating.
      const count = newsCounts[s.ticker] ?? 0;
      newsSignal = signOrZero(base) * Math.log(1 + count) * 0.5;
    }

    const composite = zBase * (1 + Math.abs(zMom) * alignment * 0.3) + newsSignal * 0.6;

    predictions.push({
      ticker: s.ticker,
      name: s.name,
      price: s.price,
      base,
      momentum,
      stddev: stddev ?? null,
      usedFallbackStddev: stddev == null,
      zBase,
      zMom,
      sentimentScore: sentimentNorm,
      sentimentBuzz: sent?.buzz ?? null,
      newsCount: newsCounts[s.ticker] ?? 0,
      newsSignal,
      score: composite,
    });
  }

  predictions.sort((a, b) => b.score - a.score);

  const risers = predictions.filter((p) => p.score > 0).slice(0, 5);
  const fallers = predictions
    .filter((p) => p.score < 0)
    .slice(-5)
    .reverse();

  const now = Date.now();
  await writeFile(
    outPath,
    JSON.stringify(
      {
        timestamp: now,
        meta: {
          stocksTimestamp: stocks.timestamp,
          newsTimestamp: news.timestamp,
          sentimentTimestamp: sentiment.timestamp,
          tickersWithSentiment: haveSentiment,
          tickersWithStddev: haveStddev,
          fallbackStddevPct: FALLBACK_STDDEV_PCT,
        },
        predictions,
        risers,
        fallers,
      },
      null,
      2,
    ) + "\n",
  );
  log.info(
    `wrote predictions.json (${predictions.length} total, ${risers.length} risers / ${fallers.length} fallers, ` +
      `sentiment ${haveSentiment}/${predictions.length}, stddev ${haveStddev}/${predictions.length})`,
  );

  // Snapshot for accuracy tracking, but only if enough time has passed since
  // the last one — keeps the file small and the 24h pairs well-spaced.
  const snapFile = await readJson(snapshotPath, { snapshots: [] });
  snapFile.snapshots = Array.isArray(snapFile.snapshots) ? snapFile.snapshots : [];
  const last = snapFile.snapshots[snapFile.snapshots.length - 1];
  if (!last || now - last.t >= SNAPSHOT_INTERVAL_MS) {
    const snapshot = { t: now, tickers: {} };
    for (const p of predictions) {
      if (p.price == null) continue;
      snapshot.tickers[p.ticker] = {
        price: p.price,
        score: p.score,
        zBase: p.zBase,
      };
    }
    snapFile.snapshots.push(snapshot);
    if (snapFile.snapshots.length > HISTORY_CAP) {
      snapFile.snapshots = snapFile.snapshots.slice(-HISTORY_CAP);
    }
    await writeFile(snapshotPath, JSON.stringify(snapFile, null, 2) + "\n");
    log.info(`snapshot appended (${snapFile.snapshots.length} total)`);
  } else {
    const min = Math.round((now - last.t) / 60000);
    log.info(`snapshot skipped — last one was ${min}m ago (<50m)`);
  }
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
