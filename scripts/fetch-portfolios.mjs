#!/usr/bin/env node
// Fetches one or more public portfolios for the side widget.
//
// Source types supported:
//   sec13f         — Latest 13F-HR filing for a given CIK from EDGAR.
//                    Free, no key. SEC requires a contact User-Agent.
//   congress-house — All disclosed trades from house-stock-watcher's S3 dump,
//                    filtered to a single member and a recent window. Not a
//                    true portfolio — represents weighted recent activity.
//
// Configured via config/portfolios.json. Writes data/portfolios.json with a
// uniform shape per entry so the frontend doesn't care about the source.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function ts() {
  return new Date().toISOString();
}
const log = {
  info: (...a) => console.log(`${ts()} [fetch-portfolios]`, ...a),
  warn: (...a) => console.warn(`${ts()} [fetch-portfolios] WARN`, ...a),
  error: (...a) => console.error(`${ts()} [fetch-portfolios] ERROR`, ...a),
};

// SEC requires a meaningful User-Agent. Customize via env if you fork.
const SEC_UA =
  process.env.SEC_USER_AGENT ||
  "market-scan github-action (https://github.com/) contact@example.com";

async function readJson(path, fallback) {
  try {
    const raw = await readFile(path, "utf8");
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function fetchJson(url, headers = {}) {
  const t0 = Date.now();
  const res = await fetch(url, { headers });
  const dt = Date.now() - t0;
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText} (${dt}ms)`);
  return await res.json();
}

async function fetchText(url, headers = {}) {
  const t0 = Date.now();
  const res = await fetch(url, { headers });
  const dt = Date.now() - t0;
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText} (${dt}ms)`);
  return await res.text();
}

// --- SEC 13F --------------------------------------------------------------

async function getLatest13F(cik) {
  const padded = String(cik).padStart(10, "0");
  const subUrl = `https://data.sec.gov/submissions/CIK${padded}.json`;
  const sub = await fetchJson(subUrl, { "User-Agent": SEC_UA });
  const recent = sub?.filings?.recent;
  if (!recent || !Array.isArray(recent.form)) {
    throw new Error(`no recent filings for CIK ${cik}`);
  }
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] === "13F-HR") {
      return {
        accession: recent.accessionNumber[i],
        filingDate: recent.filingDate[i],
        primaryDocument: recent.primaryDocument[i],
        reportDate: recent.reportDate[i],
        filerName: sub.name,
      };
    }
  }
  throw new Error(`no 13F-HR found for CIK ${cik}`);
}

