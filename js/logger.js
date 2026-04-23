// Tiny namespaced console logger. Each module creates a logger once and uses it
// for entry/exit/error logs so the browser devtools show a clear trail.
//
// Log levels map directly to console methods. Timestamps are emitted as a
// prefix so you can correlate events across modules.

function ts() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function createLogger(namespace) {
  const tag = `[${namespace}]`;
  const style = "color:#58a6ff;font-weight:600";
  const err = (...a) => console.error(`%c${ts()} ${tag}`, style, ...a);
  const warn = (...a) => console.warn(`%c${ts()} ${tag}`, style, ...a);
  const info = (...a) => console.log(`%c${ts()} ${tag}`, style, ...a);
  const debug = (...a) => console.debug(`%c${ts()} ${tag}`, style, ...a);
  return { info, warn, error: err, debug };
}
