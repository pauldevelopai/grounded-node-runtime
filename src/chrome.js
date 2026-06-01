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
   the top of this rule set so swapping colours is one-line work.
   Light Grounded palette — matches the tracker + the /nodes/chrome.js nav. */

#grounded-chrome {
  /* Terracotta — the single Grounded accent, identical across the tracker,
     the nodes front door and every Node bubble. (Var names kept for diff
     stability; the values are now terracotta.) */
  --gc-blue: #c4761b;
  --gc-blue-deep: #a8543a;
  --gc-blue-light: #e0a368;
  --gc-bg: #ffffff;
  --gc-bg-soft: #F8FAFC;
  --gc-ink: #1A202C;
  --gc-dim: #64748B;
  --gc-border: #E2E8F0;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* Top bar — slim white banner with a bottom border, matching the nav.
   Sets parent-platform context the moment the page loads. */
#grounded-chrome .gc-topbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 34px;
  z-index: 99998;
  background: var(--gc-bg);
  color: var(--gc-ink);
  border-bottom: 1px solid var(--gc-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 18px;
  font-size: 12px;
  letter-spacing: 0.5px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}
#grounded-chrome .gc-topbar .gc-mark {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  color: var(--gc-ink);
  text-decoration: none;
  font-weight: 700;
  letter-spacing: 1.6px;
  font-size: 12px;
}
#grounded-chrome .gc-topbar .gc-mark::before {
  content: "";
  width: 9px;
  height: 9px;
  background: var(--gc-blue);
  border-radius: 50%;
  box-shadow: 0 0 0 2px rgba(196,118,27,0.18);
  display: inline-block;
}
#grounded-chrome .gc-topbar .gc-mark:hover { color: var(--gc-blue-deep); }
#grounded-chrome .gc-topbar .gc-context {
  font-size: 11px;
  color: var(--gc-dim);
  letter-spacing: 0.3px;
}
#grounded-chrome .gc-topbar .gc-context .gc-newsroom {
  font-weight: 600;
  color: var(--gc-ink);
  letter-spacing: 0.4px;
}
#grounded-chrome .gc-topbar .gc-context .gc-sep {
  margin: 0 0.55rem;
  opacity: 0.5;
}

/* Footer — light, with a blue accent dot so top and bottom feel related. */
#grounded-chrome .gc-footer {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 99998;
  background: rgba(248, 250, 252, 0.96);
  color: var(--gc-dim);
  font-size: 11px;
  letter-spacing: 0.25px;
  padding: 6px 18px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  border-top: 1px solid var(--gc-border);
}
#grounded-chrome .gc-footer .gc-foot-left {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--gc-ink);
}
#grounded-chrome .gc-footer .gc-foot-left::before {
  content: "";
  width: 6px;
  height: 6px;
  background: var(--gc-blue);
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

/* Floating bubbles — Ask For Help (chat) + Feedback, stacked above the footer.
   Round terracotta icon buttons, identical to the tracker + front-door bubbles.
   Feedback is the corner button; the chat bubble stacks above it. */
#grounded-chrome .gc-bubbles {
  position: fixed;
  right: 20px;
  bottom: 44px;
  z-index: 99997;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
#grounded-chrome .gc-bub {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: var(--gc-blue);
  color: #ffffff;
  border: none;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.12s ease, background 0.12s ease;
}
#grounded-chrome .gc-bub:hover { background: var(--gc-blue-deep); transform: translateY(-1px); }
#grounded-chrome .gc-bub svg { width: 22px; height: 22px; }

