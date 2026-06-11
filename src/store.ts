import fs from "node:fs";
import path from "node:path";
import { Analysis } from "./types";

/**
 * Minimal JSON-file store. One file per analysis under `data/`, plus an in-memory
 * index loaded at boot. No native dependencies, so it deploys anywhere. History is
 * ephemeral on PaaS without a mounted volume — acceptable for a demo.
 */
const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), "data");

export interface AnalysisSummary {
  id: string;
  filename: string;
  analyzedAt: string;
  level: Analysis["verdict"]["level"];
  headline: string;
  severityCounts: Analysis["severityCounts"];
  findingCount: number;
  aiEnabled: boolean;
}

export function initStore(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function saveAnalysis(a: Analysis): void {
  initStore();
  fs.writeFileSync(path.join(DATA_DIR, `${a.id}.json`), JSON.stringify(a));
}

export function getAnalysis(id: string): Analysis | null {
  try {
    const safe = path.basename(id); // prevent path traversal
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${safe}.json`), "utf8"));
  } catch {
    return null;
  }
}

export function listAnalyses(): AnalysisSummary[] {
  initStore();
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  const summaries: AnalysisSummary[] = [];
  for (const f of files) {
    try {
      const a: Analysis = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
      summaries.push({
        id: a.id,
        filename: a.filename,
        analyzedAt: a.analyzedAt,
        level: a.verdict.level,
        headline: a.verdict.headline,
        severityCounts: a.severityCounts,
        findingCount: a.findings.length,
        aiEnabled: a.aiEnabled,
      });
    } catch {
      /* skip corrupt entry */
    }
  }
  return summaries.sort((a, b) => (a.analyzedAt < b.analyzedAt ? 1 : -1));
}
