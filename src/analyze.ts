import fs from "node:fs";
import path from "node:path";
import { extractBundle } from "./bundle/extract";
import { parseBundle, getByKind, ParsedBundle } from "./bundle/parse";
import { runDetectors } from "./detectors";
import { nodeRows } from "./detectors/nodes";
import { sampleLogLines } from "./detectors/logs";
import { generateAIReport, deterministicReport, DigestInput } from "./ai";
import {
  Analysis,
  BundleMeta,
  Finding,
  Severity,
  SEVERITIES,
  SEVERITY_RANK,
  Verdict,
  WorkloadRow,
} from "./types";
import { isFailingPod } from "./detectors/util";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `an-${Date.now().toString(36)}-${counter}`;
}

export interface AnalyzeOptions {
  /** Original filename to record on the analysis (defaults to the archive basename). */
  filename?: string;
}

/** Full pipeline: extract → parse → detect → verdict → AI. */
export async function analyzeBundle(archivePath: string, opts: AnalyzeOptions = {}): Promise<Analysis> {
  const started = Date.now();
  const sizeBytes = fs.statSync(archivePath).size;
  const { root, cleanup } = await extractBundle(archivePath);
  try {
    const bundle = parseBundle(root);
    return await analyzeParsed(bundle, {
      filename: opts.filename || path.basename(archivePath),
      sizeBytes,
      started,
    });
  } finally {
    cleanup();
  }
}

interface ParsedMeta {
  filename: string;
  sizeBytes: number;
  started: number;
}

async function analyzeParsed(bundle: ParsedBundle, m: ParsedMeta): Promise<Analysis> {
  const meta = buildMeta(bundle);

  // 1. Run detectors and assign stable, severity-ordered ids.
  const drafts = runDetectors(bundle);
  drafts.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const findings: Finding[] = drafts.map((d, i) => ({
    ...d,
    id: `F-${String(i + 1).padStart(3, "0")}`,
  }));

  const severityCounts = countSeverities(findings);
  const workloads = workloadRows(bundle);
  const nodes = nodeRows(bundle);

  // 2. AI reasoning layer (or deterministic fallback).
  const digest: DigestInput = {
    meta,
    findings,
    workloads,
    nodes: nodes.map((n) => ({ name: n.name, status: n.status, pressure: n.pressure })),
    logSamples: sampleLogLines(bundle),
  };
  const llm = await generateAIReport(digest);
  const aiEnabled = llm !== null;
  const ai = llm ?? deterministicReport(findings, meta);

  // 3. Verdict. Headline prefers the AI's top root cause when available.
  const verdict = buildVerdict(findings, severityCounts, aiEnabled ? ai.rootCauses[0]?.title : undefined);

  return {
    id: nextId(),
    filename: m.filename,
    analyzedAt: new Date(m.started).toISOString(),
    sizeBytes: m.sizeBytes,
    aiEnabled,
    verdict,
    meta,
    severityCounts,
    findings,
    ai,
    nodes,
    workloads,
    durationMs: Date.now() - m.started,
  };
}

/* ----------------------------- builders ----------------------------- */

function buildMeta(b: ParsedBundle): BundleMeta {
  const pods = getByKind(b, "pod");
  const namespaces = getByKind(b, "namespace");
  let running = 0;
  let failing = 0;
  for (const pod of pods) {
    if (isFailingPod(pod)) failing++;
    else if (pod.status?.phase === "Running" || pod.status?.phase === "Succeeded") running++;
  }
  const nsCount =
    namespaces.length ||
    new Set(pods.map((p) => p.metadata?.namespace).filter(Boolean)).size;
  return {
    clusterVersion: b.clusterVersion,
    collectedAt: b.collectedAt,
    nodeCount: getByKind(b, "node").length,
    namespaceCount: nsCount,
    podCount: pods.length,
    runningPods: running,
    failingPods: failing,
  };
}

function countSeverities(findings: Finding[]): Record<Severity, number> {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of findings) counts[f.severity]++;
  return counts;
}

function buildVerdict(
  findings: Finding[],
  counts: Record<Severity, number>,
  aiHeadline?: string
): Verdict {
  const level: Verdict["level"] =
    counts.critical > 0 ? "critical" : counts.high + counts.medium > 0 ? "warning" : "healthy";

  const top = findings[0];
  const headline =
    level === "healthy"
      ? "Healthy — no significant issues detected"
      : aiHeadline || (top ? top.title : "Issues detected");

  const sub =
    level === "healthy"
      ? "All workloads and nodes look nominal in this bundle."
      : `${findings.length} finding(s): ` +
        SEVERITIES.filter((s) => counts[s] > 0)
          .map((s) => `${counts[s]} ${s}`)
          .join(", ") +
        ".";

  return { level, headline, sub };
}

function workloadRows(b: ParsedBundle): WorkloadRow[] {
  const rows: WorkloadRow[] = [];
  for (const kind of ["Deployment", "StatefulSet", "DaemonSet"]) {
    for (const w of getByKind(b, kind)) {
      const desired = w.spec?.replicas ?? w.status?.desiredNumberScheduled ?? w.status?.replicas ?? 0;
      const ready = w.status?.readyReplicas ?? w.status?.numberReady ?? 0;
      rows.push({
        kind,
        ns: w.metadata?.namespace || "",
        name: w.metadata?.name || "",
        desired,
        ready,
        state: ready >= desired && desired > 0 ? "ok" : ready === desired ? "ok" : "bad",
      });
    }
  }
  // Show unhealthy workloads first.
  return rows.sort((a, b) => (a.state === b.state ? 0 : a.state === "bad" ? -1 : 1));
}
