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
import { createLiteHost, createServer } from "@developai/grounded-node-runtime";
import * as handlers from "./lib/handlers.js";

createServer({
  slug: "my-node",
  host: createLiteHost({ appSlug: "my-node" }),
  handlers,
  displayName: "My Node"
});
```

The runtime auto-mounts a handler at its standard route if the matching
function is exported:

| Export | Route | Method |
|---|---|---|
| `listSources` | `/api/sources` | GET |
| `getReport`   | `/api/report`  | GET |
| `getQuality`  | `/api/quality` | GET |
| `postBrief`   | `/api/brief`   | POST |
| `postIngest`  | `/api/ingest`  | POST (multipart, field `file`) |

A Node that doesn't accept uploads simply doesn't export `postIngest` — that
route stays unmounted.

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
