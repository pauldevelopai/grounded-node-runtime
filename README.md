# @developai/grounded-node-runtime

Shared scaffolding for **GROUNDED Nodes** — newsroom-owned apps that sit on
GROUNDED's shared codebase / database / AI / auth and run in two forms with
identical application code:

| Form | When | What this package provides |
|---|---|---|
| **Standalone** | Newsroom dev on a laptop, from a forked Node repo | `createLiteHost` (JSON-file storage + direct Anthropic SDK) + `createServer` (Express boot) |
| **Integrated** | The Node has graduated into the GROUNDED monorepo | *Nothing* — GROUNDED's own host facade and Next.js routing take over. The Node's `analytics.js` / `handlers.js` / `ingest.js` lift unchanged. |

## What a Node looks like

```
my-node/
├── package.json              depends on @developai/grounded-node-runtime
├── index.js                  3 lines — see "Wiring a Node" below
├── lib/
│   ├── analytics.js          pure logic — UNCHANGED on graduation
│   ├── handlers.js           framework-free handlers — UNCHANGED on graduation
│   └── ingest.js             matrix → rows via host.parse + host.db
├── public/                   dashboard (Node-specific)
├── data/                     newsroom data (committed; shared with upstream)
└── tests/                    node:test
```

## Wiring a Node

```js
// index.js — the entire boot
import "dotenv/config";
import { createLiteHost, createServer } from "@developai/grounded-node-runtime";
import * as handlers from "./lib/handlers.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));

const SLUG = "my-node";

createServer({
  slug: SLUG,
  host: createLiteHost({
    appSlug: SLUG,
    nodeVersion: pkg.version,
    newsroom: process.env.NEWSROOM || "My Newsroom",
  }),
  handlers,
  displayName: "My Node",
  nodeVersion: pkg.version,
});
```

A few details about that boot:

- `nodeVersion` is read from the Node's own `package.json` and threaded
  into both `createLiteHost` (so the boot beacon records it) and
  `createServer` (so the GROUNDED chrome at `/api/grounded/meta`
  displays it). Same value in both places.
- `newsroom` falls back to `process.env.NEWSROOM` so each newsroom can
  set their own name in their local `.env` without forking a per-newsroom
  copy of `index.js`. The default string is a sensible last resort.
- `"dotenv/config"` is imported at the top so `process.env` is populated
  from `.env` before any of the boot reads it.

The runtime auto-mounts a handler at its standard route if the matching
function is exported:

| Export | Route | Method |
|---|---|---|
| `getSetupStatus` | `/api/setup` | GET — current API-key state |
| `postSetup`      | `/api/setup` | POST — save chosen provider + key (Node-implemented) |
| `listSources`    | `/api/sources` | GET |
| `getReport`      | `/api/report`  | GET |
| `getQuality`     | `/api/quality` | GET |
| `getActivity`    | `/api/activity` | GET |
| `postBrief`      | `/api/brief`   | POST |
| `postIngest`     | `/api/ingest`  | POST (multipart, field `file`) |

