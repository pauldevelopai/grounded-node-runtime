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

export function createServer({
  slug,
  host,
  handlers = {},
  displayName,
  port = process.env.PORT || 3000,
  staticDir = "public",
  uploadLimitMb = 25
}) {
  if (!slug) throw new Error("createServer: slug is required");
  if (!host) throw new Error("createServer: host is required");

  const app = express();
  app.use(express.json());
  app.use(express.static(staticDir));

  const wrap = fn => async (req, res) => {
    try { res.json(await fn(host, req.body || req.query || {})); }
    catch (e) { res.status(500).json({ error: e.message || "node error" }); }
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

  const banner = displayName || slug;
  app.listen(port, () => {
    console.log("");
    console.log(`  ✓ ${banner} is running.`);
    console.log(`  ✓ Open this in your web browser:  http://localhost:${port}`);
    console.log("");
    console.log("  Press Ctrl+C in this window to stop it.");
    console.log("");
  });

  return app;
}
