/**
 * @developai/grounded-node-runtime / src/server-hosted.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One-line boot for the ONLINE (multi-tenant) form of a Node. The hosted twin of
 * createServer(): it mounts the SAME handlers, on the SAME standard routes, but
 *   - storage is a per-request Postgres host scoped to the signed-in newsroom,
 *   - the page is gated behind the tracker login (verifies its JWT cookie),
 *   - the GROUNDED nav, a "run it locally" footer, and a feedback widget are
 *     injected into the Node's existing dashboard HTML.
 *
 *   import { createHostedServer } from "@developai/grounded-node-runtime";
 *   import * as handlers from "./lib/handlers.js";
 *   import { ensureSchema } from "./lib/schema.js";
 *   await createHostedServer({
 *     slug: "analytics", productName: "Audience Signal",
 *     handlers, ensureSchema, staticDir: join(__dirname, "public"),
 *   });
 *
 * Env (in the box's .env, never committed): JWT_SECRET (matches the tracker's),
 * ANTHROPIC_API_KEY (shared), DATABASE_URL or PG* (the box's Postgres). Optional:
 * PORT, AUTH_COOKIE (first cookie name to try), LOGIN_URL, APP_URL, MODEL.
 *
 * pg / cookie-parser / jsonwebtoken are loaded lazily so a local install (which
 * never calls this) doesn't need them.
 */

import express from "express";
import multer from "multer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPgHost, ensureActivitySchema } from "./host-pg.js";
import { readRuntimeVersion } from "./chrome.js";

const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const BASE = "https://grounded.developai.co.za";

// The shared GROUNDED nav (umbrella brand). __GROUNDED_USER__ is filled per request.
const NAV_HTML = `<style id="g-nav-style">
#g-nav{border-bottom:1px solid #E2E8F0;background:#fff;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif}
#g-nav .g-bar{max-width:1180px;margin:0 auto;padding:12px 26px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
#g-nav .g-brand{text-decoration:none;color:#1A202C;display:flex;flex-direction:column;line-height:1.2}
#g-nav .g-brand b{font-size:18px;font-weight:700;letter-spacing:-0.01em}
#g-nav .g-brand span{font-size:11px;color:#718096;font-weight:500}
#g-nav .g-links{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
#g-nav .g-links a{padding:8px 12px;border-radius:6px;font-size:14px;font-weight:500;color:#718096;text-decoration:none}
#g-nav .g-links a:hover{color:#1A202C}
#g-nav .g-links a.active{font-weight:600;color:#1A202C;background:#EEF2FF}
#g-nav .g-user{display:flex;align-items:center;gap:10px;padding-left:10px;margin-left:4px;border-left:1px solid #E2E8F0}
#g-nav .g-email{font-size:13px;color:#1A202C;font-weight:600;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#g-nav .g-logout{margin:0}
#g-nav .g-logout button{font:inherit;font-size:13px;font-weight:500;color:#718096;background:none;border:1px solid #E2E8F0;border-radius:6px;padding:7px 12px;cursor:pointer}
#g-nav .g-logout button:hover{color:#1A202C;border-color:#CBD5E1}
</style>
<nav id="g-nav"><div class="g-bar">
  <a class="g-brand" href="/"><b>Grounded</b><span>Newsroom-owned AI &middot; by Develop&nbsp;AI</span></a>
  <div class="g-links">
    <a href="/">Home</a>
    <a href="/legal/lawsuits">Lawsuits</a>
    <a href="/legal/regulations">Regulations</a>
    <a href="/legal/explore">Connections</a>
    <a href="/legal/use-cases">Use cases</a>
    <a href="/tools/">Tools</a>
    <a href="/legal/sources">Sources</a>
    <a href="/legal/submit">Submit</a>
    <a href="/nodes/" class="active">Nodes</a>
    <span class="g-user">
      <span class="g-email" title="__GROUNDED_USER__">__GROUNDED_USER__</span>
      <form class="g-logout" method="POST" action="/api/auth/logout"><button type="submit">Sign out</button></form>
    </span>
  </div>
</div></nav>`;