A Node that doesn't accept uploads simply doesn't export `postIngest` — that
route stays unmounted. The `getSetupStatus` / `postSetup` pair is the
in-app API-key flow: the Node writes to `.env` itself (the runtime
doesn't ship a setup interface). See `node-makanday-analytics/lib/handlers.js`
or `node-capitalfm-verifier/lib/handlers.js` for the canonical
implementation.

The runtime also auto-mounts three GROUNDED chrome routes that every
Node gets for free: `/grounded-chrome.css`, `/grounded-chrome.js`, and
`/api/grounded/meta`. See the next section.

## Family chrome (subtle GROUNDED branding)

Every Node is part of the GROUNDED family. The runtime ships a small
chrome — a thin terracotta top bar with the GROUNDED wordmark +
newsroom name, plus a footer line with the Node name, Node version,
runtime version, and newsroom. Subtle by design: the Node's own
branding stays primary, GROUNDED is the family signature.

Nodes opt in by adding two lines to `public/index.html`:

```html
<link rel="stylesheet" href="/grounded-chrome.css" />
<script src="/grounded-chrome.js" defer></script>
```

The chrome reads `/api/grounded/meta` (auto-mounted) to populate
version + newsroom info. That endpoint's contents come from the
`nodeVersion` and `newsroom` you pass to `createLiteHost` and the
`nodeVersion` you pass to `createServer` — see the boot block in
"Wiring a Node" above. The chrome assets are served straight from
the runtime, so any future visual change (recolour, layout, copy)
ships to every Node automatically on next `npm install`.

## Telemetry — the boot beacon, activity log, and error log

On every boot, `createLiteHost` writes a meta file capturing install
identity and version state:

```
data/processed/node_<slug>_meta.json
{
  "slug": "my-node",
  "host_id": "<sticky UUID — generated once per install>",
  "node_version": "0.2.0",
  "runtime_version": "0.5.0",
  "newsroom": "Capital FM",
  "platform": "darwin arm64 node v20.10.0",
  "first_boot": "2026-05-20T11:00:00.000Z",
  "last_boot": "2026-05-20T14:32:11.000Z",
  "boot_count": 17
}
```

Three log surfaces are committed to the newsroom's fork alongside the
activity log. Together they feed the cohort dashboard in `groundedai/`:

| File | Written by | Purpose |
|---|---|---|
| `node_<slug>_meta.json` | runtime, every boot | install identity + version + activity heartbeat |
| `node_<slug>_activity.json` | `host.log.run/edit` | append-only feed of every action |
| `node_<slug>_errors.json` | `host.log.error` | structured errors with sanitised context |

`host.log.error({ op, error, context })` aggressively sanitises the
`context` field — never log claim text, post text, image data, API
keys, or anything user-identifying. The sanitiser drops any key
matching `text|content|body|claim|post|image|key|token|password|secret|email`
and caps strings at 200 characters. Pass small structured metadata
(operation name, file size, parse step) — not raw payloads.

## The host interface (the contract)

Application code targets this interface. The runtime's `createLiteHost` is one
implementation; the GROUNDED monorepo's `lib/nodes/host` is the other. Same
shape, same semantics. Convention: SQL uses `$1 = newsroom_id` (auto-bound by
the host), `$2..$N` = user params.

| Surface | What |
|---|---|
| `host.ctx` | `{ newsroomId, userId, role }` — read-only |
| `host.tablePrefix` | e.g. `node_my_node_` — every query must stay inside it |
| `host.db.query(table, sql, params)` | Scoped query/insert/delete |
| `host.db.tx(fn)` | Transaction (best-effort in standalone) |
| `host.ai.chat(input, opts)` | Claude call. **No model parameter** — locked to Haiku in integrated mode. |
| `host.parse.docxToHtml(buffer)` | Word `.docx` → HTML for table extraction |
| `host.log.run(meta)` / `host.log.edit(meta)` | Telemetry (console in standalone, Observatory integrated) |
| `host.log.error({ op, error, context })` | Structured error log with sanitised context — feeds the cohort dashboard |
| `host.meta` | Sticky install identity (host_id, versions, boot_count) — read-only |

## Graduation into GROUNDED

When a Node is ready to fold into the GROUNDED monorepo:

1. Copy `lib/*.js` (excluding any host-lite imports) into
   `lib/nodes/<slug>/` in the monorepo.
2. Replace the runtime import with `@/lib/nodes/host`.
3. Write a Postgres migration mirroring the JSON shape this Node used.
4. Add thin Next.js route handlers under `app/nodes/<slug>/api/`.
5. Drop the `@developai/grounded-node-runtime` dependency.

No application code changes. The interface is the same; only the
implementation underneath swaps.

## License

Apache-2.0. Develop AI · 2026.
