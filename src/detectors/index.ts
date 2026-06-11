import { ParsedBundle } from "../bundle/parse";
import { DraftFinding } from "./util";
import { detectWorkloads } from "./workloads";
import { detectStorage } from "./storage";
import { detectConfig } from "./config";
import { detectNodes } from "./nodes";
import { detectEvents } from "./events";
import { detectLogs } from "./logs";
import { detectCluster } from "./cluster";

export type Detector = (b: ParsedBundle) => DraftFinding[];

/** The detector catalog. Each is a pure function over the parsed bundle. */
export const DETECTORS: { name: string; run: Detector }[] = [
  { name: "workloads", run: detectWorkloads },
  { name: "storage", run: detectStorage },
  { name: "config", run: detectConfig },
  { name: "nodes", run: detectNodes },
  { name: "events", run: detectEvents },
  { name: "logs", run: detectLogs },
  { name: "cluster", run: detectCluster },
];

/** Run every detector, swallowing per-detector errors so one bad detector can't fail the analysis. */
export function runDetectors(b: ParsedBundle): DraftFinding[] {
  const all: DraftFinding[] = [];
  for (const d of DETECTORS) {
    try {
      all.push(...d.run(b));
    } catch (err) {
      // A detector throwing on an unusual bundle shape shouldn't sink the report.
      console.error(`[triage] detector "${d.name}" failed:`, (err as Error)?.message);
    }
  }
  return all;
}
