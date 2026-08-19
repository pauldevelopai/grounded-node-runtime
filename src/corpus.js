/**
 * @developai/grounded-node-runtime / src/corpus.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The corpus write-back layer — host.corpus.
 *
 * The GROUNDED vision: everything a Node gathers accumulates in one of five
 * shared corpora, wearing the standard record shape, never in node-local
 * tables alone. This module is the enforcement point: every write is validated
 * here, whichever host is underneath.
 *
 * Storage follows the host.profile pattern: ONE shared, unprefixed table
 * (grounded_corpus_records) in the platform Postgres, every query scoped to
 * the requesting newsroom. The canonical DDL lives in the tracker's migration
 * (171_corpus_records.sql); ensureCorpusSchema() carries an identical copy so
 * a Node against a standalone DB still works. Keep the two in sync.
 *
 * The record contract matches grounded-opportunity-engine/src/corpus.js
 * (toCorpusRecord) — consumers may project through that helper, but the rules
 * are enforced HERE regardless of what a consumer sends:
 *   - collection must be one of the five corpora (closed list),
 *   - a record needs a title,
 *   - verification_status is born 'ai_drafted',
 *   - 'human_verified' requires verified_by — verification is a named
 *     person's act, never a default,
 *   - dedup on (collection, newsroom, source_url); title+date when no URL.
 */

export const CORPUS_COLLECTIONS = [
  "ai_law_regulation",    // AI law & regulation record
  "newsroom_ai",          // African newsroom AI record
  "policy_standards",     // policy & standards library
  "governance_registers", // client governance registers
  "news_opportunities",   // news & opportunities archive
];

const VERIFICATION_STATUSES = ["ai_drafted", "human_verified"];

/**
 * Validate + normalise one record into the standard corpus shape. Throws on
 * anything that would corrupt a corpus. Returns the normalised record.
 */
export function validateCorpusRecord({
  collection,
  title,
  source_url = null,
  date = null,              // the record's own date (published/closing), ISO string
  jurisdiction = null,      // e.g. 'ZA', 'ZM', 'global'
  language = null,          // e.g. 'en'
  licence = null,           // licence of the source material, if known
  summary = null,
  entity = null,            // 'tender' | 'funding_call' | 'company' | …
  verification_status = "ai_drafted",
  verified_by = null,       // named person — REQUIRED when human_verified
  outcome = null,           // 'applied' | 'won' | 'dismissed' | consumer ladder value
  extra = {},               // consumer-specific fields, kept under one key
} = {}) {
  if (!CORPUS_COLLECTIONS.includes(collection)) {
    throw new Error(`corpus collection must be one of ${CORPUS_COLLECTIONS.join(", ")} (got "${collection}")`);
  }
  if (!title || !String(title).trim()) throw new Error("corpus record needs a title");
  if (!VERIFICATION_STATUSES.includes(verification_status)) {
    throw new Error(`verification_status must be one of ${VERIFICATION_STATUSES.join(", ")}`);
  }
  if (verification_status === "human_verified" && !verified_by) {
    throw new Error("human_verified requires verified_by — verification is a named person's act");
  }
  return {
    collection,
    title: String(title).trim().slice(0, 500),
    source_url: source_url ? String(source_url).trim() : null,
    date: date || null,
    jurisdiction, language, licence, summary, entity,
    verification_status, verified_by, outcome,
    extra: extra && typeof extra === "object" ? extra : {},
  };
}

/**
 * Create the SHARED cross-node corpus table. NOT prefixed with a node slug —
 * every Node writes the same table, scoped per newsroom. Call once at boot.
 * Mirror of the tracker's canonical migration 171_corpus_records.sql.
 */
