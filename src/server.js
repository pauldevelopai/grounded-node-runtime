/**
 * @developai/grounded-node-runtime / src/server.js
 *
 * One-line boot for a standalone Node. Wires the lite host to the Node's
 * handlers and exposes the standard REST surface. Every Node uses the same
 * route names so dashboards from different Nodes can share their JS conventions.
 *
 *   import { createLiteHost, createServer } from "@developai/grounded-node-runtime";
 *   import * as handlers from "./lib/handlers.js";
 *
 *   createServer({
 *     slug: "makanday-analytics",
 *     host: createLiteHost({ appSlug: "makanday-analytics" }),
 *     handlers,
 *     displayName: "MakanDay Audience Signal"
 *   });
 *
 * Standard routes (mounted only if the matching handler exists):
 *   GET  /api/sources    → handlers.listSources(host)
 *   GET  /api/report     → handlers.getReport(host, query)
 *   GET  /api/quality    → handlers.getQuality(host, query)
 *   POST /api/brief      → handlers.postBrief(host, body)
 *   POST /api/ingest     → handlers.postIngest(host, { buffer, sourceLabel })
 *                          (multipart/form-data with field "file")
 */

import express from "express";
import multer from "multer";
import { mountChrome, readRuntimeVersion } from "./chrome.js";
import { syncFile, catchupPush } from "./git-sync.js";
import { telemetryEnabled, sendTelemetry } from "./telemetry.js";

export function createServer({
  slug,
  host,
  handlers = {},
  displayName,
  nodeVersion,
  port = process.env.PORT || 3000,
  staticDir = "public",
  uploadLimitMb = 25
}) {
  if (!slug) throw new Error("createServer: slug is required");
  if (!host) throw new Error("createServer: host is required");

  const app = express();
  app.use(express.json());
  app.use(express.static(staticDir));

  // GROUNDED chrome — family branding + telemetry endpoint. Nodes opt in
  // via two <link>/<script> lines in their HTML; this just makes the
  // assets and the meta endpoint available.
  mountChrome(app, {
    slug,
    displayName: displayName || slug,
    nodeVersion: nodeVersion || host?.meta?.node_version || "unknown",
    runtimeVersion: readRuntimeVersion(),
    hostId: host?.meta?.host_id || null,
    newsroom: host?.meta?.newsroom || null,
  });

  const wrap = fn => async (req, res) => {
    try { res.json(await fn(host, req.body || req.query || {})); }
    catch (e) {
      res.status(500).json({ error: e.message || "node error" });
      // Fire-and-forget: log the error to the structured error feed so
      // the cohort dashboard picks it up. Never throws — if logging
      // itself fails, swallow it rather than crash the response.
      try {
        host.log?.error?.({
          op: req.path,
          error: e,
          context: { method: req.method, query_keys: Object.keys(req.query || {}) }
        });
      } catch { /* swallowed */ }
    }
  };

  if (handlers.getSetupStatus) app.get("/api/setup",   wrap(h => handlers.getSetupStatus(h)));
  if (handlers.postSetup)      app.post("/api/setup",  wrap((h, b) => handlers.postSetup(h, b)));
  if (handlers.listSources)    app.get("/api/sources",  wrap(h => handlers.listSources(h)));
  if (handlers.getReport)      app.get("/api/report",   wrap((h, q) => handlers.getReport(h, q)));
  if (handlers.getQuality)     app.get("/api/quality",  wrap((h, q) => handlers.getQuality(h, q)));
  if (handlers.getActivity)    app.get("/api/activity", wrap(h => handlers.getActivity(h)));
  if (handlers.postBrief)      app.post("/api/brief",   wrap((h, b) => handlers.postBrief(h, b)));

  if (handlers.postIngest) {
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: uploadLimitMb * 1024 * 1024 }
    });
    app.post("/api/ingest", upload.single("file"), async (req, res) => {
      try {
        if (!req.file) throw new Error("Choose a file to upload first.");
        const out = await handlers.postIngest(host, {
          buffer: req.file.buffer,
          sourceLabel: (req.body && req.body.sourceLabel) ||
            req.file.originalname.replace(/\.[^.]+$/, "")
        });
        res.json(out);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  }

  // ── Feedback — newsroom-typed free-text content. The local write
  // always succeeds; the git push is best-effort with a hard timeout
  // so the modal isn't held hostage by a slow network. The response
  // tells the frontend which state we ended in.
  app.post("/api/grounded/feedback", async (req, res) => {
    try {
      const { type, message, page } = req.body || {};
      const { file, entry } = await host.feedback.submit({ type, message, page });
      await host.log.run({ op: "feedback_submit", type: type || "other" }).catch(() => {});

      if (telemetryEnabled()) {
        // HTTP path — send to the collector. No git push, no fork needed.
        const sent = await sendTelemetry("feedback", {
          host_id: entry.host_id,
          slug,
          newsroom: entry.newsroom,
          ts: entry.ts,
          type: entry.type,
          message: entry.message,
          page: entry.page,
          node_version: entry.node_version,
        });
        // It's saved locally regardless; `synced` reflects whether the POST landed.
        res.json({ saved: true, synced: sent, sync_step: sent ? "sent" : "send_failed" });
      } else {
        // Legacy git path (unchanged) for Nodes not pointed at a collector.
        const sync = await syncFile(file, `feedback: ${type || "other"}`);
        res.json({
          saved: true,
          synced: sync.step === "pushed",
          sync_step: sync.step,
          sync_reason: sync.reason || null,
        });
      }
    } catch (e) {
      res.status(400).json({ saved: false, error: e.message || "feedback failed" });
    }
  });

  const banner = displayName || slug;
  app.listen(port, () => {
    console.log("");
    console.log(`  ✓ ${banner} is running.`);
    console.log(`  ✓ Open this in your web browser:  http://localhost:${port}`);
    console.log("");
    console.log("  Press Ctrl+C in this window to stop it.");
    console.log("");
  });

  // Boot catchup: 3 seconds after start, try to push any feedback
  // commits that didn't make it to origin last time (offline at the
  // moment of submission). Silent on failure — this is best-effort.
  setTimeout(() => {
    catchupPush().then((r) => {
      if (r.ok && r.step === "pushed") {
        console.log(`[grounded] catchup-pushed ${r.count} pending commit(s)`);
      }
    }).catch(() => { /* silent */ });
  }, 3000);

  return app;
}
