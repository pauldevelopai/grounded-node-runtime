/**
 * @developai/grounded-node-runtime / src/telemetry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fire-and-forget HTTP telemetry to the GROUNDED collector (a Cloudflare Worker
 * that relays into Airtable). This is how a Node reports its install heartbeat,
 * activity/error events, and user feedback WITHOUT pushing to git — so newsrooms
 * don't need a fork, a login, or GitHub Desktop.
 *
 * Enabled ONLY when GROUNDED_TELEMETRY_URL is set. When it's unset, every call is
 * a no-op and the caller falls back to its previous behaviour — so Nodes that
 * haven't been pointed at a collector behave exactly as before. Telemetry must
 * never block the app or throw: failures are swallowed, with a short timeout.
 *
 * Config (env): GROUNDED_TELEMETRY_URL, GROUNDED_TELEMETRY_TOKEN.
 */

const URL_ENV = "GROUNDED_TELEMETRY_URL";
const TOKEN_ENV = "GROUNDED_TELEMETRY_TOKEN";
const TIMEOUT_MS = 4000;

/** True when a collector URL is configured. */
export function telemetryEnabled() {
  return !!(process.env[URL_ENV] || "").trim();
}

/**
 * POST one telemetry message and resolve to whether it landed. Never throws.
 * @param {"install"|"event"|"feedback"} type
 * @param {object} data
 * @returns {Promise<boolean>}
 */
export async function sendTelemetry(type, data) {
  const url = (process.env[URL_ENV] || "").trim();
  if (!url) return false; // disabled — no-op
  const token = (process.env[TOKEN_ENV] || "").trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, type, data }),
      signal: controller.signal,
    });
    return r.ok;
  } catch {
    return false; // network/timeout — swallow; telemetry is best-effort
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget variant for hot paths (boot beacon, activity log). */
export function postTelemetry(type, data) {
  sendTelemetry(type, data).catch(() => { /* never affect the app */ });
}
