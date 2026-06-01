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
import { createPgHost, ensureActivitySchema, ensureStoreSchema } from "./host-pg.js";
import { readRuntimeVersion } from "./chrome.js";

const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const BASE = "https://grounded.developai.co.za";

const footerHtml = (slug, repo) => `<style>
#g-local{background:#F8FAFC;border-top:1px solid #E2E8F0;color:#1A202C;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:34px 26px 44px}
#g-local .gl-wrap{max-width:1180px;margin:0 auto}
#g-local h3{font-size:19px;font-weight:600;margin:0 0 6px}
#g-local p{color:#64748B;font-size:14px;margin:0 0 18px;max-width:70ch}
#g-local .gl-row{display:grid;grid-template-columns:78px 1fr auto;gap:10px;align-items:center;margin-bottom:8px}
#g-local .gl-os{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#64748B}
#g-local code{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:12.5px;background:#F1F5F9;color:#1A202C;border:1px solid #E2E8F0;border-radius:5px;padding:10px 12px;overflow-x:auto;white-space:nowrap}
#g-local .gl-copy{font-family:inherit;font-size:12px;background:#fff;color:#64748B;border:1px solid #E2E8F0;border-radius:5px;padding:9px 13px;cursor:pointer}
#g-local .gl-copy:hover{border-color:#3B82F6;color:#3B82F6}
#g-local .gl-note{margin-top:16px;font-size:13px;color:#64748B}
#g-local .gl-note a{color:#3B82F6;text-decoration:none}
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

export async function createHostedServer({
  slug,
  handlers = {},
  ensureSchema,
  mountRoutes,
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
  await ensureStoreSchema(pool, slug);
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

  // The Grounded chrome — the Builder/Tracker nav + the feedback & chat bubbles —
  // is injected by ONE shared script served from the static front door
  // (/nodes/chrome.js). That keeps every surface (front door, hosted Nodes, the
  // tracker) identical and lets the menu change without redeploying any Node:
  // just edit chrome.js and pull the nodes repo on the box. It's auth-aware on
  // its own (GET /api/auth/me), so no per-user templating is needed here. We keep
  // only the Node-specific "run it locally" footer.
  // A Node's index.html opts into the LOCAL chrome with two tags
  // (grounded-chrome.css / grounded-chrome.js) that mountChrome serves in
  // standalone mode. Hosted has no such routes, so left in place they fall
  // through to the auth catch-all below: anonymous users get a 302 to /login,
  // signed-in users get the HTML page back — which the browser then refuses to
  // run as CSS/JS, one wasted round-trip + console error per load. Hosted gets
  // its chrome from the shared /nodes/chrome.js (injected below), so strip them.
  const rawIndex = readFileSync(join(staticDir, "index.html"), "utf8");
  const INDEX_HTML = rawIndex
    .replace(/[ \t]*<link\b[^>]*\bgrounded-chrome\.css\b[^>]*>\s*\n?/i, "")
    .replace(/[ \t]*<script\b[^>]*\bgrounded-chrome\.js\b[^>]*><\/script>\s*\n?/i, "")
    .replace("</body>", `${footerHtml(slug, repoName)}\n<script src="/nodes/chrome.js" defer></script>\n</body>`);
  const pageFor = () => INDEX_HTML;

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

  // Custom routes — a Node mounts its non-standard endpoints here (e.g.
  // /api/listener/*). Runs after the standard /api routes and BEFORE the static
  // + catch-all, so it isn't swallowed. The Node gets hostFor(req) to build a
  // per-request, newsroom-scoped host (same as the standard routes use).
  if (typeof mountRoutes === "function") {
    mountRoutes(app, { hostFor, readUser });
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
