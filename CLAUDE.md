# grounded-node-runtime

Shared scaffolding every GROUNDED Node builds on. Part of **Grounded** (newsroom-owned
AI by Develop AI). A Node = a small app whose handlers target a **host interface**
(`host.db / host.store / host.ai / host.parse / host.log / host.feedback / host.meta /
host.tablePrefix`) so the *same handlers* run two ways. **Current tag: `v0.9.0`.**

## Exports (`src/index.js`)
- **`createLiteHost({ appSlug, nodeVersion, newsroom })`** (`host-lite.js`) — local host: JSON files on disk, the user's own AI key. Plus a sticky `host.meta.host_id`.
- **`createServer({ slug, host, handlers, displayName, nodeVersion })`** (`server.js`) — LOCAL Express boot. Maps standard handler names → routes (`getSetupStatus`→`/api/setup`, `postSetup`, `listSources`→`/api/sources`, `getReport`, `getQuality`, `getActivity`, `postBrief`, `postIngest`→`/api/ingest`). Returns the app, so a Node can add custom routes after (node-podcasting does: `/api/voices`, `/api/podcasts`, …).
- **`createHostedServer({ slug, handlers, ensureSchema, mountRoutes, productName, staticDir, repo, nodeVersion })`** (`server-hosted.js`) — ONLINE (multi-tenant) boot. Verifies the tracker's JWT cookie (name-agnostic — accepts whichever cookie verifies with `JWT_SECRET`; default `tracker_token`), builds a per-request Postgres host scoped to the signed-in newsroom, mounts the SAME standard route map, and injects the Grounded nav + sign-out + "run it locally" footer + feedback widget into the Node's dashboard HTML.
  - `ensureSchema(pool, slug)` — optional; create your `node_<slug>_*` tables (the **node-analytics** pattern).
  - `mountRoutes(app, { hostFor, readUser })` — optional; attach custom routes. `hostFor(req)` returns a per-request, newsroom-scoped host (the **node-verifier** pattern, for its `/api/listener/*` routes).
- **`host.store`** — per-newsroom key/value, identical API local + hosted: `list(collection)` / `get(collection,key)` / `put(collection,key,value)` / `delete(collection,key)`. Locally backed by JSON files; online by a `node_<slug>_store(newsroom_id,collection,key,value jsonb,…)` table. This is what lets a file-based Node go multi-tenant without writing SQL.
- **`createPgHost` / `ensureActivitySchema` / `ensureStoreSchema`** (`host-pg.js`) — the multi-tenant Postgres host + the generic `node_<slug>_activity` and `node_<slug>_store` tables (both auto-created by `createHostedServer`). A Node's *own* relational tables come from the `ensureSchema` it passes.
- `mountChrome`, `readRuntimeVersion` (`chrome.js`); `telemetry.js` (collector POST when `GROUNDED_TELEMETRY_URL` set).

## Deps
Regular: express, multer, mammoth, @anthropic-ai/sdk, openai, dotenv (used by local + hosted).
**optionalDependencies**: pg, cookie-parser, jsonwebtoken — used ONLY by `createHostedServer`, **lazy-imported** so a newsroom's local install never loads or needs them.

## Versioning — IMPORTANT
Nodes consume this via `github:pauldevelopai/grounded-node-runtime#vX.Y.Z`. When you change the runtime: bump `package.json` version, commit, **and move the matching git tag** (`git tag -f vX.Y.Z && git push -f origin vX.Y.Z`), then bump the tag in each Node's `package.json`.
**npm caches github deps** — after pointing a Node at a new tag, a plain `npm install` may serve the stale copy. Force it: `rm -rf node_modules/@developai && npm install`.

## What does NOT belong here
Node-specific app logic (matrix parsing, voice cloning, dashboards) lives in each `node-<slug>` repo, not here. This repo is only the shared plumbing. Changing it affects EVERY Node's local install — test before tagging.

See the tracker repo's `CLAUDE.md` for the full system map + the box/Caddy topology.
