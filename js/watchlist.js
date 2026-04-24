// Cookie-backed personal watchlist.
//
// The repo's config/tickers.json is the *base* watchlist — it's what the
// GitHub Action fetches quotes for. This module lets the user:
//   * hide base tickers from the UI (cookie: hidden set)
//   * add extra tickers (cookie: extra set) — those only get data if they
//     also appear in the base config; otherwise they're marked "no data".
// Together: visible = (base \ hidden) ∪ extra
//
// It also hosts the "Force refresh tickers" flow, which uses the optional
// GitHub credentials in js/github.js to commit the merged watchlist back to
// config/tickers.json and re-dispatch both workflows.

import { createLogger } from "./logger.js";
import {
  setCookieJSON,
  getCookieJSON,
  deleteCookie,
} from "./cookies.js";
import {
  loadConfig as loadGhConfig,
  saveConfig as saveGhConfig,
  clearConfig as clearGhConfig,
  hasCredentials as hasGhCredentials,
  writeTickers as ghWriteTickers,
  triggerWorkflow as ghTriggerWorkflow,
  actionsUrl as ghActionsUrl,
  WORKFLOWS,
} from "./github.js";

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

// Build the ticker array that will be written to config/tickers.json.
// Keeps base-ticker names, drops hidden, appends extras with an empty name.
function buildMergedTickers(baseTickers) {
  const visible = getVisibleTickers(baseTickers);
  const baseByName = new Map((baseTickers ?? []).map((t) => [t.symbol, t.name ?? ""]));
  return visible.map((t) => ({
    symbol: t.symbol,
    name: baseByName.get(t.symbol) ?? t.name ?? "",
  }));
}

