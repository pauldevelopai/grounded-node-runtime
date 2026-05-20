/**
 * @developai/grounded-node-runtime / src/chrome.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Family branding + telemetry endpoint for every Node.
 *
 * Nodes opt in to the chrome by adding two lines to public/index.html:
 *
 *   <link rel="stylesheet" href="/grounded-chrome.css">
 *   <script src="/grounded-chrome.js" defer></script>
 *
 * The chrome injects a small "Part of GROUNDED" wordmark and a footer line
 * showing version + newsroom info — subtle, not dominant. The Node's own
 * branding stays primary; GROUNDED is the family signal.
 *
 * Telemetry endpoint /api/grounded/meta returns the metadata the chrome
 * reads at runtime AND that the cohort harvest reads from each fork's
 * committed JSON files to populate the dashboard.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CHROME_CSS = `
/* GROUNDED chrome — applied by every Node that opts in. Subtle by design. */
#grounded-chrome {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  pointer-events: none;
  z-index: 9999;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
#grounded-chrome .gc-footer {
  pointer-events: auto;
  background: rgba(28, 28, 26, 0.94);
  color: #b8b8b0;
  font-size: 11px;
  letter-spacing: 0.25px;
  padding: 5px 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  border-top: 1px solid rgba(255,255,255,0.06);
}
#grounded-chrome .gc-mark {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: #faf9f6;
  text-decoration: none;
  font-weight: 500;
  letter-spacing: 1.2px;
}
#grounded-chrome .gc-mark::before {
  content: "";
  width: 6px;
  height: 6px;
  background: #8bb89a;
  border-radius: 50%;
  display: inline-block;
}
#grounded-chrome .gc-mark:hover { color: #ffffff; }
#grounded-chrome .gc-meta {
  font-variant-numeric: tabular-nums;
  color: #888880;
}
#grounded-chrome .gc-meta .gc-sep { margin: 0 0.55rem; opacity: 0.5; }
@media (max-width: 540px) {
  #grounded-chrome .gc-footer { font-size: 10px; padding: 4px 10px; }
  #grounded-chrome .gc-meta .gc-newsroom { display: none; }
}
body { padding-bottom: 32px; }
`;

const CHROME_JS = `
/* GROUNDED chrome bootstrap — runs once on page load. Defensive: any
   failure quietly leaves the host page untouched. */
(function () {
  if (document.getElementById("grounded-chrome")) return;
  fetch("/api/grounded/meta")
    .then(function (r) { return r.json(); })
    .then(function (m) {
      var wrap = document.createElement("div");
      wrap.id = "grounded-chrome";
      var sep = '<span class="gc-sep">·</span>';
      wrap.innerHTML =
        '<div class="gc-footer">' +
          '<a class="gc-mark" href="https://github.com/pauldevelopai/groundedai" target="_blank" rel="noopener">' +
            'GROUNDED' +
          '</a>' +
          '<div class="gc-meta">' +
            '<span class="gc-node">' + esc(m.displayName || m.slug) + '</span>' +
            sep + 'v' + esc(m.nodeVersion || '?') +
            sep + 'runtime v' + esc(m.runtimeVersion || '?') +
            (m.newsroom ? sep + '<span class="gc-newsroom">' + esc(m.newsroom) + '</span>' : '') +
          '</div>' +
        '</div>';
      document.body.appendChild(wrap);
    })
    .catch(function () { /* silent — chrome is optional */ });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]);
    });
  }
})();
`;

/**
 * Mount the GROUNDED chrome routes on an express app.
 * Called automatically by createServer; Nodes don't need to invoke directly.
 *
 * @param {object} app — the express app
 * @param {object} opts
 * @param {string} opts.slug
 * @param {string} opts.displayName
 * @param {string} opts.nodeVersion        — read from the Node's package.json
 * @param {string} opts.runtimeVersion     — read from this package's package.json
 * @param {string} opts.hostId             — the sticky install identifier
 * @param {string=} opts.newsroom          — optional newsroom display name
 */
export function mountChrome(app, opts) {
  const meta = {
    slug: opts.slug,
    displayName: opts.displayName || opts.slug,
    nodeVersion: opts.nodeVersion || "unknown",
    runtimeVersion: opts.runtimeVersion || "unknown",
    hostId: opts.hostId || null,
    newsroom: opts.newsroom || null,
  };

  app.get("/grounded-chrome.css", (req, res) => {
    res.type("text/css").send(CHROME_CSS);
  });

  app.get("/grounded-chrome.js", (req, res) => {
    res.type("application/javascript").send(CHROME_JS);
  });

  app.get("/api/grounded/meta", (req, res) => {
    res.json(meta);
  });
}

/**
 * Read the runtime's own package.json version, so the chrome can advertise
 * which runtime version a Node is running on.
 */
export function readRuntimeVersion() {
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}