async function get13FInfoTableXml(cik, accession) {
  const accNoDashes = accession.replace(/-/g, "");
  const cikInt = parseInt(String(cik), 10);
  const dirUrl = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDashes}/`;
  const idx = await fetchJson(`${dirUrl}index.json`, { "User-Agent": SEC_UA });
  const items = idx?.directory?.item ?? [];
  // The information-table XML has variable filenames across filers — find the
  // .xml whose name suggests it's the info table (not the cover/primary doc).
  const candidate =
    items.find((f) => /information.?table/i.test(f.name) && f.name.endsWith(".xml")) ??
    items.find((f) => /infotable/i.test(f.name) && f.name.endsWith(".xml")) ??
    items.find((f) => f.name.endsWith(".xml") && !/primary_doc/i.test(f.name));
  if (!candidate) throw new Error(`no info-table XML found in ${dirUrl}`);
  return await fetchText(`${dirUrl}${candidate.name}`, { "User-Agent": SEC_UA });
}

function parseInfoTable(xml) {
  // Lightweight XML walk — 13F infotables are flat and predictable enough
  // that we don't need a full parser.
  const positions = [];
  const blocks = xml.match(/<infoTable[^>]*>[\s\S]*?<\/infoTable>/g) ?? [];
  for (const block of blocks) {
    const get = (tag) => {
      const m = block.match(new RegExp(`<(?:[a-zA-Z]+:)?${tag}[^>]*>([^<]*)<`, "i"));
      return m ? m[1].trim() : null;
    };
    const name = get("nameOfIssuer");
    if (!name) continue;
    const value = parseFloat(get("value")) || 0;
    const shares = parseFloat(get("sshPrnamt")) || 0;
    positions.push({
      name,
      cusip: get("cusip"),
      titleOfClass: get("titleOfClass"),
      // SEC clarified value reporting in 2022 — most filers now report raw
      // dollars. Pre-2023 filings often still report thousands. We don't
      // need absolute dollars — only relative weights — so this is fine.
      value,
      shares,
    });
  }
  return positions;
}

function aggregate13FPositions(positions) {
  // Same issuer can appear multiple times (different share classes etc.).
  const byName = new Map();
  for (const p of positions) {
    const prev = byName.get(p.name);
    if (prev) {
      prev.value += p.value;
      prev.shares += p.shares;
    } else {
      byName.set(p.name, { ...p });
    }
  }
  return [...byName.values()];
}

async function fetchSec13F({ cik, name, subtitle, topN = 10 }) {
  log.info(`sec13f: CIK=${cik} (${name})`);
  const filing = await getLatest13F(cik);
  log.info(
    `sec13f: latest 13F-HR accession=${filing.accession} reportDate=${filing.reportDate} filingDate=${filing.filingDate}`,
  );
  const xml = await get13FInfoTableXml(cik, filing.accession);
  const raw = parseInfoTable(xml);
  const merged = aggregate13FPositions(raw).sort((a, b) => b.value - a.value);
  const total = merged.reduce((a, p) => a + p.value, 0);
  const top = merged.slice(0, topN);
  const others = merged.slice(topN);
  const otherSum = others.reduce((a, p) => a + p.value, 0);

  const positions = top.map((p) => ({
    label: p.name,
    weight: total > 0 ? p.value / total : 0,
    value: p.value,
  }));
  if (otherSum > 0 && total > 0) {
    positions.push({
      label: `Others (${others.length})`,
      weight: otherSum / total,
      value: otherSum,
      isOther: true,
    });
  }

  return {
    name,
    subtitle: subtitle ?? `${filing.filerName ?? "Filer"} · 13F-HR`,
    sourceLabel: `13F · period ${filing.reportDate}`,
    sourceUrl: `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${filing.accession.replace(/-/g, "")}/`,
    asOf: filing.reportDate,
    filedOn: filing.filingDate,
    totalValue: total,
    positionCount: merged.length,
    positions,
  };
}

// --- Congress trades ------------------------------------------------------

const HOUSE_DUMP_URL =
  "https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json";

// Each disclosure reports a value range like "$1,001 - $15,000". We midpoint
// it. Map of canonical labels → midpoint dollars. Anything not in the map
// (rare unusual labels) defaults to 1.
const RANGE_MID = {
  "$1,001 - $15,000": 8000,
  "$15,001 - $50,000": 32500,
  "$50,001 - $100,000": 75000,
  "$100,001 - $250,000": 175000,
  "$250,001 - $500,000": 375000,
  "$500,001 - $1,000,000": 750000,
  "$1,000,001 - $5,000,000": 3000000,
  "$5,000,001 - $25,000,000": 15000000,
  "$25,000,001 - $50,000,000": 37500000,
  "$50,000,000 +": 75000000,
};

function rangeMid(label) {
  if (!label) return 1;
  const norm = label.trim();
  if (RANGE_MID[norm]) return RANGE_MID[norm];
  // Try to be lenient with whitespace / minor punctuation differences.
  for (const [k, v] of Object.entries(RANGE_MID)) {
    if (k.replace(/\s+/g, "") === norm.replace(/\s+/g, "")) return v;
  }
  return 1;
}

function isBuyType(t) {
  if (!t) return false;
  const s = String(t).toLowerCase();
  return s.includes("purchase") || s === "buy";
}
function isSellType(t) {
  if (!t) return false;
  const s = String(t).toLowerCase();
  return s.includes("sale") || s === "sell";
}

async function fetchCongressHouse({
  memberMatch,
  name,
  subtitle,
  windowDays = 180,
  topN = 10,
}) {
  log.info(`congress-house: member~="${memberMatch}" window=${windowDays}d`);
  const all = await fetchJson(HOUSE_DUMP_URL);
  if (!Array.isArray(all)) throw new Error("unexpected dump shape");
  log.info(`congress-house: dump has ${all.length} total transactions`);

  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const matchRe = new RegExp(memberMatch, "i");
  const trades = all.filter((tr) => {
    if (!matchRe.test(tr.representative ?? "")) return false;
    const td = Date.parse(tr.transaction_date ?? "");
    if (!Number.isFinite(td)) return false;
    return td >= cutoff;
  });
  log.info(`congress-house: ${trades.length} matching trades after window filter`);

  // Aggregate per ticker: net = sum(buy mid) - sum(sell mid). Weight by |net|.
  const byTicker = new Map();
  for (const tr of trades) {
    const sym = (tr.ticker || "").toUpperCase();
    if (!sym || sym === "--" || sym === "N/A") continue;
    const mid = rangeMid(tr.amount);
    const signed = isBuyType(tr.type) ? mid : isSellType(tr.type) ? -mid : 0;
    if (signed === 0) continue;
    const prev = byTicker.get(sym) ?? { ticker: sym, label: sym, net: 0, gross: 0, count: 0 };
    prev.net += signed;
    prev.gross += Math.abs(signed);
    prev.count += 1;
    byTicker.set(sym, prev);
  }

  // Show net long-only positioning: filter to net > 0, weight by |net|.
  const longs = [...byTicker.values()]
    .filter((p) => p.net > 0)
    .sort((a, b) => b.net - a.net);
  const total = longs.reduce((a, p) => a + p.net, 0);
  const top = longs.slice(0, topN);
  const others = longs.slice(topN);
  const otherSum = others.reduce((a, p) => a + p.net, 0);

  const positions = top.map((p) => ({
    label: p.ticker,
    weight: total > 0 ? p.net / total : 0,
    value: p.net,
    trades: p.count,
  }));
  if (otherSum > 0 && total > 0) {
    positions.push({
      label: `Others (${others.length})`,
      weight: otherSum / total,
      value: otherSum,
      isOther: true,
    });
  }

  return {
    name,
    subtitle: subtitle ?? `Disclosed trades · last ${windowDays}d`,
    sourceLabel: `house-stock-watcher · ${trades.length} trades`,
    sourceUrl: "https://housestockwatcher.com/",
    asOf: new Date().toISOString().slice(0, 10),
    totalValue: total,
    positionCount: longs.length,
    positions,
    note:
      "Aggregated from disclosed trade reports — weighted by midpoint of " +
      "each disclosure range, net buy minus sell over the window. Not the " +
      "member's full holdings.",
  };
}

// --- Orchestration --------------------------------------------------------

async function fetchOne(cfg) {
  switch (cfg.type) {
    case "sec13f":
      return await fetchSec13F(cfg);
    case "congress-house":
      return await fetchCongressHouse(cfg);
    default:
      throw new Error(`unknown portfolio type: ${cfg.type}`);
  }
}

async function main() {
  const cfgPath = resolve(ROOT, "config/portfolios.json");
  const outPath = resolve(ROOT, "data/portfolios.json");
  const cfgFile = await readJson(cfgPath, { portfolios: [] });
  const entries = cfgFile.portfolios ?? [];
  log.info(`config: ${entries.length} portfolios`);

  const out = [];
  for (const cfg of entries) {
    try {
      const result = await fetchOne(cfg);
      out.push({ id: cfg.id, type: cfg.type, ok: true, ...result });
      log.info(`  ${cfg.id}: ${result.positions.length} positions`);
    } catch (err) {
      log.warn(`  ${cfg.id}: ${err.message}`);
      out.push({
        id: cfg.id,
        type: cfg.type,
        ok: false,
        name: cfg.name,
        subtitle: cfg.subtitle,
        error: err.message,
      });
    }
  }

  await writeFile(
    outPath,
    JSON.stringify({ timestamp: Date.now(), portfolios: out }, null, 2) + "\n",
  );
  log.info(`wrote portfolios.json (${out.length} entries)`);
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
