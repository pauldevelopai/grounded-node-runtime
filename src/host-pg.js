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
import OpenAI from "openai";
import mammoth from "mammoth";
import { createCorpusApi } from "./corpus.js";

const prefixFor = (slug) => `node_${String(slug).replace(/-/g, "_")}_`;

// Pull {url,title} from a web-search response: the model's inline text citations
// first (what it actually cited), then the raw web_search_tool_result hits as a
// fallback so a Node always gets a non-empty source list. Deduped by URL, capped.
export function harvestCitations(content) {
  const out = [], seen = new Set();
  const add = (url, title) => {
    url = (url || "").trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, title: title || url });
  };
  for (const b of (content || [])) {
    if (b.type === "text" && Array.isArray(b.citations)) for (const c of b.citations) add(c.url, c.title);
  }
  for (const b of (content || [])) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) if (r && r.type === "web_search_result") add(r.url, r.title);
    }
  }
  return out.slice(0, 12);
}

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

/** Create the generic per-Node key/value store table. Call once at boot. */
export async function ensureStoreSchema(pool, slug) {
  const T = prefixFor(slug);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${T}store (
      newsroom_id text NOT NULL,
      collection  text NOT NULL,
      key         text NOT NULL,
      value       jsonb,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (newsroom_id, collection, key)
    );
  `);
}

/**
 * Create the SHARED cross-node newsroom profile table. NOT prefixed with the
 * node slug — every Node reads/writes the same row per newsroom, so data a
 * newsroom gives one Node (e.g. Audience Signal's geography/audience) is
 * available to every other Node via host.profile. Call once at boot.
 */
export async function ensureProfileSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grounded_newsroom_profile (
      newsroom_id text PRIMARY KEY,
      data        jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
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

  // ── AI: WHOSE KEY? ────────────────────────────────────────────────────────
  //
  // A hosted Node runs on our server, but not necessarily on our bill. The
  // tracker decides per Node (node_billing_policy) and per newsroom
  // (newsroom_llm_keys):
  //
  //   payer 'newsroom' → the newsroom's own Anthropic or OpenAI key, their bill.
  //                      No key on file means an actionable refusal, NOT a quiet
  //                      fallback to ours.
  //   payer 'system'   → Develop AI's key, after the `nodes` budget is checked.
  //
  // The tracker is asked rather than the database read directly, because the
  // newsroom's key is encrypted with a per-tenant HKDF key. Reimplementing that
  // crypto here would mean keeping two copies byte-compatible forever, with a
  // credential at the end of it.
  //
  // Local (downloaded) Nodes never come through here — host-lite.js reads the
  // newsroom's own .env, which is already BYO by construction.

  const TRACKER = process.env.TRACKER_INTERNAL_URL || "http://127.0.0.1:3001";
  const INTERNAL_SECRET = process.env.INTERNAL_NODE_SECRET || "";

  // Resolved credentials are cached briefly so a chatty Node doesn't ask the
  // tracker on every call. Short, because revoking a key or flipping a Node's
  // payer should take effect in about a minute, not on restart.
  let credCache = { at: 0, value: null };
  const CRED_TTL_MS = 60_000;

  async function trackerPost(path, body) {
    const res = await fetch(`${TRACKER}/api/internal/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`tracker /${path} returned ${res.status}`);
    return res.json();
  }

  /** An error a Node can show the user verbatim. Not a fault to retry. */
  function billingError(code, message) {
    const err = new Error(message);
    err.code = code;
    err.billing = true;          // handlers can branch on this
    err.userFacing = true;
    return err;
  }

  async function credentials() {
    if (credCache.value && Date.now() - credCache.at < CRED_TTL_MS) return credCache.value;
    if (!INTERNAL_SECRET) {
      throw billingError("not_configured",
        "This server is not configured to resolve AI credentials (INTERNAL_NODE_SECRET is unset).");
    }
    let out;
    try {
      out = await trackerPost("node-llm-key", { slug, newsroom_id: newsroomId });
    } catch (err) {
      // The tracker being unreachable is an outage, not a billing answer — don't
      // cache it, and don't dress it up as "add your key".
      throw new Error(`Could not reach the credential service: ${err.message}`);
    }
    if (!out.ok) throw billingError(out.code, out.message);
    credCache = { at: Date.now(), value: out };
    return out;
  }

  let anthropic = null, openai = null, clientKey = null;
  function clientFor(cred) {
    // Rebuild if the key changed under us (payer flipped, or key replaced).
    if (clientKey !== cred.key) { anthropic = null; openai = null; clientKey = cred.key; }
    if (cred.provider === "openai") {
      if (!openai) openai = new OpenAI({ apiKey: cred.key });
      return openai;
    }
    if (!anthropic) anthropic = new Anthropic({ apiKey: cred.key });
    return anthropic;
  }
  /** Report what a call cost so it lands in the tracker's ledger. Never throws. */
  async function reportUsage(cred, model, usage) {
    try {
      await trackerPost("node-llm-usage", {
        surface: cred.surface, model, usage: usage || {},
        payer: cred.payer, newsroom_id: newsroomId
      });
    } catch (err) {
      // A lost usage record must not lose the user's answer — but for a
      // system-paid Node it means our cap is briefly blind, so say so.
      console.warn(`[ai] usage not recorded (${cred.payer}-paid): ${err.message}`);
    }
  }

  /** A provider rejecting the key is the newsroom's problem to fix — tell them. */
  async function flagKeyRejected(cred, err) {
    if (cred.payer !== "newsroom") return;
    credCache = { at: 0, value: null };   // re-resolve next call
    try {
      await trackerPost("node-key-failed", { newsroom_id: newsroomId, message: err.message });
    } catch { /* best effort */ }
  }

  function isAuthError(err) {
    const status = err?.status || err?.statusCode;
    return status === 401 || status === 403;
  }

  async function chat(input, opts = {}) {
    // opts.webSearch (true | { maxUses }) turns on Claude's server-side web
    // search tool — Anthropic runs the searches and returns the final answer
    // with citations in a single call. Lets a Node fact-check against the live
    // web instead of training knowledge alone.
    //
    // NOTE ON COST: each search bills $10/1,000 ($0.01) ON TOP of tokens, which
    // is roughly what an entire cheap-model call costs. Whoever is paying,
    // webSearch is the expensive option — keep maxUses low.
    const cred = await credentials();
    const messages = typeof input === "string" ? [{ role: "user", content: input }] : input;

    // ── OpenAI (a newsroom may bring either key) ────────────────────────────
    if (cred.provider === "openai") {
      const model = opts.model || process.env.OPENAI_MODEL || "gpt-5.4-mini";
      if (opts.webSearch) {
        // Don't silently drop a caller's request for grounded answers.
        console.warn("[ai] webSearch requested but this newsroom's key is OpenAI — answering without search");
      }
      try {
        const res = await clientFor(cred).chat.completions.create({
          model,
          max_tokens: opts.maxTokens || 1000,
          messages: opts.system ? [{ role: "system", content: opts.system }, ...messages] : messages
        });
        const u = res.usage || {};
        await reportUsage(cred, model, {
          input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0
        });
        return {
          text: (res.choices?.[0]?.message?.content || "").trim(),
          provider: "openai", model, payer: cred.payer, usedFallback: false, citations: []
        };
      } catch (err) {
        if (isAuthError(err)) {
          await flagKeyRejected(cred, err);
          throw billingError("key_rejected",
            "Your OpenAI API key was rejected. Check it in Settings — it may have been revoked or run out of credit.");
        }
        throw err;
      }
    }

    // ── Anthropic ───────────────────────────────────────────────────────────
    const model = opts.model || process.env.MODEL || "claude-haiku-4-5";
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
    try {
      const msg = await clientFor(cred).messages.create(params);
      await reportUsage(cred, model, msg.usage);
      const textBlocks = (msg.content || []).filter(b => b.type === "text");
      const text = textBlocks.map(b => b.text).join("\n").trim();
      const citations = harvestCitations(msg.content);
      return { text, provider: "anthropic", model, payer: cred.payer, usedFallback: false, citations };
    } catch (err) {
      if (isAuthError(err)) {
        await flagKeyRejected(cred, err);
        throw billingError("key_rejected", cred.payer === "newsroom"
          ? "Your Anthropic API key was rejected. Check it in Settings — it may have been revoked or run out of credit."
          : "Develop AI's AI key was rejected. This is a server-side problem, not yours.");
      }
      throw err;
    }
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

  // Per-newsroom key/value store — same interface as the lite host's, backed by
  // the ${PREFIX}store table. Values are JSON. Every query is scoped to newsroomId.
  const store = {
    list: async (collection) => {
      const r = await pool.query(
        `SELECT key, value FROM ${PREFIX}store WHERE newsroom_id=$1 AND collection=$2 ORDER BY key`,
        [newsroomId, collection]);
      return r.rows.map((row) => ({ key: row.key, value: row.value }));
    },
    get: async (collection, key) => {
      const r = await pool.query(
        `SELECT value FROM ${PREFIX}store WHERE newsroom_id=$1 AND collection=$2 AND key=$3`,
        [newsroomId, collection, String(key)]);
      return r.rows.length ? r.rows[0].value : null;
    },
    put: async (collection, key, value) => {
      await pool.query(
        `INSERT INTO ${PREFIX}store (newsroom_id, collection, key, value)
         VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (newsroom_id, collection, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
        [newsroomId, collection, String(key), JSON.stringify(value ?? null)]);
    },
    delete: async (collection, key) => {
      await pool.query(
        `DELETE FROM ${PREFIX}store WHERE newsroom_id=$1 AND collection=$2 AND key=$3`,
        [newsroomId, collection, String(key)]);
    },
  };

  // SHARED cross-node newsroom profile (host.profile) — one merged object per
  // newsroom, readable/writable by EVERY Node. get() seeds from the tracker's
  // own newsroom_profile when the shared row is still empty, so existing tracker
  // context flows into Nodes. See ensureProfileSchema().
  const profile = {
    get: async () => {
      const r = await pool.query(`SELECT data FROM grounded_newsroom_profile WHERE newsroom_id=$1`, [newsroomId]);
      if (r.rows.length && r.rows[0].data && Object.keys(r.rows[0].data).length) return r.rows[0].data;
      // Seed from the tracker's single-row newsroom_profile (bridge existing data).
      try {
        const t = await pool.query(
          `SELECT about, beats, audience, strengths, style_notes, trusted_sources
             FROM newsroom_profile ORDER BY created_at LIMIT 1`);
        if (t.rows.length) {
          const p = t.rows[0], seed = {};
          if (p.about) seed.about = p.about;
          if (p.audience) seed.audience = p.audience;
          if (p.beats) seed.beats_note = p.beats;
          if (p.strengths) seed.strengths = p.strengths;
          return seed;
        }
      } catch { /* tracker table may not exist in a standalone DB */ }
      return {};
    },
    set: async (patch) => {
      const cur = await profile.get();
      const next = { ...cur, ...(patch || {}), updated_at: new Date().toISOString() };
      await pool.query(
        `INSERT INTO grounded_newsroom_profile (newsroom_id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (newsroom_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
        [newsroomId, JSON.stringify(next)]);
      return next;
    },
  };

  // SHARED corpus write-back (host.corpus) — every Node's gathered data lands
  // in grounded_corpus_records wearing the standard shape, scoped per newsroom.
  // See ensureCorpusSchema() / src/corpus.js for the contract.
  const corpus = createCorpusApi({ pool, newsroomId, nodeSlug: slug });

  return {
    ctx,
    tablePrefix: PREFIX,
    meta,
    store,
    profile,
    corpus,
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