export async function ensureCorpusSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS grounded_corpus_records (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      collection    text NOT NULL CHECK (collection IN
                      ('ai_law_regulation','newsroom_ai','policy_standards',
                       'governance_registers','news_opportunities')),
      newsroom_id   text NOT NULL,
      node_slug     text,
      title         text NOT NULL,
      source_url    text,
      record_date   date,
      jurisdiction  text,
      language      text,
      licence       text,
      summary       text,
      entity        text,
      verification_status text NOT NULL DEFAULT 'ai_drafted'
                      CHECK (verification_status IN ('ai_drafted','human_verified')),
      verified_by   text,
      verified_at   timestamptz,
      outcome       text,
      extra         jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT corpus_verified_needs_person
        CHECK (verification_status <> 'human_verified' OR verified_by IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS corpus_dedup_url
      ON grounded_corpus_records (collection, newsroom_id, source_url)
      WHERE source_url IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS corpus_dedup_title_date
      ON grounded_corpus_records (collection, newsroom_id, title, record_date)
      WHERE source_url IS NULL;
    CREATE INDEX IF NOT EXISTS corpus_by_collection
      ON grounded_corpus_records (collection, created_at DESC);
    CREATE TABLE IF NOT EXISTS corpus_usage (
      n        bigserial PRIMARY KEY,
      ts       timestamptz NOT NULL DEFAULT now(),
      surface  text NOT NULL,
      op       text,
      corpus   text,
      actor    text,
      meta     jsonb
    );
    CREATE INDEX IF NOT EXISTS corpus_usage_by_corpus ON corpus_usage (corpus, ts);
    CREATE INDEX IF NOT EXISTS corpus_usage_by_surface ON corpus_usage (surface, ts);
  `);
}

const RETURN_COLS = `id, collection, newsroom_id, node_slug, title, source_url,
  record_date, jurisdiction, language, licence, summary, entity,
  verification_status, verified_by, verified_at, outcome, extra,
  created_at, updated_at`;

/**
 * Postgres-backed host.corpus, scoped to one newsroom. Same interface as the
 * lite host's file-backed corpus.
 */
export function createCorpusApi({ pool, newsroomId, nodeSlug = null } = {}) {
  if (!pool) throw new Error("createCorpusApi: pool is required");
  if (!newsroomId) throw new Error("createCorpusApi: newsroomId is required");

  // Usage log (corpus_usage, tracker migration 172) — READ ops only: writes
  // are already evidenced by the records themselves, and mixing them in would
  // inflate the query counts the Foundation reports. Fire-and-forget; a
  // logging failure must never break the query.
  const logUsage = (op, corpus) => {
    pool.query(
      `INSERT INTO corpus_usage (surface, op, corpus, actor, meta)
       VALUES ('host_corpus', $1, $2, $3, $4::jsonb)`,
      [op, corpus || null, `newsroom:${newsroomId}`,
       nodeSlug ? JSON.stringify({ node_slug: nodeSlug }) : null]
    ).catch((err) => console.warn("[corpus-usage] insert failed:", err.message));
  };

  return {
    /**
     * Write one record. Deduped — an already-held record is not rewritten and
     * not double-counted: returns { id, inserted:false } for a duplicate.
     */
    add: async (record) => {
      const r = validateCorpusRecord(record);
      const conflict = r.source_url
        ? "(collection, newsroom_id, source_url) WHERE source_url IS NOT NULL"
        : "(collection, newsroom_id, title, record_date) WHERE source_url IS NULL";
      const ins = await pool.query(
        `INSERT INTO grounded_corpus_records
           (collection, newsroom_id, node_slug, title, source_url, record_date,
            jurisdiction, language, licence, summary, entity,
            verification_status, verified_by, verified_at, outcome, extra)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 CASE WHEN $12 = 'human_verified' THEN now() END,$14,$15::jsonb)
         ON CONFLICT ${conflict} DO NOTHING
         RETURNING id`,
        [r.collection, newsroomId, nodeSlug, r.title, r.source_url, r.date,
         r.jurisdiction, r.language, r.licence, r.summary, r.entity,
         r.verification_status, r.verified_by, r.outcome, JSON.stringify(r.extra)]);
      if (ins.rows.length) return { id: ins.rows[0].id, inserted: true };
      const where = r.source_url
        ? `source_url = $3`
        : `title = $3 AND record_date IS NOT DISTINCT FROM $4`;
      const params = r.source_url
        ? [r.collection, newsroomId, r.source_url]
        : [r.collection, newsroomId, r.title, r.date];
      const dup = await pool.query(
        `SELECT id FROM grounded_corpus_records
         WHERE collection = $1 AND newsroom_id = $2 AND ${where}`, params);
      return { id: dup.rows[0]?.id || null, inserted: false };
    },

    get: async (id) => {
      const r = await pool.query(
        `SELECT ${RETURN_COLS} FROM grounded_corpus_records WHERE id = $1 AND newsroom_id = $2`,
        [id, newsroomId]);
      if (r.rows[0]) logUsage("get", r.rows[0].collection);
      return r.rows[0] || null;
    },

    list: async ({ collection, entity, verification_status, limit = 50, offset = 0 } = {}) => {
      const conds = ["newsroom_id = $1"], params = [newsroomId];
      const and = (sql, v) => { params.push(v); conds.push(`${sql} $${params.length}`); };
      if (collection) and("collection =", collection);
      if (entity) and("entity =", entity);
      if (verification_status) and("verification_status =", verification_status);
      params.push(Math.min(Number(limit) || 50, 500), Math.max(Number(offset) || 0, 0));
      const r = await pool.query(
        `SELECT ${RETURN_COLS} FROM grounded_corpus_records
         WHERE ${conds.join(" AND ")}
         ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
      logUsage("list", collection || null);
      return r.rows;
    },

    /** Flip a record to human_verified — verifiedBy is the named person, required. */
    verify: async (id, verifiedBy) => {
      if (!verifiedBy || !String(verifiedBy).trim()) {
        throw new Error("verify requires the verifier's name — verification is a named person's act");
      }
      const r = await pool.query(
        `UPDATE grounded_corpus_records
         SET verification_status = 'human_verified', verified_by = $3, verified_at = now(), updated_at = now()
         WHERE id = $1 AND newsroom_id = $2 RETURNING ${RETURN_COLS}`,
        [id, newsroomId, String(verifiedBy).trim()]);
      return r.rows[0] || null;
    },

    /** Record what happened to the record — the most valuable field we collect. */
    setOutcome: async (id, outcome) => {
      const r = await pool.query(
        `UPDATE grounded_corpus_records SET outcome = $3, updated_at = now()
         WHERE id = $1 AND newsroom_id = $2 RETURNING ${RETURN_COLS}`,
        [id, newsroomId, outcome || null]);
      return r.rows[0] || null;
    },
  };
}
