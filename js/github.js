// GitHub API client for self-service "force refresh".
// Stores owner/repo/ref/token in cookies and exposes two operations:
//   * writeTickers({ tickers })  — commits config/tickers.json
//   * triggerWorkflow(fileName)  — POSTs workflow_dispatch
//
// Requires a fine-grained PAT scoped to this single repo with permissions
//   Contents: Read and write   (to update config/tickers.json)
//   Actions:  Read and write   (to dispatch workflows)

import { createLogger } from "./logger.js";
import { setCookie, getCookie, deleteCookie } from "./cookies.js";

const log = createLogger("github");

const C_OWNER = "ms_gh_owner";
const C_REPO = "ms_gh_repo";
const C_REF = "ms_gh_ref";
const C_TOKEN = "ms_gh_token";

export const WORKFLOWS = {
  stocks: "update-stocks.yml",
  news: "update-news.yml",
};

export function autoDetectRepo() {
  try {
    const host = location.hostname;
    if (!host.endsWith(".github.io")) return null;
    const owner = host.split(".")[0];
    const first = location.pathname.split("/").filter(Boolean)[0];
    // User sites (owner.github.io) have no repo segment — Pages serves from
    // the repo literally named `<owner>.github.io`.
    const repo = first || `${owner}.github.io`;
    return { owner, repo };
  } catch {
    return null;
  }
}

export function loadConfig() {
  const auto = autoDetectRepo();
  return {
    owner: getCookie(C_OWNER) || auto?.owner || "",
    repo: getCookie(C_REPO) || auto?.repo || "",
    ref: getCookie(C_REF) || "main",
    token: getCookie(C_TOKEN) || "",
  };
}

export function saveConfig({ owner, repo, ref, token }) {
  if (owner) setCookie(C_OWNER, owner); else deleteCookie(C_OWNER);
  if (repo) setCookie(C_REPO, repo); else deleteCookie(C_REPO);
  if (ref) setCookie(C_REF, ref); else deleteCookie(C_REF);
  if (token) setCookie(C_TOKEN, token); else deleteCookie(C_TOKEN);
}

export function clearConfig() {
  deleteCookie(C_OWNER);
  deleteCookie(C_REPO);
  deleteCookie(C_REF);
  deleteCookie(C_TOKEN);
}

export function hasCredentials() {
  const c = loadConfig();
  return Boolean(c.owner && c.repo && c.token);
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

function encodeBase64Utf8(str) {
  // btoa can't handle non-ASCII directly; round-trip through UTF-8.
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function decodeBase64Utf8(b64) {
  const binary = atob((b64 || "").replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function readBody(res) {
  try {
    return (await res.text()).slice(0, 240);
  } catch {
    return "";
  }
}

function friendlyError(status, body) {
  if (status === 401) return "Unauthorized — token rejected or expired.";
  if (status === 403) {
    if (/rate limit/i.test(body)) return "Rate limited by GitHub — wait a minute.";
    return "Forbidden — token is missing required permissions (Contents: RW, Actions: RW).";
  }
  if (status === 404) return "Not found — check owner / repo / branch.";
  if (status === 409) return "Conflict — the file was changed elsewhere, try again.";
  if (status === 422) return "Unprocessable — GitHub couldn't schedule the workflow. Check that the workflow file exists on the chosen branch.";
  return `GitHub ${status}${body ? ` — ${body}` : ""}`;
}

export async function getFile({ path }) {
  const { owner, repo, ref, token } = loadConfig();
  if (!owner || !repo || !token) throw new Error("GitHub config missing");
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(friendlyError(res.status, await readBody(res)));
  const data = await res.json();
  return { sha: data.sha, content: decodeBase64Utf8(data.content) };
}

export async function putFile({ path, content, message, sha }) {
  const { owner, repo, ref, token } = loadConfig();
  if (!owner || !repo || !token) throw new Error("GitHub config missing");
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    content: encodeBase64Utf8(content),
    branch: ref,
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: "PUT",
    headers: ghHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(friendlyError(res.status, await readBody(res)));
  return await res.json();
}

export async function triggerWorkflow(workflowFile) {
  const { owner, repo, ref, token } = loadConfig();
  if (!owner || !repo || !token) throw new Error("GitHub config missing");
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`;
  log.info(`dispatch ${workflowFile} on ${owner}/${repo}@${ref}`);
  const res = await fetch(url, {
    method: "POST",
    headers: ghHeaders(token),
    body: JSON.stringify({ ref }),
  });
  // dispatches returns 204 No Content on success.
  if (res.status === 204) return { ok: true };
  throw new Error(friendlyError(res.status, await readBody(res)));
}

// Compute the merged ticker list and commit it, only if it actually differs
// from what's already in the repo. Returns { changed, commit, merged }.
export async function writeTickers({ tickers, commitMessage }) {
  const current = await getFile({ path: "config/tickers.json" });
  const serialized = JSON.stringify({ tickers }, null, 2) + "\n";
  if (serialized.trim() === current.content.trim()) {
    log.info("writeTickers: no change");
    return { changed: false, merged: tickers };
  }
  const commit = await putFile({
    path: "config/tickers.json",
    content: serialized,
    message: commitMessage ?? "config: update tickers from web UI",
    sha: current.sha,
  });
  log.info(`writeTickers: committed ${commit.commit?.sha?.slice(0, 7)}`);
  return { changed: true, commit, merged: tickers };
}

export function actionsUrl() {
  const { owner, repo } = loadConfig();
  if (!owner || !repo) return null;
  return `https://github.com/${owner}/${repo}/actions`;
}
