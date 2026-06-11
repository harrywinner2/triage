import express from "express";
import multer from "multer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeBundle } from "./analyze";
import { saveAnalysis, getAnalysis, listAnalyses } from "./store";

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const SAMPLE_BUNDLE = path.join(ROOT, "samples", "sample-support-bundle.tar.gz");
const HEALTHY_BUNDLE = path.join(ROOT, "samples", "healthy-support-bundle.tar.gz");

const upload = multer({
  dest: path.join(os.tmpdir(), "triage-uploads"),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 MB
});

export function createServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, aiConfigured: Boolean(process.env.OPENAI_API_KEY) });
  });

  // Analyze an uploaded bundle.
  app.post("/api/analyze", upload.single("bundle"), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "no bundle uploaded (field name 'bundle')" });
      return;
    }
    try {
      const analysis = await analyzeBundle(req.file.path, { filename: req.file.originalname });
      saveAnalysis(analysis);
      res.json(analysis);
    } catch (err) {
      res.status(500).json({ error: (err as Error)?.message || "analysis failed" });
    } finally {
      fs.rm(req.file.path, { force: true }, () => {});
    }
  });

  // Analyze a bundled sample (no upload needed) — great for the demo.
  app.post("/api/analyze-sample", async (req, res) => {
    const which = req.query.which === "healthy" ? HEALTHY_BUNDLE : SAMPLE_BUNDLE;
    if (!fs.existsSync(which)) {
      res.status(404).json({ error: "sample bundle not found on server" });
      return;
    }
    try {
      const analysis = await analyzeBundle(which);
      saveAnalysis(analysis);
      res.json(analysis);
    } catch (err) {
      res.status(500).json({ error: (err as Error)?.message || "analysis failed" });
    }
  });

  app.get("/api/analyses", (_req, res) => res.json(listAnalyses()));

  app.get("/api/analyses/:id", (req, res) => {
    const a = getAnalysis(req.params.id);
    if (!a) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(a);
  });

  // SPA fallback.
  app.get("*", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

  return app;
}
