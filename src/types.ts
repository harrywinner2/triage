/**
 * Shared types for the Triage analysis pipeline.
 *
 * `Analysis` is the single object the API returns and the frontend renders.
 * Detectors produce `Finding[]`; the AI layer produces an `AIReport`.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Category =
  | "workload"
  | "node"
  | "storage"
  | "config"
  | "network"
  | "events"
  | "logs"
  | "cluster";

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];
/** Lower rank = more severe. Used for sorting and verdict selection. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export interface ResourceRef {
  kind: string;
  namespace?: string;
  name: string;
}

export interface Evidence {
  /** Path inside the bundle the excerpt was taken from. */
  source: string;
  excerpt: string;
  lineRange?: string;
}

export interface Finding {
  id: string;
  detector: string;
  title: string;
  severity: Severity;
  category: Category;
  summary: string;
  affectedResources: ResourceRef[];
  evidence: Evidence[];
  remediation: string;
  docsUrl?: string | null;
}

export interface BundleMeta {
  clusterVersion: string | null;
  collectedAt: string | null;
  nodeCount: number;
  namespaceCount: number;
  podCount: number;
  runningPods: number;
  failingPods: number;
}

export interface Verdict {
  level: "critical" | "warning" | "healthy";
  headline: string;
  sub?: string;
}

export interface RootCause {
  title: string;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  relatedFindingIds: string[];
}

export interface RemediationStep {
  priority: number;
  action: string;
  rationale: string;
  commands?: string[];
}

export interface AIReport {
  summary: string;
  rootCauses: RootCause[];
  remediation: RemediationStep[];
}

export interface NodeRow {
  name: string;
  status: string;
  roles: string;
  version: string;
  cpu: string;
  mem: string;
  pressure: string;
}

export interface WorkloadRow {
  kind: string;
  ns: string;
  name: string;
  desired: number;
  ready: number;
  state: "ok" | "bad";
}

export interface Analysis {
  id: string;
  filename: string;
  analyzedAt: string;
  sizeBytes: number;
  /** true when the LLM reasoning layer ran; false when it fell back to deterministic. */
  aiEnabled: boolean;
  verdict: Verdict;
  meta: BundleMeta;
  severityCounts: Record<Severity, number>;
  findings: Finding[];
  ai: AIReport | null;
  nodes: NodeRow[];
  workloads: WorkloadRow[];
  durationMs?: number;
}