const footerHtml = (slug, repo) => `<style>
#g-local{background:#0d0c0a;border-top:2px solid #c4761b;color:#ede4d3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:34px 26px 44px}
#g-local .gl-wrap{max-width:1180px;margin:0 auto}
#g-local h3{font-size:19px;font-weight:600;margin:0 0 6px}
#g-local p{color:#a89e88;font-size:14px;margin:0 0 18px;max-width:70ch}
#g-local .gl-row{display:grid;grid-template-columns:78px 1fr auto;gap:10px;align-items:center;margin-bottom:8px}
#g-local .gl-os{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#a89e88}
#g-local code{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:12.5px;background:#1c1a14;color:#e8a13a;border:1px solid #3a352a;border-radius:5px;padding:10px 12px;overflow-x:auto;white-space:nowrap}
#g-local .gl-copy{font-family:inherit;font-size:12px;background:#1c1a14;color:#ede4d3;border:1px solid #3a352a;border-radius:5px;padding:9px 13px;cursor:pointer}
#g-local .gl-copy:hover{border-color:#c4761b;color:#e8a13a}
#g-local .gl-note{margin-top:16px;font-size:13px;color:#a89e88}
#g-local .gl-note a{color:#e8a13a;text-decoration:none}
#g-local .gl-note a:hover{text-decoration:underline}
@media(max-width:640px){#g-local .gl-row{grid-template-columns:1fr;gap:5px}}
</style>
<footer id="g-local"><div class="gl-wrap">
  <h3>Prefer to run it on your own computer?</h3>
  <p>Everything here also runs locally, on your own machine &mdash; your data never leaves your computer. Paste one line into your computer's built-in terminal; nothing to install by hand.</p>
  <div class="gl-row"><span class="gl-os">macOS</span><code id="gl-mac">curl -fsSL ${BASE}/nodes/${slug}/mac | bash</code><button class="gl-copy" data-t="gl-mac">Copy</button></div>
  <div class="gl-row"><span class="gl-os">Windows</span><code id="gl-win">irm ${BASE}/nodes/${slug}/windows | iex</code><button class="gl-copy" data-t="gl-win">Copy</button></div>
  <p class="gl-note">Or <a href="/nodes/">see all Nodes</a> &middot; <a href="https://github.com/pauldevelopai/${repo}" target="_blank" rel="noopener">get the code on GitHub</a>.</p>
</div>
<script>
document.querySelectorAll('#g-local .gl-copy').forEach(function(b){
  b.addEventListener('click', function(){
    var el=document.getElementById(b.getAttribute('data-t'));
    try{ navigator.clipboard.writeText(el.textContent.trim()); }catch(e){}
    var o=b.textContent; b.textContent='Copied'; setTimeout(function(){b.textContent=o;},1300);
  });
});
</script></footer>`;