function render(editorEl, ctx) {
  const { baseTickers, stocks, message, messageKind, settingsOpen, refreshing } = ctx;
  const visible = getVisibleTickers(baseTickers);
  const haveData = new Set((stocks ?? []).map((s) => s.ticker));

  const chips = visible
    .map((t) => {
      const isExtra = t.source === "extra";
      const missingData = !haveData.has(t.symbol);
      const cls = ["chip", isExtra ? "chip-extra" : "", missingData ? "chip-nodata" : ""]
        .filter(Boolean)
        .join(" ");
      const title = missingData
        ? "No data yet — this ticker isn't in config/tickers.json, so the workflow hasn't fetched a quote for it."
        : "";
      return `
        <span class="${cls}" title="${esc(title)}">
          <span class="chip-ticker">${esc(t.symbol)}</span>
          <button type="button" class="chip-remove" data-symbol="${esc(t.symbol)}" aria-label="Remove ${esc(t.symbol)}">×</button>
        </span>
      `;
    })
    .join("");

  const msgHtml = message
    ? `<p class="watchlist-msg ${messageKind ?? ""}">${esc(message)}</p>`
    : "";

  const ghCfg = loadGhConfig();
  const credsReady = Boolean(ghCfg.owner && ghCfg.repo && ghCfg.token);
  const actionsLink = ghActionsUrl();

  const settingsBody = `
    <form class="gh-form" id="gh-form">
      <div class="gh-grid">
        <div class="field">
          <label for="gh-owner">Owner</label>
          <input id="gh-owner" type="text" autocomplete="off" value="${esc(ghCfg.owner)}" placeholder="octocat" />
        </div>
        <div class="field">
          <label for="gh-repo">Repo</label>
          <input id="gh-repo" type="text" autocomplete="off" value="${esc(ghCfg.repo)}" placeholder="market-scan" />
        </div>
        <div class="field">
          <label for="gh-ref">Branch</label>
          <input id="gh-ref" type="text" autocomplete="off" value="${esc(ghCfg.ref)}" placeholder="main" />
        </div>
        <div class="field field-wide">
          <label for="gh-token">Fine-grained PAT <small>Contents: RW · Actions: RW</small></label>
          <input id="gh-token" type="password" autocomplete="off" value="${esc(ghCfg.token)}" placeholder="github_pat_…" />
        </div>
      </div>
      <div class="gh-actions">
        <button type="submit" class="ghost">Save</button>
        <button type="button" id="gh-clear" class="ghost danger">Clear saved</button>
      </div>
      <p class="watchlist-note">
        Stored in cookies on this device. Any JS running on this origin can
        read them — use a fine-grained PAT scoped to just this repo with a
        short expiry. Create one at
        <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens</a>.
      </p>
    </form>
  `;

  editorEl.innerHTML = `
    <div class="watchlist-chips">${chips || '<span class="empty">Watchlist is empty.</span>'}</div>
    <form class="watchlist-add" id="watchlist-add">
      <input type="text" id="wl-input" placeholder="Add ticker (e.g. AAPL)" maxlength="10" autocomplete="off" spellcheck="false" />
      <button type="submit" class="ghost">Add</button>
      <button type="button" id="wl-reset" class="ghost danger" ${isModified() ? "" : "disabled"}>Reset</button>
    </form>

    <div class="force-refresh">
      <button type="button" id="wl-force-refresh" class="primary" ${refreshing ? "disabled" : ""}>
        ${refreshing ? "Running…" : "Force refresh tickers"}
      </button>
      <button type="button" id="wl-gh-toggle" class="ghost" aria-expanded="${settingsOpen ? "true" : "false"}">
        ${settingsOpen ? "Hide repo settings" : credsReady ? "Repo settings" : "Configure repo"}
      </button>
      ${actionsLink ? `<a class="actions-link" href="${esc(actionsLink)}" target="_blank" rel="noopener">Open Actions tab ↗</a>` : ""}
    </div>

    ${settingsOpen ? settingsBody : ""}
    ${msgHtml}

    <p class="watchlist-note">
      Hiding a ticker applies instantly (stored in a cookie). Adding a ticker
      not in <code>config/tickers.json</code> marks it "no data" — click
      <em>Force refresh tickers</em> to commit the merged watchlist to the
      repo and re-dispatch both workflows.
    </p>
  `;

  editorEl.querySelectorAll(".chip-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      removeTicker(btn.dataset.symbol, baseTickers);
      ctx.emit({ reason: "removed" });
    });
  });

  const addForm = editorEl.querySelector("#watchlist-add");
  const addInput = editorEl.querySelector("#wl-input");
  addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const { ok, reason } = addTicker(addInput.value, baseTickers);
    if (!ok) {
      const map = {
        empty: "Enter a ticker.",
        invalid: "Invalid ticker — use 1–10 letters/digits.",
        duplicate: "Already in your watchlist.",
      };
      ctx.emit({ reason: "add-failed", message: map[reason] ?? reason, kind: "err" });
      return;
    }
    addInput.value = "";
    const map = {
      base: "Added.",
      extra: "Added — no data until committed to config/tickers.json.",
      unhidden: "Re-enabled.",
    };
    ctx.emit({ reason: "added", message: map[reason], kind: "ok" });
  });

  editorEl.querySelector("#wl-reset").addEventListener("click", () => {
    if (!confirm("Reset watchlist to the repo defaults?")) return;
    reset();
    ctx.emit({ reason: "reset", message: "Reset to defaults.", kind: "ok" });
  });

  editorEl.querySelector("#wl-gh-toggle").addEventListener("click", () => {
    ctx.emit({ reason: "toggle-settings" });
  });

  editorEl.querySelector("#wl-force-refresh").addEventListener("click", () => {
    ctx.emit({ reason: "force-refresh" });
  });

  if (settingsOpen) {
    const ghForm = editorEl.querySelector("#gh-form");
    ghForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const owner = ghForm.querySelector("#gh-owner").value.trim();
      const repo = ghForm.querySelector("#gh-repo").value.trim();
      const ref = ghForm.querySelector("#gh-ref").value.trim() || "main";
      const token = ghForm.querySelector("#gh-token").value.trim();
      saveGhConfig({ owner, repo, ref, token });
      ctx.emit({ reason: "gh-saved", message: "GitHub config saved.", kind: "ok" });
    });
    editorEl.querySelector("#gh-clear").addEventListener("click", () => {
      if (!confirm("Clear saved GitHub owner/repo/branch/token?")) return;
      clearGhConfig();
      ctx.emit({ reason: "gh-cleared", message: "GitHub config cleared.", kind: "ok" });
    });
  }
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
  let settingsOpen = false;
  let refreshing = false;
  let message = "";
  let messageKind = "";

  function setStatus(msg, kind = "") {
    message = msg ?? "";
    messageKind = kind;
  }

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
      settingsOpen,
      refreshing,
      emit: handleEvent,
    });
  }

  async function doForceRefresh() {
    const ctx = getContext();
    const baseTickers = ctx.baseTickers ?? [];

    if (!hasGhCredentials()) {
      settingsOpen = true;
      setStatus("Add owner, repo, and a fine-grained PAT first.", "err");
      paint();
      return;
    }

    refreshing = true;
    setStatus("Committing watchlist…", "");
    paint();

    try {
      const merged = buildMergedTickers(baseTickers);
      const { changed } = await ghWriteTickers({
        tickers: merged,
        commitMessage: "config: update tickers from web UI",
      });
      setStatus(
        changed
          ? `Committed ${merged.length} tickers. Dispatching workflows…`
          : `Watchlist matches repo. Dispatching workflows…`,
        "",
      );
      paint();

      await ghTriggerWorkflow(WORKFLOWS.stocks);
      await ghTriggerWorkflow(WORKFLOWS.news);

      // If we committed a change, reset the local overrides so the UI starts
      // showing the repo as source-of-truth again.
      if (changed) reset();

      setStatus(
        `Done — workflows queued. They take a minute or two; then hit Refresh.`,
        "ok",
      );
      log.info("force-refresh: complete");
      if (onChange) onChange();
    } catch (err) {
      log.error("force-refresh failed:", err.message);
      setStatus(err.message, "err");
    } finally {
      refreshing = false;
      paint();
    }
  }

  function handleEvent(ev) {
    switch (ev.reason) {
      case "removed":
      case "added":
      case "reset":
        if (ev.message) setStatus(ev.message, ev.kind ?? "");
        else setStatus("");
        paint();
        if (onChange) onChange();
        break;
      case "add-failed":
        setStatus(ev.message, ev.kind ?? "err");
        paint();
        break;
      case "toggle-settings":
        settingsOpen = !settingsOpen;
        setStatus("");
        paint();
        break;
      case "gh-saved":
      case "gh-cleared":
        setStatus(ev.message, ev.kind ?? "ok");
        paint();
        break;
      case "force-refresh":
        doForceRefresh();
        break;
      default:
        paint();
    }
  }

  toggleBtn.addEventListener("click", () => {
    open = !open;
    setStatus("");
    paint();
  });

  paint();
  return {
    rerender: () => {
      if (open) paint();
    },
  };
}
