// Cookie-backed personal watchlist.
//
// The repo's config/tickers.json is the *base* watchlist — it's what the
// GitHub Action fetches quotes for. This module lets the user:
//   * hide base tickers from the UI (cookie: hidden set)
//   * add extra tickers (cookie: extra set) — those only get data if they
//     also appear in the base config; otherwise they're marked "no data".
// Together: visible = (base \ hidden) ∪ extra

import { createLogger } from "./logger.js";
import {
  setCookieJSON,
  getCookieJSON,
  deleteCookie,
} from "./cookies.js";

const log = createLogger("watchlist");

const COOKIE_HIDDEN = "ms_watch_hidden";
const COOKIE_EXTRA = "ms_watch_extra";

const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;

function loadHidden() {
  const v = getCookieJSON(COOKIE_HIDDEN, []);
  return Array.isArray(v) ? v : [];
}
function loadExtra() {
  const v = getCookieJSON(COOKIE_EXTRA, []);
  return Array.isArray(v) ? v : [];
}

export function getVisibleTickers(baseTickers) {
  const base = baseTickers ?? [];
  const hidden = new Set(loadHidden());
  const extra = loadExtra();
  const seen = new Set();
  const out = [];
  for (const t of base) {
    if (hidden.has(t.symbol)) continue;
    if (seen.has(t.symbol)) continue;
    seen.add(t.symbol);
    out.push({ ...t, source: "base" });
  }
  for (const sym of extra) {
    if (seen.has(sym)) continue;
    seen.add(sym);
    out.push({ symbol: sym, name: "", source: "extra" });
  }
  return out;
}

export function isModified() {
  return loadHidden().length > 0 || loadExtra().length > 0;
}

export function removeTicker(symbol, baseTickers) {
  const sym = String(symbol ?? "").toUpperCase();
  if (!sym) return;
  const baseSet = new Set((baseTickers ?? []).map((t) => t.symbol));
  if (baseSet.has(sym)) {
    const hidden = new Set(loadHidden());
    hidden.add(sym);
    setCookieJSON(COOKIE_HIDDEN, [...hidden]);
  } else {
    const extra = loadExtra().filter((s) => s !== sym);
    setCookieJSON(COOKIE_EXTRA, extra);
  }
  log.info(`remove ${sym}`);
}

// Returns { ok, reason } so the UI can show a specific error.
export function addTicker(raw, baseTickers) {
  const sym = String(raw ?? "").trim().toUpperCase();
  if (!sym) return { ok: false, reason: "empty" };
  if (!TICKER_RE.test(sym)) return { ok: false, reason: "invalid" };

  const baseSet = new Set((baseTickers ?? []).map((t) => t.symbol));
  const hidden = new Set(loadHidden());
  if (baseSet.has(sym) && hidden.has(sym)) {
    hidden.delete(sym);
    setCookieJSON(COOKIE_HIDDEN, [...hidden]);
    log.info(`unhide ${sym}`);
    return { ok: true, reason: "unhidden" };
  }

  const visible = getVisibleTickers(baseTickers);
  if (visible.some((t) => t.symbol === sym)) {
    return { ok: false, reason: "duplicate" };
  }

  const extra = new Set(loadExtra());
  extra.add(sym);
  setCookieJSON(COOKIE_EXTRA, [...extra]);
  log.info(`add ${sym}`);
  return { ok: true, reason: baseSet.has(sym) ? "base" : "extra" };
}

export function reset() {
  deleteCookie(COOKIE_HIDDEN);
  deleteCookie(COOKIE_EXTRA);
  log.info("reset to base watchlist");
}

