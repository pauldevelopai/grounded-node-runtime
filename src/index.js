// @developai/grounded-node-runtime / src/index.js
export { createLiteHost } from "./host-lite.js";
export { createServer }   from "./server.js";
export { mountChrome, readRuntimeVersion } from "./chrome.js";
// Hosted (online, multi-tenant) form — loads pg/cookie-parser/jsonwebtoken
// lazily, so importing this from a local install costs nothing.
export { createHostedServer } from "./server-hosted.js";
export { createPgHost, ensureActivitySchema, ensureStoreSchema, ensureProfileSchema } from "./host-pg.js";
// Corpus write-back layer (host.corpus) — the five shared corpora + the
// standard record contract. pg-free module; the pool is always injected.
export { CORPUS_COLLECTIONS, validateCorpusRecord, ensureCorpusSchema, createCorpusApi } from "./corpus.js";
// MCP boot mode — projects a Node's handlers as MCP tools (SDK lazy-imported).
export { createMcpServer, redirectConsoleForStdio } from "./server-mcp.js";
