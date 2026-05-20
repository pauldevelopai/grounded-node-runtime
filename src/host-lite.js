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
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import mammoth from "mammoth";

const DEFAULT_DATA_DIR = "data/processed";
const STANDALONE_NEWSROOM_ID = "local";

const readJson  = (file, fb) => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fb;
const writeJson = (file, d)  => {
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(d, null, 1));
};

export function createLiteHost({ appSlug, dataDir = DEFAULT_DATA_DIR } = {}) {
  if (!appSlug) throw new Error("createLiteHost: appSlug is required");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const prefix = `node_${appSlug.replace(/-/g, "_")}_`;
  const ctx = Object.freeze({
    newsroomId: STANDALONE_NEWSROOM_ID,
    userId: STANDALONE_NEWSROOM_ID,
    role: "owner"
  });

  const tableFile = name => join(dataDir, `${name}.json`);

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
    const msg = await client.messages.create({
      model,
      max_tokens: opts.maxTokens || 1000,
      ...(opts.system ? { system: opts.system } : {}),
      messages
    });
    const text = msg.content
      .filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    return { text, provider, model, usedFallback: false };
  }

  return {
    ctx,
    tablePrefix: prefix,

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
      run:  async meta => appendActivity({ kind: "run",  ...meta }),
      edit: async meta => appendActivity({ kind: "edit", ...meta })
    }
  };

  function appendActivity(entry) {
    const file = tableFile(`${prefix}activity`);
    const log = readJson(file, []);
    log.push({
      ts: new Date().toISOString(),
      newsroom_id: ctx.newsroomId,
      ...entry
    });
    writeJson(file, log);
    // Also echo to terminal so the newsroom dev can watch live.
    console.log(`[${entry.kind || "log"}]`, JSON.stringify(entry));
  }
}
