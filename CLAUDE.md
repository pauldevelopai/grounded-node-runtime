# grounded-node-runtime

Shared scaffolding every GROUNDED Node builds on. Part of **Grounded** (newsroom-owned
AI by Develop AI). A Node = a small app whose handlers target a **host interface**
(`host.db / host.store / host.profile / host.corpus / host.ai / host.parse / host.log /
host.feedback / host.meta / host.tablePrefix`) so the *same handlers* run three ways (local web / hosted multi-tenant / MCP tools). **Current tag: `v0.18.0`** (the tracker's
`CLAUDE.md` is the source of truth if this line lags).

## Hosted chrome — IMPORTANT (v0.10.0)
`createHostedServer` no longer inlines the nav/feedback HTML. It injects ONE shared
script — `<script src="/nodes/chrome.js" defer>` — served from the static front door
(the `nodes` repo). That script renders the Builder/Tracker nav + the feedback & chat
bubbles identically on every surface (front door, hosted Nodes, and — matched in style —
the React tracker). **To change the menu or bubbles, edit `nodes/chrome.js` and
`git -C /var/www/nodes pull` on the box — no Node or runtime redeploy needed.** Only the
Node-specific "run it locally" footer is still emitted by the runtime.

## Exports (`src/index.js`)
- **`createLiteHost({ appSlug, nodeVersion, newsroom })`** (`host-lite.js`) — local host: JSON files on disk, the user's own AI key. Plus a sticky `host.meta.host_id`.
- **`host.meta.org`** (v0.18.0) — `{ id, name, country, kind }`: the ORGANISATION the signed-in user belongs to, looked up from `newsrooms` via the JWT's `newsroom_id` (cached per process) and `null` when the session carries none. Locally it mirrors the install's own `newsroom` + `NEWSROOM_COUNTRY`, so a Node needs no branch. **Use this — not `meta.newsroom`, not `ctx.newsroomId` — when writing a record ABOUT a newsroom** (its name, its country). The other two are the individual USER: see the tenancy note below.
  - **TENANCY, and why it is not the newsroom.** `createHostedServer` scopes all storage by **user id**, so two journalists at one newsroom are two tenants and cannot see each other's work. The JWT does carry `newsroom_id` — a stale comment long claimed otherwise — so scoping by newsroom is now possible, but every row every hosted Node has written is keyed by user id and rekeying without a migration would orphan a live newsroom's history. Changing it is a data decision. `meta.org` closes the reporting half of the gap without touching storage.
- **`createServer({ slug, host, handlers, displayName, nodeVersion })`** (`server.js`) — LOCAL Express boot. Maps standard handler names → routes (`getSetupStatus`→`/api/setup`, `postSetup`, `listSources`→`/api/sources`, `getReport`, `getQuality`, `getActivity`, `postBrief`, `postIngest`→`/api/ingest`). Returns the app, so a Node can add custom routes after (node-podcasting does: `/api/voices`, `/api/podcasts`, …).
- **`createHostedServer({ slug, handlers, ensureSchema, mountRoutes, productName, staticDir, repo, nodeVersion })`** (`server-hosted.js`) — ONLINE (multi-tenant) boot. Verifies the tracker's JWT cookie (name-agnostic — accepts whichever cookie verifies with `JWT_SECRET`; default `tracker_token`), builds a per-request Postgres host scoped to the signed-in newsroom, mounts the SAME standard route map, and injects the Grounded nav + sign-out + "run it locally" footer + feedback widget into the Node's dashboard HTML.
  - `ensureSchema(pool, slug)` — optional; create your `node_<slug>_*` tables (the **node-analytics** pattern).
  - `mountRoutes(app, { hostFor, readUser })` — optional; attach custom routes. `hostFor(req)` returns a per-request, newsroom-scoped host (the **node-verifier** pattern, for its `/api/listener/*` routes).
