// Thin cookie helper. Stores small, plain-string values with SameSite=Lax
// and a long expiry. Values are URI-encoded so commas/semicolons survive.

import { createLogger } from "./logger.js";
const log = createLogger("cookies");

export function setCookie(name, value, { days = 365 } = {}) {
  const d = new Date();
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  const expires = d.toUTCString();
  const v = encodeURIComponent(value ?? "");
  document.cookie = `${encodeURIComponent(name)}=${v}; expires=${expires}; path=/; SameSite=Lax`;
  log.debug(`set ${name} (${v.length} bytes)`);
}

export function getCookie(name) {
  const key = encodeURIComponent(name) + "=";
  const cookies = document.cookie ? document.cookie.split("; ") : [];
  for (const c of cookies) {
    if (c.startsWith(key)) {
      try {
        return decodeURIComponent(c.slice(key.length));
      } catch {
        return c.slice(key.length);
      }
    }
  }
  return null;
}

export function deleteCookie(name) {
  document.cookie = `${encodeURIComponent(name)}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`;
  log.debug(`delete ${name}`);
}

// JSON helpers — shallowly validate shape at the call site.
export function setCookieJSON(name, value, opts) {
  setCookie(name, JSON.stringify(value), opts);
}

export function getCookieJSON(name, fallback = null) {
  const raw = getCookie(name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    log.warn(`getCookieJSON(${name}) parse failed: ${err.message}`);
    return fallback;
  }
}