// Feedback widget → posts to the tracker's /api/feedback (same origin, cookie rides along).
const FEEDBACK_HTML = `<style>
#g-fb-btn{position:fixed;right:18px;bottom:18px;z-index:99990;background:#c4761b;color:#fff;border:none;border-radius:999px;padding:11px 18px;font:600 13px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.3)}
#g-fb-btn:hover{background:#a8543a}
#g-fb-panel{position:fixed;right:18px;bottom:66px;z-index:99991;width:320px;max-width:calc(100vw - 36px);background:#1c1a14;border:1px solid #3a352a;border-radius:10px;padding:16px;display:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#ede4d3;box-shadow:0 10px 30px rgba(0,0,0,.45)}
#g-fb-panel.open{display:block}
#g-fb-panel h4{margin:0 0 8px;font-size:14px;font-weight:600}
#g-fb-types{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}
#g-fb-types button{background:#0d0c0a;border:1px solid #3a352a;color:#a89e88;border-radius:5px;padding:5px 9px;font-size:11px;cursor:pointer}
#g-fb-types button.on{background:#c4761b;color:#fff;border-color:#c4761b}
#g-fb-panel textarea{width:100%;min-height:78px;background:#0d0c0a;color:#ede4d3;border:1px solid #3a352a;border-radius:6px;padding:9px;font:inherit;font-size:13px;resize:vertical}
#g-fb-rowx{display:flex;gap:6px;margin-top:8px}
#g-fb-rowx select{flex:1;background:#0d0c0a;color:#ede4d3;border:1px solid #3a352a;border-radius:5px;padding:7px;font-size:12px}
#g-fb-send{background:#c4761b;color:#fff;border:none;border-radius:5px;padding:7px 16px;font:600 13px inherit;cursor:pointer}
#g-fb-send:disabled{opacity:.6;cursor:wait}
#g-fb-result{font-size:12px;margin-top:8px}
</style>
<button id="g-fb-btn" type="button">Feedback</button>
<div id="g-fb-panel">
  <h4>Send feedback to Develop AI</h4>
  <div id="g-fb-types">
    <button data-c="bug" type="button">Bug</button>
    <button data-c="feature" class="on" type="button">Feature</button>
    <button data-c="improvement" type="button">Improvement</button>
    <button data-c="ui" type="button">UI</button>
  </div>
  <textarea id="g-fb-text" placeholder="A bug, an idea, a question — anything."></textarea>
  <div id="g-fb-rowx">
    <select id="g-fb-pri"><option value="low">Low priority</option><option value="medium" selected>Medium priority</option><option value="high">High priority</option></select>
    <button id="g-fb-send" type="button">Send</button>
  </div>
  <div id="g-fb-result"></div>
</div>
<script>
(function(){
  var btn=document.getElementById('g-fb-btn'),panel=document.getElementById('g-fb-panel'),
      text=document.getElementById('g-fb-text'),send=document.getElementById('g-fb-send'),
      pri=document.getElementById('g-fb-pri'),result=document.getElementById('g-fb-result'),cat='feature';
  btn.addEventListener('click',function(){panel.classList.toggle('open');if(panel.classList.contains('open'))text.focus();});
  document.querySelectorAll('#g-fb-types button').forEach(function(b){
    b.addEventListener('click',function(){cat=b.getAttribute('data-c');document.querySelectorAll('#g-fb-types button').forEach(function(x){x.classList.toggle('on',x===b);});});
  });
  send.addEventListener('click',function(){
    var content=text.value.trim();
    if(!content){result.style.color='#d9543f';result.textContent='Write a message first.';return;}
    send.disabled=true;result.style.color='#a89e88';result.textContent='Sending...';
    fetch('/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',
      body:JSON.stringify({content:content,category:cat,priority:pri.value,page:location.pathname})})
      .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
      .then(function(){result.style.color='#7fae6a';result.textContent='Sent — thanks!';text.value='';setTimeout(function(){panel.classList.remove('open');result.textContent='';},1600);})
      .catch(function(e){result.style.color='#d9543f';result.textContent='Could not send ('+e.message+').';})
      .finally(function(){send.disabled=false;});
  });
})();
</script>`;

