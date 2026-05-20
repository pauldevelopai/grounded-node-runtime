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

/* Feedback floating button — sits above the footer, right side. */
#grounded-chrome .gc-feedback-btn {
  position: fixed;
  right: 18px;
  bottom: 44px;
  z-index: 99997;
  background: var(--gc-rust);
  color: var(--gc-cream);
  border: none;
  border-radius: 999px;
  padding: 10px 18px 10px 14px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.3px;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(122, 53, 32, 0.32);
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
}
#grounded-chrome .gc-feedback-btn:hover {
  background: var(--gc-rust-deep);
  transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(122, 53, 32, 0.42);
}
#grounded-chrome .gc-feedback-btn::before {
  content: "";
  width: 8px;
  height: 8px;
  background: var(--gc-rust-light);
  border-radius: 50%;
  display: inline-block;
  box-shadow: 0 0 0 2px rgba(255,255,255,0.22);
}

/* Modal */
#grounded-chrome .gc-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(20, 16, 14, 0.55);
  z-index: 99999;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
#grounded-chrome .gc-modal-backdrop.gc-open { display: flex; }
#grounded-chrome .gc-modal {
  background: var(--gc-cream);
  color: var(--gc-ink);
  border-radius: 10px;
  max-width: 520px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  padding: 1.5rem 1.75rem 1.25rem;
  box-shadow: 0 18px 50px rgba(0,0,0,0.35);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