/* Ask For Help chat panel */
#grounded-chrome .gc-chat {
  position: fixed;
  right: 20px;
  bottom: 44px;
  z-index: 99999;
  width: 380px;
  max-width: calc(100vw - 40px);
  height: 560px;
  max-height: calc(100vh - 90px);
  background: #ffffff;
  border: 1px solid var(--gc-border);
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.22);
  display: none;
  flex-direction: column;
  overflow: hidden;
}
#grounded-chrome .gc-chat.gc-open { display: flex; }
#grounded-chrome .gc-chat-head {
  padding: 12px 14px;
  background: #0B1220;
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
#grounded-chrome .gc-chat-head .gc-chat-title { font-size: 14px; font-weight: 700; display: block; }
#grounded-chrome .gc-chat-head .gc-chat-sub { font-size: 10px; color: #94A3B8; display: block; }
#grounded-chrome .gc-chat-head .gc-chat-x {
  background: none; border: none; color: #94A3B8; cursor: pointer; font-size: 14px; padding: 4px 8px;
}
#grounded-chrome .gc-chat-log { flex: 1; overflow-y: auto; padding: 12px; background: #FAFAF9; }
#grounded-chrome .gc-chat-intro { font-size: 13px; color: var(--gc-ink); margin-bottom: 12px; line-height: 1.5; }
#grounded-chrome .gc-suggest {
  display: block; width: 100%; text-align: left; margin-bottom: 4px;
  padding: 8px 10px; font-size: 12px; border: 1px solid var(--gc-border);
  border-radius: 8px; background: #ffffff; color: var(--gc-ink); cursor: pointer;
}
#grounded-chrome .gc-msg { margin: 6px 0; display: flex; }
#grounded-chrome .gc-msg.gc-me { justify-content: flex-end; }
#grounded-chrome .gc-msg .gc-txt {
  max-width: 85%; padding: 9px 12px; border-radius: 12px;
  font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
}
#grounded-chrome .gc-msg.gc-me .gc-txt { background: var(--gc-blue); color: #ffffff; }
#grounded-chrome .gc-msg.gc-them .gc-txt { background: #ffffff; color: var(--gc-ink); border: 1px solid var(--gc-border); }
#grounded-chrome .gc-chat-form { padding: 10px; border-top: 1px solid var(--gc-border); display: flex; gap: 6px; }
#grounded-chrome .gc-chat-form input {
  flex: 1; padding: 8px 12px; font-size: 13px;
  border: 1px solid var(--gc-border); border-radius: 6px; background: #ffffff; color: var(--gc-ink);
}
#grounded-chrome .gc-chat-form button {
  padding: 0 14px; font-size: 13px; font-weight: 600; cursor: pointer;
  border: none; border-radius: 6px; background: var(--gc-blue); color: #ffffff;
}
#grounded-chrome .gc-chat-form button:disabled { opacity: 0.5; cursor: default; }

