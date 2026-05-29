/**
 * @developai/grounded-node-runtime / src/host-lite.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Standalone (laptop-friendly) implementation of the GROUNDED host interface.
 *
 * A Node ships in two forms with IDENTICAL application code:
 *
 *   1. STANDALONE — newsroom runs the Node on a laptop from their forked repo.
 *      Storage = JSON files. AI = direct Anthropic SDK (their own key).
 *      No Postgres, no Docker.
 *
 *   2. INTEGRATED — same code lifted into lib/nodes/<slug>/ in the GROUNDED
 *      monorepo. Storage = scoped Postgres. AI = Haiku-only wrapper + Ollama
 *      fallback. Auth = real session-bound newsroom_id.
 *
 * Application code (analytics, ingest, handlers) targets the host *interface*
 * and never knows which implementation is underneath. Graduation = swap this
 * file for the GROUNDED facade, lift everything else verbatim.
 *
 * Interface convention (same as the GROUNDED facade):
 *   host.db.query(table, sql, params)
 *     - SQL uses $1 = newsroom_id (auto-bound), $2..$N = user params
 *     - Caller passes only user params; newsroom_id binding is the host's job
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import mammoth from "mammoth";
import { readRuntimeVersion } from "./chrome.js";
import { postTelemetry } from "./telemetry.js";
import { harvestCitations } from "./host-pg.js";

const DEFAULT_DATA_DIR = "data/processed";
const STANDALONE_NEWSROOM_ID = "local";

const readJson  = (file, fb) => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fb;
const writeJson = (file, d)  => {
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(d, null, 1));
};

export function createLiteHost({ appSlug, dataDir = DEFAULT_DATA_DIR, nodeVersion, newsroom } = {}) {
  if (!appSlug) throw new Error("createLiteHost: appSlug is required");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const prefix = `node_${appSlug.replace(/-/g, "_")}_`;
  const ctx = Object.freeze({
    newsroomId: STANDALONE_NEWSROOM_ID,
    userId: STANDALONE_NEWSROOM_ID,
    role: "owner"
  });

  const tableFile = name => join(dataDir, `${name}.json`);
  const runtimeVersion = readRuntimeVersion();

  // ── Boot beacon: sticky install identity + version + activity heartbeat.
  // Committed to the newsroom's fork like the activity log; the cohort
  // harvest reads it to populate the install matrix on the GROUNDED
  // dashboard. Schema is flat and forward-compatible.
  const metaFile = tableFile(`${prefix}meta`);
  const prevMeta = readJson(metaFile, null);
  const meta = {
    slug: appSlug,
    host_id: prevMeta?.host_id || randomUUID(),
    node_version: nodeVersion || prevMeta?.node_version || "unknown",
    runtime_version: runtimeVersion,
    newsroom: newsroom || prevMeta?.newsroom || null,
    platform: prevMeta?.platform || `${os.platform()} ${os.arch()} node ${process.version}`,
    first_boot: prevMeta?.first_boot || new Date().toISOString(),
    last_boot: new Date().toISOString(),
    boot_count: (prevMeta?.boot_count || 0) + 1
  };
  writeJson(metaFile, meta);

  // Best-effort: tell the collector this install booted (no-op unless
  // GROUNDED_TELEMETRY_URL is set). Fire-and-forget — never blocks boot.
  postTelemetry("install", {
    host_id: meta.host_id,
    slug: meta.slug,
    newsroom: meta.newsroom,
    node_version: meta.node_version,
    runtime_version: meta.runtime_version,
    platform: meta.platform,
    first_boot: meta.first_boot,
    last_seen: meta.last_boot,
    boot_count: meta.boot_count,
  });

  function assertOwned(table) {
    if (!table.startsWith(prefix)) {
      throw new Error(`host-lite: table "${table}" outside Node namespace "${prefix}*"`);
    }
  }

  // Tiny JSON-file "table" engine. Recognises only the SQL shapes a Node's
  // handlers will actually use — no general SQL parsing. Replaced wholesale
  // by real Postgres on graduation.
  async function query(table, sql, userParams = []) {
    assertOwned(table);
    // Mirror facade: prepend newsroom_id so $1=newsroom_id, $2..=user.
    const p = [ctx.newsroomId, ...userParams];
    const s = sql.replace(/\s+/g, " ").trim().toLowerCase();
    const rows = readJson(tableFile(table), []);

    if (s.startsWith("delete")) {
      // DELETE … WHERE newsroom_id = $1 AND source_label = $2
      const kept = rows.filter(r => !(r.newsroom_id === p[0] && r.source_label === p[1]));
      writeJson(tableFile(table), kept);
      return { rows: [], rowCount: rows.length - kept.length };
    }

    if (s.startsWith("insert")) {
      // INSERT INTO … (col1, col2, …) VALUES ($1, $2, …)
      const cols = sql.match(/\(([^)]+)\)\s+VALUES/i)[1].split(",").map(c => c.trim());
      const row = {};
      cols.forEach((c, i) => {
        let v = p[i];
        if (c === "issues" && typeof v === "string") {
          try { v = JSON.parse(v); } catch { /* keep raw */ }
        }
        row[c] = v;
      });
      row.id = rows.length + 1;
      row.ingested_at = new Date().toISOString();
      rows.push(row);
      writeJson(tableFile(table), rows);
      return { rows: [], rowCount: 1 };
    }

    if (s.startsWith("select")) {
      // Always require newsroom_id match (mirrors db_read posture).
      let result = rows.filter(r => r.newsroom_id === p[0]);

      // Optional source_label filter at $2
      if (/source_label\s*=\s*\$2/i.test(sql) && p[1] !== undefined) {
        result = result.filter(r => r.source_label === p[1]);
      }

      if (/group by source_label/i.test(sql)) {
        const g = {};
        for (const r of result) g[r.source_label] = (g[r.source_label] || 0) + 1;
        return {
          rows: Object.entries(g)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([source_label, n]) => ({ source_label, n }))
        };
      }

      if (/order by ingested_at desc limit 1/i.test(sql)) {
        result = [...result]
          .sort((a, b) => (b.ingested_at || "").localeCompare(a.ingested_at || ""))
          .slice(0, 1);
      } else if (/order by n\b/i.test(sql)) {
        result = [...result].sort((a, b) => (a.n || 0) - (b.n || 0));
      }
      return { rows: result };
    }
    return { rows: [] };
  }

  // ── AI: provider-flexible. Auto-detects which provider to use based on
  //    whichever API key is in the environment. Override explicitly with
  //    AI_PROVIDER=anthropic|openai. Model defaults are deliberately cheap;
  //    override per-call via opts.model or globally via MODEL env var.
  //    OPENAI_BASE_URL points the OpenAI SDK at OpenRouter/Groq/Ollama if you
  //    want a third path.
  function inferProvider() {
    const explicit = (process.env.AI_PROVIDER || "").toLowerCase().trim();
    if (explicit === "anthropic" || explicit === "openai") return explicit;
    if (process.env.ANTHROPIC_API_KEY) return "anthropic";
    if (process.env.OPENAI_API_KEY) return "openai";
    return "anthropic";
  }
  function defaultModel(provider) {
    if (process.env.MODEL) return process.env.MODEL;
    return provider === "openai" ? "gpt-5.4-mini" : "claude-haiku-4-5";
  }
  let anthropicClient = null, openaiClient = null;
  function getAnthropic() {
    if (!anthropicClient) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error(
          "AI_PROVIDER is 'anthropic' but ANTHROPIC_API_KEY is not set — " +
          "check your .env file (or set AI_PROVIDER=openai if that's the key you have)"
        );
      }
      anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return anthropicClient;
  }
  function getOpenAI() {
    if (!openaiClient) {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error(
          "AI_PROVIDER is 'openai' but OPENAI_API_KEY is not set — " +
          "check your .env file (or set AI_PROVIDER=anthropic if that's the key you have)"
        );
      }
      openaiClient = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {})
      });
    }
    return openaiClient;
  }

  async function chat(input, opts = {}) {
    const provider = inferProvider();
    const model = opts.model || defaultModel(provider);
    const messages = typeof input === "string"
      ? [{ role: "user", content: input }] : input;

    if (provider === "openai") {
      const client = getOpenAI();
      const messagesForOpenAI = opts.system
        ? [{ role: "system", content: opts.system }, ...messages]
        : messages;
      const r = await client.chat.completions.create({
        model,
        max_completion_tokens: opts.maxTokens || 1000,
        messages: messagesForOpenAI
      });
      const text = (r.choices[0]?.message?.content || "").trim();
      return { text, provider, model, usedFallback: false };
    }

    const client = getAnthropic();
    // opts.webSearch (true | { maxUses }) enables Claude's server-side web
    // search tool (Anthropic provider only). OpenAI requests ignore it.
    const params = {
      model,
      max_tokens: opts.maxTokens || 1000,
      ...(opts.system ? { system: opts.system } : {}),
      messages
    };
    if (opts.webSearch) {
      const maxUses = (typeof opts.webSearch === "object" && opts.webSearch.maxUses) || 5;
      params.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses }];
    }
    const msg = await client.messages.create(params);
    const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    const citations = harvestCitations(msg.content);
    return { text, provider, model, usedFallback: false, citations };
  }

  // ── Generic per-Node key/value store. Collections of JSON values, keyed by
  // string. The hosted pg host implements the SAME interface against Postgres,
  // so a Node's handlers use host.store identically locally and online. Files
  // live under data/processed/<prefix>store__<collection>.json.
  const storeFile = (collection) =>
    tableFile(`${prefix}store__${String(collection).replace(/[^a-z0-9_-]/gi, "_")}`);
  const store = {
    list: async (collection) =>
      Object.entries(readJson(storeFile(collection), {})).map(([key, value]) => ({ key, value })),
    get: async (collection, key) => {
      const obj = readJson(storeFile(collection), {});
      return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null;
    },
    put: async (collection, key, value) => {
      const f = storeFile(collection);
      const obj = readJson(f, {});
      obj[String(key)] = value;
      writeJson(f, obj);
    },
    delete: async (collection, key) => {
      const f = storeFile(collection);
      const obj = readJson(f, {});
      if (Object.prototype.hasOwnProperty.call(obj, String(key))) { delete obj[String(key)]; writeJson(f, obj); }
    },
  };

  return {
    ctx,
    tablePrefix: prefix,
    meta,  // sticky install identity — server reads this for /api/grounded/meta
    store,

    db: {
      query,
      tx: async fn => fn({ query })
    },

    ai: { chat },

    parse: {
      docxToHtml: async buffer => (await mammoth.convertToHtml({ buffer })).value
    },

    log: {
      // Append-only activity log. Lands in data/processed/<prefix>activity.json
      // so it's committed to the newsroom's fork along with their other data
      // (per the "data is shared for training" decision). Schema is flat and
      // forward-compatible — new fields can be added without breaking the
      // harvest script.
      run:  async metaArg => appendActivity({ kind: "run",  ...metaArg }),
      edit: async metaArg => appendActivity({ kind: "edit", ...metaArg }),

      // Structured error log. Separate file so dashboard can show
      // problems independently from successful activity. Aggressive
      // sanitisation: callers should pass operation name + error
      // message + small structured context, NEVER claim text, post
      // text, image data, API keys, or user-identifying content.
      error: async ({ op, error, context }) => appendError({
        op: op || "unknown",
        message: error?.message || String(error || "(no message)"),
        name: error?.name || null,
        stack_first_line: error?.stack ? String(error.stack).split("\n")[1]?.trim() || null : null,
        context: sanitiseContext(context)
      })
    },

    // ── Feedback — the only host channel that intentionally carries
    // user-typed free-text content. The frontend shows an upfront
    // privacy notice; this writer just persists what arrives. The
    // server wraps this with the git-sync step.
    feedback: {
      submit: async ({ type, message, page }) => {
        const cleanType = ["bug", "suggestion", "praise", "question"].includes(type) ? type : "other";
        const cleanMessage = String(message || "").slice(0, 4000).trim();
        if (!cleanMessage) throw new Error("Empty feedback message");
        const file = tableFile(`${prefix}feedback`);
        const log = readJson(file, []);
        const entry = {
          ts: new Date().toISOString(),
          newsroom_id: ctx.newsroomId,
          host_id: meta.host_id,
          node_version: meta.node_version,
          runtime_version: meta.runtime_version,
          newsroom: meta.newsroom,
          type: cleanType,
          message: cleanMessage,
          page: String(page || "").slice(0, 200) || null,
        };
        log.push(entry);
        writeJson(file, log);
        return { file, entry };
      }
    }
  };

  function sanitiseContext(ctx) {
    if (!ctx || typeof ctx !== "object") return null;
    // Allow only short scalar values. Strings cap at 200 chars. No
    // nested objects, no arrays of objects, no keys named like
    // they carry sensitive content.
    const blocked = /text|content|body|claim|post|image|key|token|password|secret|email/i;
    const out = {};
    for (const [k, v] of Object.entries(ctx)) {
      if (blocked.test(k)) continue;
      if (v == null) { out[k] = null; continue; }
      if (typeof v === "boolean" || typeof v === "number") { out[k] = v; continue; }
      if (typeof v === "string") { out[k] = v.length > 200 ? v.slice(0, 200) + "…" : v; continue; }
      // skip anything else (objects, arrays, functions)
    }
    return out;
  }

  function appendError(entry) {
    const file = tableFile(`${prefix}errors`);
    const log = readJson(file, []);
    const row = {
      ts: new Date().toISOString(),
      newsroom_id: ctx.newsroomId,
      host_id: meta.host_id,
      node_version: meta.node_version,
      ...entry
    };
    log.push(row);
    writeJson(file, log);
    console.error(`[error]`, JSON.stringify(entry));
    postTelemetry("event", {
      host_id: meta.host_id, slug: meta.slug, ts: row.ts,
      kind: "error", op: row.op || "", details: detailsJson(row),
    });
  }

  function appendActivity(entry) {
    const file = tableFile(`${prefix}activity`);
    const log = readJson(file, []);
    const row = {
      ts: new Date().toISOString(),
      newsroom_id: ctx.newsroomId,
      host_id: meta.host_id,
      node_version: meta.node_version,
      ...entry
    };
    log.push(row);
    writeJson(file, log);
    // Also echo to terminal so the newsroom dev can watch live.
    console.log(`[${entry.kind || "log"}]`, JSON.stringify(entry));
    postTelemetry("event", {
      host_id: meta.host_id, slug: meta.slug, ts: row.ts,
      kind: row.kind || "run", op: row.op || "", details: detailsJson(row),
    });
  }

  // Strip the envelope fields and serialise the rest (op-specific counts,
  // durations, error message/name/context) for the collector's `details` column.
  function detailsJson(row) {
    const { ts, newsroom_id, host_id, node_version, kind, op, ...rest } = row;
    try { const j = JSON.stringify(rest); return j === "{}" ? "" : j; }
    catch { return ""; }
  }
}