export async function createHostedServer({
  slug,
  handlers = {},
  ensureSchema,
  productName,
  displayName,
  nodeVersion,
  repo,
  port = process.env.PORT || 3002,
  staticDir = "public",
  uploadLimitMb = 25,
} = {}) {
  if (!slug) throw new Error("createHostedServer: slug is required");

  // Lazy-load the hosted-only deps so local installs never need them.
  const [{ default: pg }, { default: cookieParser }, { default: jwt }] = await Promise.all([
    import("pg"), import("cookie-parser"), import("jsonwebtoken"),
  ]);

  const JWT_SECRET = process.env.JWT_SECRET;
  const AUTH_COOKIE = process.env.AUTH_COOKIE || "tracker_token";
  const LOGIN_URL = process.env.LOGIN_URL || "/login";
  const APP_URL = process.env.APP_URL || `/nodes/${slug}/app/`;
  const banner = displayName || productName || slug;
  const repoName = repo || `node-${slug}`;

  if (!JWT_SECRET) {
    console.error("FATAL: JWT_SECRET not set — it must match the tracker's config.jwtSecret.");
    process.exit(1);
  }

  const pool = new pg.Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});
  await ensureActivitySchema(pool, slug);
  if (typeof ensureSchema === "function") await ensureSchema(pool);

  // The tracker's JWT payload is { id, email, role, sector_ids } — no org id, so
  // we scope per user account (account == newsroom in the pilot).
  const tenantOf = (u) => String(u.id);
  const nameOf = (u) => u.email || null;

  function readUser(req) {
    const cookies = req.cookies || {};
    // The tracker has renamed its auth cookie across rebrands; accept whichever
    // cookie carries a token our shared JWT_SECRET can verify. AUTH_COOKIE first.
    const names = [AUTH_COOKIE, ...Object.keys(cookies)].filter((n, i, a) => n && a.indexOf(n) === i);
    let sawToken = false;
    for (const name of names) {
      const token = cookies[name];
      if (!token) continue;
      sawToken = true;
      try { return jwt.verify(token, JWT_SECRET); } catch { /* try next */ }
    }
    if (sawToken) {
      console.warn(`[auth] cookie(s) present (${Object.keys(cookies).join(", ")}) but none verified with ` +
        `JWT_SECRET — does this app's JWT_SECRET match the tracker's config.jwtSecret?`);
    }
    return null;
  }

  // Build the page once; per-user email substituted per request.
  const rawIndex = readFileSync(join(staticDir, "index.html"), "utf8");
  const INDEX_HTML = rawIndex
    .replace("<body>", `<body>\n${NAV_HTML}`)
    .replace("</body>", `${footerHtml(slug, repoName)}\n${FEEDBACK_HTML}\n</body>`);
  const pageFor = (user) => INDEX_HTML.replace(/__GROUNDED_USER__/g, escHtml(user && user.email));

  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(cookieParser());

  const hostFor = (req) => createPgHost({
    pool, slug, newsroomId: tenantOf(req.user), newsroom: nameOf(req.user), nodeVersion,
  });

  // Every /api/* call needs a valid tracker session.
  app.use("/api", (req, res, next) => {
    const user = readUser(req);
    if (!user) return res.status(401).json({ error: "Not signed in.", login: LOGIN_URL });
    req.user = user;
    next();
  });

  const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(hostFor(req), req.body || req.query || {})); }
    catch (e) { res.status(500).json({ error: e.message || "node error" }); }
  };

  // Same standard route map as createServer() — mounted only if the handler exists.
  if (handlers.getSetupStatus) app.get("/api/setup",    wrap((h) => handlers.getSetupStatus(h)));
  if (handlers.postSetup)      app.post("/api/setup",   wrap((h, b) => handlers.postSetup(h, b)));
  if (handlers.listSources)    app.get("/api/sources",  wrap((h) => handlers.listSources(h)));
  if (handlers.getReport)      app.get("/api/report",   wrap((h, q) => handlers.getReport(h, q)));
  if (handlers.getQuality)     app.get("/api/quality",  wrap((h, q) => handlers.getQuality(h, q)));
  if (handlers.getActivity)    app.get("/api/activity", wrap((h) => handlers.getActivity(h)));
  if (handlers.postBrief)      app.post("/api/brief",   wrap((h, b) => handlers.postBrief(h, b)));

  if (handlers.postIngest) {
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: uploadLimitMb * 1024 * 1024 } });
    app.post("/api/ingest", upload.single("file"), async (req, res) => {
      try {
        if (!req.file) throw new Error("Choose a file to upload first.");
        console.log(`[ingest] name="${req.file.originalname}" type="${req.file.mimetype}" size=${req.file.buffer.length}B`);
        const out = await handlers.postIngest(hostFor(req), {
          buffer: req.file.buffer,
          sourceLabel: (req.body && req.body.sourceLabel) || req.file.originalname.replace(/\.[^.]+$/, ""),
        });
        res.json(out);
      } catch (e) { console.error("[ingest] failed:", e.message); res.status(500).json({ error: e.message }); }
    });
  }

  // Static assets are public; the page itself is gated.
  app.use(express.static(staticDir, { index: false }));
  app.get("*", (req, res) => {
    const user = readUser(req);
    if (!user) {
      const present = Object.keys(req.cookies || {});
      console.log(`[auth] bounce → login. expecting '${AUTH_COOKIE}'; cookies received: ${present.join(", ") || "(none)"}`);
      const next = APP_URL ? `?next=${encodeURIComponent(APP_URL)}` : "";
      return res.redirect(`${LOGIN_URL}${next}`);
    }
    res.type("html").send(pageFor(user));
  });

  app.listen(port, () => {
    console.log(`\n  ${banner} (hosted, multi-tenant · runtime v${readRuntimeVersion()}) listening on http://localhost:${port}\n`);
  });

  return app;
}