/* Modal */
#grounded-chrome .gc-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  z-index: 99999;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
#grounded-chrome .gc-modal-backdrop.gc-open { display: flex; }
#grounded-chrome .gc-modal {
  background: var(--gc-bg);
  color: var(--gc-ink);
  border: 1px solid var(--gc-border);
  border-radius: 10px;
  max-width: 520px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  padding: 1.5rem 1.75rem 1.25rem;
  box-shadow: 0 18px 50px rgba(0,0,0,0.18);
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
#grounded-chrome .gc-modal h2 {
  margin: 0 0 0.35rem;
  font-size: 1.1rem;
  font-weight: 600;
  letter-spacing: 0.2px;
}
#grounded-chrome .gc-modal .gc-modal-sub {
  color: var(--gc-dim);
  font-size: 0.85rem;
  margin-bottom: 1rem;
  line-height: 1.5;
}
#grounded-chrome .gc-modal .gc-privacy {
  font-size: 0.78rem;
  background: #FDF3E7;
  border-left: 3px solid var(--gc-blue);
  padding: 0.55rem 0.75rem;
  margin: 0 0 1rem;
  color: #8a4b12;
  line-height: 1.5;
  border-radius: 0 4px 4px 0;
}
#grounded-chrome .gc-modal label {
  display: block;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--gc-dim);
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
  border: 1px solid var(--gc-border);
  border-radius: 6px;
  padding: 0.45rem 0.85rem;
  font-family: inherit;
  font-size: 0.82rem;
  cursor: pointer;
  color: var(--gc-ink);
  transition: all 0.12s ease;
}
#grounded-chrome .gc-modal .gc-types button.gc-picked {
  background: var(--gc-blue);
  color: #ffffff;
  border-color: var(--gc-blue-deep);
}
#grounded-chrome .gc-modal textarea {
  width: 100%;
  min-height: 110px;
  padding: 0.7rem 0.85rem;
  font-family: inherit;
  font-size: 0.92rem;
  border: 1px solid var(--gc-border);
  border-radius: 6px;
  background: #ffffff;
  color: var(--gc-ink);
  resize: vertical;
  line-height: 1.5;
}
#grounded-chrome .gc-modal textarea:focus {
  outline: none;
  border-color: var(--gc-blue);
  box-shadow: 0 0 0 3px rgba(196, 118, 27, 0.15);
}
#grounded-chrome .gc-modal .gc-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.55rem;
  margin-top: 1.1rem;
}
#grounded-chrome .gc-modal button.gc-cancel {
  background: none;
  border: 1px solid var(--gc-border);
  color: var(--gc-dim);
  padding: 0.55rem 1rem;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.88rem;
}
#grounded-chrome .gc-modal button.gc-submit {
  background: var(--gc-blue);
  border: none;
  color: #ffffff;
  padding: 0.55rem 1.3rem;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.88rem;
  font-weight: 500;
}
#grounded-chrome .gc-modal button.gc-submit:hover { background: var(--gc-blue-deep); }
#grounded-chrome .gc-modal button.gc-submit:disabled {
  background: var(--gc-blue-light);
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
  background: #D1FAE5;
  color: #065F46;
  display: block;
}
#grounded-chrome .gc-modal .gc-result.gc-partial {
  background: #FEF3C7;
  color: #92400E;
  display: block;
}
#grounded-chrome .gc-modal .gc-result.gc-bad {
  background: #FEE2E2;
  color: #991B1B;
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

  // The Ask For Help chat reaches the central Grounded server (the same
  // /public/chat the tracker + front door use), so a locally-run Node gives
  // the same answers as the hosted surfaces. Needs the user to be online.
  var CHAT_URL = 'https://grounded.developai.co.za/public/chat';
  var CHAT_STORE = 'grounded_help_v1';
  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
  var ICON_FB = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  var CHAT_SUGGEST = [
    'What cases has OpenAI been sued in?',
    'When does the EU AI Act take effect?',
    'What is the Colorado AI Act?',
  ];

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
          '<a class="gc-mark" href="https://grounded.developai.co.za" target="_blank" rel="noopener">' +
            'GROUNDED' +
          '</a>' +
          contextRight +
        '</div>' +
        '<div class="gc-bubbles">' +
          '<button class="gc-bub gc-chat-open" type="button" aria-label="Ask For Help" title="Ask For Help">' + ICON_CHAT + '</button>' +
          '<button class="gc-bub gc-fb-open" type="button" aria-label="Send feedback" title="Send feedback to Develop AI">' + ICON_FB + '</button>' +
        '</div>' +
        '<div class="gc-chat" role="dialog" aria-label="Ask For Help">' +
          '<div class="gc-chat-head">' +
            '<div><span class="gc-chat-title">Ask For Help</span><span class="gc-chat-sub">Powered by Claude</span></div>' +
            '<button class="gc-chat-x" type="button" aria-label="Close">\\u2715</button>' +
          '</div>' +
          '<div class="gc-chat-log"></div>' +
          '<form class="gc-chat-form">' +
            '<input type="text" placeholder="Ask a question\\u2026" maxlength="500" autocomplete="off" />' +
            '<button type="submit">Send</button>' +
          '</form>' +
        '</div>' +
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
      var openBtn = wrap.querySelector('.gc-fb-open');
      var cancelBtn = wrap.querySelector('.gc-cancel');
      var submitBtn = wrap.querySelector('.gc-submit');
      var textarea = wrap.querySelector('textarea');
      var resultBox = wrap.querySelector('.gc-result');
      var typeButtons = wrap.querySelectorAll('.gc-types button');
      var pickedType = null;

      function openModal() {
        chatClose();
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

      // ── Ask For Help chat wiring ───────────────────────────────
      var chatPanel = wrap.querySelector('.gc-chat');
      var chatOpenBtn = wrap.querySelector('.gc-chat-open');
      var chatX = wrap.querySelector('.gc-chat-x');
      var chatLog = wrap.querySelector('.gc-chat-log');
      var chatForm = wrap.querySelector('.gc-chat-form');
      var chatInput = chatForm.querySelector('input');
      var chatSend = chatForm.querySelector('button');
      var chatBusy = false;
      var chatHistory = [];
      try { chatHistory = JSON.parse(sessionStorage.getItem(CHAT_STORE) || '[]') || []; } catch (e) {}

      function chatStrip(t) {
        return String(t == null ? '' : t)
          .replace(/\\[(lawsuit|regulation):[0-9a-f-]{8,}\\]/gi, '')
          .replace(/\\s+([.,;:])/g, '$1')
          .trim();
      }
      function chatSave() {
        try { sessionStorage.setItem(CHAT_STORE, JSON.stringify(chatHistory)); } catch (e) {}
      }
      function chatRender() {
        chatLog.innerHTML = '';
        if (!chatHistory.length) {
          var intro = document.createElement('div');
          intro.className = 'gc-chat-intro';
          intro.textContent = 'Ask about the AI lawsuits and regulations Grounded tracks. I summarise public records — I am not a lawyer.';
          chatLog.appendChild(intro);
          CHAT_SUGGEST.forEach(function (s) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'gc-suggest';
            b.textContent = s;
            b.addEventListener('click', function () { chatSendMsg(s); });
            chatLog.appendChild(b);
          });
        } else {
          chatHistory.forEach(function (msg) {
            var row = document.createElement('div');
            row.className = 'gc-msg ' + (msg.role === 'user' ? 'gc-me' : 'gc-them');
            var t = document.createElement('div');
            t.className = 'gc-txt';
            t.textContent = msg.content;
            row.appendChild(t);
            chatLog.appendChild(row);
          });
        }
        if (chatBusy) {
          var br = document.createElement('div');
          br.className = 'gc-msg gc-them';
          var bt = document.createElement('div');
          bt.className = 'gc-txt';
          bt.textContent = 'Thinking…';
          br.appendChild(bt);
          chatLog.appendChild(br);
        }
        chatLog.scrollTop = chatLog.scrollHeight;
      }
      function chatOpen() {
        closeModal();
        chatPanel.classList.add('gc-open');
        chatRender();
        setTimeout(function () { chatInput.focus(); }, 50);
      }
      function chatClose() { chatPanel.classList.remove('gc-open'); }
      function chatSendMsg(text) {
        var msg = (text || '').trim();
        if (!msg || chatBusy) return;
        chatHistory.push({ role: 'user', content: msg });
        chatSave();
        chatBusy = true;
        chatInput.value = '';
        chatSend.disabled = true;
        chatRender();
        var prior = chatHistory.slice(0, -1).map(function (h) { return { role: h.role, content: h.content }; });
        fetch(CHAT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg, history: prior }),
        })
          .then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; });
          })
          .then(function (res) {
            chatBusy = false;
            chatSend.disabled = false;
            var reply = res.j && (res.j.reply || res.j.message || res.j.answer);
            if (!res.ok || !reply) {
              reply = (res.j && res.j.error) || 'Sorry — I could not answer just now. Please try again.';
            }
            chatHistory.push({ role: 'assistant', content: chatStrip(reply) });
            chatSave();
            chatRender();
          })
          .catch(function () {
            chatBusy = false;
            chatSend.disabled = false;
            chatHistory.push({ role: 'assistant', content: 'Could not reach the help service. Check your connection and try again.' });
            chatSave();
            chatRender();
          });
      }
      chatOpenBtn.addEventListener('click', function () {
        if (chatPanel.classList.contains('gc-open')) { chatClose(); } else { chatOpen(); }
      });
      chatX.addEventListener('click', chatClose);
      chatForm.addEventListener('submit', function (e) {
        e.preventDefault();
        chatSendMsg(chatInput.value);
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && chatPanel.classList.contains('gc-open')) chatClose();
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
