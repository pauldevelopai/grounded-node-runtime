/**
 * @developai/grounded-node-runtime / src/host-pg.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic multi-tenant Postgres host — the hosted counterpart to the lite host.
 *
 * Same host interface a Node's handlers already target (db / ai / parse / log /
 * feedback / meta / tablePrefix), but storage is Postgres with every query
 * scoped to a per-request newsroom_id, and AI uses the server's shared key.
 *
 * A Node's application code is UNCHANGED between local and hosted — it never
 * knows which host is underneath. The SQL its handlers write is real Postgres
 * SQL ($1 = newsroom_id auto-bound, $2..$N = the caller's params).
 *
 * The `activity` log table is generic (every Node logs runs/errors/feedback) and
 * created by ensureActivitySchema(). A Node's own data tables are created by the
 * ensureSchema it passes to createHostedServer().
 */

import Anthropic from "@anthropic-ai/sdk";
import mammoth from "mammoth";

const prefixFor = (slug) => `node_${String(slug).replace(/-/g, "_")}_`;

// Columns the activity log may carry. log.run()/appendActivity fills whichever
// are present on a given entry.
const ACTIVITY_COLS = [
  "ts", "kind", "op", "source", "success", "provider", "model", "used_fallback",
  "duration_ms", "story_count", "errors", "warnings", "uncategorised",
  "prompt", "response", "error"
];

/** Create the generic per-Node activity table. Call once at boot. */
export async function ensureActivitySchema(pool, slug) {
  const T = prefixFor(slug);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${T}activity (
      n             bigserial PRIMARY KEY,
      newsroom_id   text NOT NULL,
      ts            text,
      kind          text,
      op            text,
      source        text,
      success       boolean,
      provider      text,
      model         text,
      used_fallback boolean,
      duration_ms   integer,
      story_count   integer,
      errors        integer,
      warnings      integer,
      uncategorised integer,
      prompt        text,
      response      text,
      error         text
    );
    CREATE INDEX IF NOT EXISTS ${T}activity_nr ON ${T}activity (newsroom_id, n);
  `);
}

/**
 * Build a per-request host scoped to one newsroom.
 * @param {object} o
 * @param {import('pg').Pool} o.pool
 * @param {string} o.slug
 * @param {string} o.newsroomId   tenant key ($1 on every query)
 * @param {string=} o.newsroom    display name
 * @param {string=} o.nodeVersion
 */
export function createPgHost({ pool, slug, newsroomId, newsroom, nodeVersion } = {}) {
  if (!pool) throw new Error("createPgHost: pool is required");
  if (!slug) throw new Error("createPgHost: slug is required");
  if (!newsroomId) throw new Error("createPgHost: newsroomId is required");

  const PREFIX = prefixFor(slug);
  const ctx = Object.freeze({ newsroomId, userId: newsroomId, role: "owner" });

  // db.query(table, sql, userParams) — real Postgres, $1 = newsroom_id auto-bound.
  const runQuery = async (client, _table, sql, userParams = []) => {
    const res = await client.query(sql, [newsroomId, ...userParams]);
    return { rows: res.rows, rowCount: res.rowCount };
  };
  const db = {
    query: (table, sql, params) => runQuery(pool, table, sql, params),
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({ query: (t, s, p) => runQuery(client, t, s, p) });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }
  };

  // AI: single shared server key, cheap model. Same return shape as the lite host.
  let anthropic = null;
  const client = () => {
    if (!anthropic) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error("Server AI key (ANTHROPIC_API_KEY) is not configured.");
      }
      anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return anthropic;
  };
  async function chat(input, opts = {}) {
    const model = opts.model || process.env.MODEL || "claude-haiku-4-5";
    const messages = typeof input === "string" ? [{ role: "user", content: input }] : input;
    const msg = await client().messages.create({
      model,
      max_tokens: opts.maxTokens || 1000,
      ...(opts.system ? { system: opts.system } : {}),
      messages
    });
    const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    return { text, provider: "anthropic", model, usedFallback: false };
  }

  async function appendActivity(entry) {
    const e = { ts: new Date().toISOString(), ...entry };
    const cols = ACTIVITY_COLS.filter(c => e[c] !== undefined && e[c] !== null);
    const placeholders = cols.map((_, i) => `$${i + 2}`); // $1 = newsroom_id
    try {
      await pool.query(
        `INSERT INTO ${PREFIX}activity (newsroom_id${cols.length ? "," + cols.join(",") : ""})
         VALUES ($1${placeholders.length ? "," + placeholders.join(",") : ""})`,
        [newsroomId, ...cols.map(c => e[c])]
      );
    } catch (err) {
      console.error("[activity] insert failed:", err.message);
    }
  }

  const meta = {
    slug,
    newsroom: newsroom || null,
    node_version: nodeVersion || "unknown",
    runtime_version: "hosted",
    host_id: null
  };

  return {
    ctx,
    tablePrefix: PREFIX,
    meta,
    db,
    ai: { chat },
    parse: { docxToHtml: async (buffer) => (await mammoth.convertToHtml({ buffer })).value },
    log: {
      run: (m) => appendActivity({ kind: "run", ...m }),
      edit: (m) => appendActivity({ kind: "edit", ...m }),
      error: ({ op, error }) => appendActivity({
        kind: "error", op: op || "unknown", success: false,
        error: error?.message || String(error || "(no message)")
      })
    },
    feedback: {
      submit: async ({ type, message }) => {
        const msg = String(message || "").slice(0, 4000).trim();
        if (!msg) throw new Error("Empty feedback message");
        await appendActivity({ kind: "feedback", op: "feedback", response: `[${type || "other"}] ${msg}` });
        return { file: null, entry: { type, message: msg } };
      }
    }
  };
}
