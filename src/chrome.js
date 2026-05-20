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
/* GROUNDED chrome — applied by every Node that opts in.
   Family branding visible at top and bottom. Single CSS var block at
   the top of this rule set so swapping colours is one-line work. */

#grounded-chrome {
  --gc-rust: #a8543a;
  --gc-rust-deep: #7d3d2a;
  --gc-rust-light: #d18866;
  --gc-cream: #fdf4ea;
  --gc-ink: #1a1715;
  --gc-paper-dim: #c4b8a8;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* Top bar — full-width terracotta banner. Sets parent-platform context
   the moment the page loads. */
#grounded-chrome .gc-topbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 34px;
  z-index: 99998;
  background: var(--gc-rust);
  background: linear-gradient(180deg, var(--gc-rust) 0%, var(--gc-rust-deep) 100%);
  color: var(--gc-cream);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 18px;
  font-size: 12px;
  letter-spacing: 0.5px;
  box-shadow: 0 1px 0 rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08);
}
#grounded-chrome .gc-topbar .gc-mark {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  color: var(--gc-cream);
  text-decoration: none;
  font-weight: 600;
  letter-spacing: 1.6px;
  font-size: 12px;
}
#grounded-chrome .gc-topbar .gc-mark::before {
  content: "";
  width: 9px;
  height: 9px;
  background: var(--gc-rust-light);
  border-radius: 50%;
  box-shadow: 0 0 0 2px rgba(255,255,255,0.18);
  display: inline-block;
}
#grounded-chrome .gc-topbar .gc-mark:hover { color: #ffffff; }
#grounded-chrome .gc-topbar .gc-context {
  font-size: 11px;
  color: rgba(253, 244, 234, 0.78);
  letter-spacing: 0.3px;
}
#grounded-chrome .gc-topbar .gc-context .gc-newsroom {
  font-weight: 600;
  color: var(--gc-cream);
  letter-spacing: 0.4px;
}
#grounded-chrome .gc-topbar .gc-context .gc-sep {
  margin: 0 0.55rem;
  opacity: 0.5;
}

/* Footer — keeps the dark coffee background but with a rust accent
   for the dot, so top and bottom feel related. */
#grounded-chrome .gc-footer {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 99998;
  background: rgba(26, 23, 21, 0.96);
  color: var(--gc-paper-dim);
  font-size: 11px;
  letter-spacing: 0.25px;
  padding: 6px 18px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  border-top: 2px solid var(--gc-rust);
}
#grounded-chrome .gc-footer .gc-foot-left {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--gc-cream);
}
#grounded-chrome .gc-footer .gc-foot-left::before {
  content: "";
  width: 6px;
  height: 6px;
  background: var(--gc-rust-light);
  border-radius: 50%;
  display: inline-block;
}
#grounded-chrome .gc-footer .gc-meta {
  font-variant-numeric: tabular-nums;
}
#grounded-chrome .gc-footer .gc-meta .gc-sep { margin: 0 0.55rem; opacity: 0.45; }

@media (max-width: 640px) {
  #grounded-chrome .gc-topbar { height: 30px; padding: 0 12px; }
  #grounded-chrome .gc-topbar .gc-mark { font-size: 11px; letter-spacing: 1.2px; }
  #grounded-chrome .gc-topbar .gc-context .gc-tagline { display: none; }
  #grounded-chrome .gc-footer { font-size: 10px; padding: 4px 12px; }
  #grounded-chrome .gc-footer .gc-meta .gc-newsroom { display: none; }
}
`;

const CHROME_JS = `
/* GROUNDED chrome bootstrap — runs once on page load. Defensive: any
   failure quietly leaves the host page untouched. Body padding applied
   via inline style (highest CSS specificity) so it can't be overridden
   by a Node's own body styles. */
(function () {
  if (document.getElementById("grounded-chrome")) return;
  fetch("/api/grounded/meta")
    .then(function (r) { return r.json(); })
    .then(function (m) {
      var wrap = document.createElement("div");
      wrap.id = "grounded-chrome";
      var sep = '<span class="gc-sep">·</span>';
      var node = esc(m.displayName || m.slug);
      var newsroom = m.newsroom ? esc(m.newsroom) : '';
      var contextRight =
        '<div class="gc-context">' +
          (newsroom ? '<span class="gc-newsroom">' + newsroom + '</span>' + sep : '') +
          '<span class="gc-tagline">newsroom-owned AI</span>' +
        '</div>';
      wrap.innerHTML =
        '<div class="gc-topbar">' +
          '<a class="gc-mark" href="https://github.com/pauldevelopai/groundedai" target="_blank" rel="noopener">' +
            'GROUNDED' +
          '</a>' +
          contextRight +
        '</div>' +
        '<div class="gc-footer">' +
          '<span class="gc-foot-left">' + node + '</span>' +
          '<div class="gc-meta">' +
            'v' + esc(m.nodeVersion || '?') +
            sep + 'runtime v' + esc(m.runtimeVersion || '?') +
            (m.newsroom ? sep + '<span class="gc-newsroom">' + newsroom + '</span>' : '') +
          '</div>' +
        '</div>';
      document.body.appendChild(wrap);

      // Inline-style padding so Node CSS can't accidentally override it.
      var topPad = window.matchMedia('(max-width: 640px)').matches ? 30 : 34;
      var botPad = window.matchMedia('(max-width: 640px)').matches ? 22 : 28;
      document.body.style.paddingTop = (parseFloat(getComputedStyle(document.body).paddingTop) || 0) + topPad + 'px';
      document.body.style.paddingBottom = (parseFloat(getComputedStyle(document.body).paddingBottom) || 0) + botPad + 'px';
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