#grounded-chrome .gc-modal h2 {
  margin: 0 0 0.35rem;
  font-size: 1.1rem;
  font-weight: 600;
  letter-spacing: 0.2px;
}
#grounded-chrome .gc-modal .gc-modal-sub {
  color: #6b5d52;
  font-size: 0.85rem;
  margin-bottom: 1rem;
  line-height: 1.5;
}
#grounded-chrome .gc-modal .gc-privacy {
  font-size: 0.78rem;
  background: #f3e6d6;
  border-left: 3px solid var(--gc-rust);
  padding: 0.55rem 0.75rem;
  margin: 0 0 1rem;
  color: #5a3a2a;
  line-height: 1.5;
  border-radius: 0 4px 4px 0;
}
#grounded-chrome .gc-modal label {
  display: block;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: #6b5d52;
  font-weight: 500;
  margin: 0.85rem 0 0.4rem;
}
#grounded-chrome .gc-modal .gc-types {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}
#grounded-chrome .gc-modal .gc-types button {
  background: #ffffff;
  border: 1px solid #d8c6b0;
  border-radius: 6px;
  padding: 0.45rem 0.85rem;
  font-family: inherit;
  font-size: 0.82rem;
  cursor: pointer;
  color: #4a3829;
  transition: all 0.12s ease;
}
#grounded-chrome .gc-modal .gc-types button.gc-picked {
  background: var(--gc-rust);
  color: var(--gc-cream);
  border-color: var(--gc-rust-deep);
}
#grounded-chrome .gc-modal textarea {
  width: 100%;
  min-height: 110px;
  padding: 0.7rem 0.85rem;
  font-family: inherit;
  font-size: 0.92rem;
  border: 1px solid #d8c6b0;
  border-radius: 6px;
  background: #ffffff;
  color: var(--gc-ink);
  resize: vertical;
  line-height: 1.5;
}
#grounded-chrome .gc-modal textarea:focus {
  outline: none;
  border-color: var(--gc-rust);
  box-shadow: 0 0 0 3px rgba(168, 84, 58, 0.15);
}
#grounded-chrome .gc-modal .gc-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.55rem;
  margin-top: 1.1rem;
}
#grounded-chrome .gc-modal button.gc-cancel {
  background: none;
  border: 1px solid #d8c6b0;
  color: #6b5d52;
  padding: 0.55rem 1rem;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.88rem;
}
#grounded-chrome .gc-modal button.gc-submit {
  background: var(--gc-rust);
  border: none;
  color: var(--gc-cream);
  padding: 0.55rem 1.3rem;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.88rem;
  font-weight: 500;
}
#grounded-chrome .gc-modal button.gc-submit:hover { background: var(--gc-rust-deep); }
#grounded-chrome .gc-modal button.gc-submit:disabled {
  background: #c4a896;
  cursor: wait;
}
#grounded-chrome .gc-modal .gc-result {
  margin-top: 0.9rem;
  padding: 0.7rem 0.85rem;
  border-radius: 6px;
  font-size: 0.85rem;
  line-height: 1.5;
  display: none;
}
#grounded-chrome .gc-modal .gc-result.gc-good {
  background: #e8f0e3;
  color: #355e2c;
  display: block;
}
#grounded-chrome .gc-modal .gc-result.gc-partial {
  background: #fdf0d6;
  color: #7a5b1e;
  display: block;
}
#grounded-chrome .gc-modal .gc-result.gc-bad {
  background: #f7e1de;
  color: #8a3a2c;
  display: block;
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
        '<button class="gc-feedback-btn" type="button" aria-label="Send feedback to Develop AI">' +
          'Feedback' +
        '</button>' +
        '<div class="gc-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="gc-modal-title">' +
          '<div class="gc-modal">' +
            '<h2 id="gc-modal-title">Send feedback to Develop AI</h2>' +
            '<p class="gc-modal-sub">A bug, an idea, a question — anything. Paul reads everything that comes through here.</p>' +
            '<p class="gc-privacy"><strong>Heads up:</strong> what you write here gets committed to your GitHub fork and is visible to Paul through the cohort dashboard. Don\\'t paste source names, unpublished story details, or other sensitive material.</p>' +
            '<label>Type</label>' +
            '<div class="gc-types">' +
              '<button type="button" data-type="bug">Bug</button>' +
              '<button type="button" data-type="suggestion">Suggestion</button>' +
              '<button type="button" data-type="praise">Praise</button>' +
              '<button type="button" data-type="question">Question</button>' +
            '</div>' +
            '<label>Your message</label>' +
            '<textarea placeholder="What\\'s on your mind?" maxlength="4000"></textarea>' +
            '<div class="gc-result"></div>' +
            '<div class="gc-actions">' +
              '<button type="button" class="gc-cancel">Cancel</button>' +
              '<button type="button" class="gc-submit">Send feedback</button>' +
            '</div>' +
          '</div>' +
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

      // ── Feedback widget wiring ─────────────────────────────────
      var backdrop = wrap.querySelector('.gc-modal-backdrop');
      var modal = wrap.querySelector('.gc-modal');
      var openBtn = wrap.querySelector('.gc-feedback-btn');
      var cancelBtn = wrap.querySelector('.gc-cancel');
      var submitBtn = wrap.querySelector('.gc-submit');
      var textarea = wrap.querySelector('textarea');
      var resultBox = wrap.querySelector('.gc-result');
      var typeButtons = wrap.querySelectorAll('.gc-types button');
      var pickedType = null;

      function openModal() {
        backdrop.classList.add('gc-open');
        resultBox.className = 'gc-result';
        resultBox.textContent = '';
        textarea.value = '';
        pickedType = null;
        typeButtons.forEach(function (b) { b.classList.remove('gc-picked'); });
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send feedback';
        setTimeout(function () { textarea.focus(); }, 50);
      }
      function closeModal() {
        backdrop.classList.remove('gc-open');
      }
      openBtn.addEventListener('click', openModal);
      cancelBtn.addEventListener('click', closeModal);
      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) closeModal();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && backdrop.classList.contains('gc-open')) closeModal();
      });
      typeButtons.forEach(function (btn) {
        btn.addEventListener('click', function () {
          pickedType = btn.dataset.type;
          typeButtons.forEach(function (b) { b.classList.toggle('gc-picked', b === btn); });
        });
      });

      submitBtn.addEventListener('click', function () {
        var message = textarea.value.trim();
        if (!pickedType) {
          resultBox.className = 'gc-result gc-bad';
          resultBox.textContent = 'Pick a type (bug / suggestion / praise / question) first.';
          return;
        }
        if (!message) {
          resultBox.className = 'gc-result gc-bad';
          resultBox.textContent = 'Write a message first.';
          textarea.focus();
          return;
        }
        submitBtn.disabled = true;
        submitBtn.textContent = 'Sending…';
        resultBox.className = 'gc-result';
        resultBox.textContent = '';

        fetch('/api/grounded/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: pickedType,
            message: message,
            page: location.pathname + location.search,
          }),
        })
          .then(function (r) { return r.json(); })
          .then(function (out) {
            if (!out.saved) {
              resultBox.className = 'gc-result gc-bad';
              resultBox.textContent = out.error || 'Could not save feedback.';
              submitBtn.disabled = false;
              submitBtn.textContent = 'Send feedback';
              return;
            }
            if (out.synced) {
              resultBox.className = 'gc-result gc-good';
              resultBox.textContent = 'Sent. Paul will see this on the cohort dashboard.';
            } else {
              resultBox.className = 'gc-result gc-partial';
              resultBox.textContent = 'Saved locally. Will reach Paul next time you open the app (couldn\\'t sync now: ' + (out.sync_reason || out.sync_step || 'reason unknown') + ').';
            }
            submitBtn.textContent = 'Sent';
            setTimeout(closeModal, 1800);
          })
          .catch(function (e) {
            resultBox.className = 'gc-result gc-bad';
            resultBox.textContent = 'Could not send. ' + (e && e.message ? e.message : '');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Send feedback';
          });
      });
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