// --- Inline editor rendering --------------------------------------------------

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render(editorEl, { baseTickers, stocks, message, messageKind, onChange }) {
  const visible = getVisibleTickers(baseTickers);
  const haveData = new Set((stocks ?? []).map((s) => s.ticker));

  const chips = visible
    .map((t) => {
      const isExtra = t.source === "extra";
      const missingData = !haveData.has(t.symbol);
      const cls = [
        "chip",
        isExtra ? "chip-extra" : "",
        missingData ? "chip-nodata" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const title = missingData
        ? "No data yet — this ticker isn't in config/tickers.json, so the workflow hasn't fetched a quote for it."
        : "";
      return `
        <span class="${cls}" title="${esc(title)}">
          <span class="chip-ticker">${esc(t.symbol)}</span>
          <button
            type="button"
            class="chip-remove"
            data-symbol="${esc(t.symbol)}"
            aria-label="Remove ${esc(t.symbol)}"
          >×</button>
        </span>
      `;
    })
    .join("");

  const msgHtml = message
    ? `<p class="watchlist-msg ${messageKind ?? ""}">${esc(message)}</p>`
    : "";

  editorEl.innerHTML = `
    <div class="watchlist-chips">${chips || '<span class="empty">Watchlist is empty.</span>'}</div>
    <form class="watchlist-add" id="watchlist-add">
      <input
        type="text"
        id="wl-input"
        placeholder="Add ticker (e.g. AAPL)"
        maxlength="10"
        autocomplete="off"
        spellcheck="false"
      />
      <button type="submit" class="ghost">Add</button>
      <button type="button" id="wl-reset" class="ghost danger" ${isModified() ? "" : "disabled"}>
        Reset
      </button>
    </form>
    ${msgHtml}
    <p class="watchlist-note">
      Watchlist is stored in a cookie. Hiding a ticker applies instantly.
      Adding a ticker not in
      <code>config/tickers.json</code> marks it "no data" until you commit it
      to the repo so the workflow starts fetching it.
    </p>
  `;

  editorEl.querySelectorAll(".chip-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      removeTicker(btn.dataset.symbol, baseTickers);
      if (onChange) onChange({ reason: "removed", symbol: btn.dataset.symbol });
    });
  });

  const form = editorEl.querySelector("#watchlist-add");
  const input = editorEl.querySelector("#wl-input");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const val = input.value;
    const { ok, reason } = addTicker(val, baseTickers);
    if (!ok) {
      const map = {
        empty: "Enter a ticker.",
        invalid: "Invalid ticker — use 1–10 letters/digits.",
        duplicate: "Already in your watchlist.",
      };
      if (onChange) onChange({ reason: "add-failed", message: map[reason] ?? reason, kind: "err" });
      return;
    }
    input.value = "";
    const map = {
      base: "Added.",
      extra: "Added — no data until committed to config/tickers.json.",
      unhidden: "Re-enabled.",
    };
    if (onChange) onChange({ reason: "added", message: map[reason], kind: "ok" });
  });

  editorEl.querySelector("#wl-reset").addEventListener("click", () => {
    if (!confirm("Reset watchlist to the repo defaults?")) return;
    reset();
    if (onChange) onChange({ reason: "reset", message: "Reset to defaults.", kind: "ok" });
  });
}

export function initWatchlistEditor({
  editorEl,
  toggleBtn,
  getContext,
  onChange,
}) {
  if (!editorEl || !toggleBtn) {
    log.warn("initWatchlistEditor: missing elements");
    return { rerender: () => {} };
  }

  let open = false;
  let message = "";
  let messageKind = "";

  function paint() {
    editorEl.hidden = !open;
    toggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
    toggleBtn.classList.toggle("is-open", open);
    if (!open) return;
    const ctx = getContext();
    render(editorEl, {
      baseTickers: ctx.baseTickers,
      stocks: ctx.stocks,
      message,
      messageKind,
      onChange: (ev) => {
        if (ev.message) {
          message = ev.message;
          messageKind = ev.kind ?? "";
        } else {
          message = "";
          messageKind = "";
        }
        paint();
        if (ev.reason !== "add-failed" && onChange) onChange();
      },
    });
  }

  toggleBtn.addEventListener("click", () => {
    open = !open;
    message = "";
    messageKind = "";
    paint();
  });

  paint();
  return {
    rerender: () => {
      if (open) paint();
    },
  };
}