- **`host.store`** — per-newsroom key/value, identical API local + hosted: `list(collection)` / `get(collection,key)` / `put(collection,key,value)` / `delete(collection,key)`. Locally backed by JSON files; online by a `node_<slug>_store(newsroom_id,collection,key,value jsonb,…)` table. This is what lets a file-based Node go multi-tenant without writing SQL.
- **`host.corpus`** (v0.16.0) — the corpus write-back: everything a Node gathers lands in one of the SIX shared corpora (`CORPUS_COLLECTIONS`) wearing the standard record shape (`source_url · date · jurisdiction · language · licence · verification_status · outcome`). API: `add(record)` (validated + deduped on source_url, else title+date; returns `{id, inserted}` so counts stay honest) / `get(id)` / `list(filters)` / `verify(id, verifiedBy)` (named person REQUIRED — `human_verified` is a person's signature) / `setOutcome(id, outcome)`. Locally a JSON file; hosted the SHARED unprefixed `grounded_corpus_records` table (canonical DDL = tracker migrations `171_corpus_records.sql` + `172_corpus_usage.sql`; `ensureCorpusSchema` carries identical copies — keep in sync). Hosted READ ops (`get`/`list`) self-log to `corpus_usage` (surface `host_corpus`) — the per-corpus query counts the Foundation reports to funders; writes are evidenced by the records themselves. Exports: `CORPUS_COLLECTIONS`, `validateCorpusRecord`, `ensureCorpusSchema`, `createCorpusApi` (`corpus.js`).
- **`createPgHost` / `ensureActivitySchema` / `ensureStoreSchema` / `ensureProfileSchema`** (`host-pg.js`) — the multi-tenant Postgres host + the generic `node_<slug>_activity` and `node_<slug>_store` tables (both auto-created by `createHostedServer`). A Node's *own* relational tables come from the `ensureSchema` it passes.
- **`createMcpServer({ slug, productName, nodeVersion, host, handlers, tools, transport? })`** + **`redirectConsoleForStdio`** (`server-mcp.js`) — the MCP boot: projects a Node's curated `lib/mcp-tools.js` manifest as MCP tools over the SAME `(host, args)` handler contract. Default transport stdio (Claude Desktop). Call `redirectConsoleForStdio()` BEFORE creating the host — stdout is the JSON-RPC channel and the lite host logs to it. Blueprint: `grounded2026/docs/MCP_BLUEPRINT.md`; reference Node: `node-verifier` (`mcp-server.js` + `lib/mcp-tools.js` + `MCP.md`).
- `mountChrome`, `readRuntimeVersion` (`chrome.js`); `telemetry.js` (collector POST when `GROUNDED_TELEMETRY_URL` set).

## Deps
Regular: express, multer, mammoth, @anthropic-ai/sdk, openai, dotenv (used by local + hosted).
**optionalDependencies**: pg, cookie-parser, jsonwebtoken (used ONLY by `createHostedServer`) + @modelcontextprotocol/sdk (used ONLY by `createMcpServer`) — all **lazy-imported**, so nothing loads them unless that boot mode runs.

## Versioning — IMPORTANT
Nodes consume this via `github:pauldevelopai/grounded-node-runtime#vX.Y.Z`. When you change the runtime: bump `package.json` version, commit, **and move the matching git tag** (`git tag -f vX.Y.Z && git push -f origin vX.Y.Z`), then bump the tag in each Node's `package.json`.
**npm caches github deps** — after pointing a Node at a new tag, a plain `npm install` may serve the stale copy. Force it: `rm -rf node_modules/@developai && npm install`.

## What does NOT belong here
Node-specific app logic (matrix parsing, voice cloning, dashboards) lives in each `node-<slug>` repo, not here. This repo is only the shared plumbing. Changing it affects EVERY Node's local install — test before tagging.

See the tracker repo's `CLAUDE.md` for the full system map + the box/Caddy topology.
