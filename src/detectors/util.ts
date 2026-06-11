import { K8sObject } from "../bundle/parse";
import { Finding } from "../types";

/** Detectors return findings without a stable id; `analyze` assigns ids after sorting. */
export type DraftFinding = Omit<Finding, "id"> & { id?: string };

export function truncate(s: string, n = 600): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n…[+${s.length - n} chars]`;
}

/** All container statuses (regular + init) for a pod. */
export function containerStatuses(pod: K8sObject): any[] {
  const s = pod.status || {};
  return [...(s.containerStatuses || []), ...(s.initContainerStatuses || [])];
}

/**
 * A stable, human-friendly name for the workload a pod belongs to, used to
 * collapse N replica pods with the same problem into one finding.
 */
export function workloadKey(pod: K8sObject): string {
  const labels = pod.metadata?.labels || {};
  if (labels.app) return labels.app;
  if (labels["app.kubernetes.io/name"]) return labels["app.kubernetes.io/name"];
  const name: string = pod.metadata?.name || "unknown";
  return name
    .replace(/-[a-f0-9]{8,10}-[a-z0-9]{4,5}$/, "") // deployment replicaset suffix
    .replace(/-\d+$/, ""); // statefulset ordinal
}

export function podNamespace(pod: K8sObject): string | undefined {
  return pod.metadata?.namespace;
}

/** A pod is "failing" if it isn't Running/Succeeded or has a not-ready container. */
export function isFailingPod(pod: K8sObject): boolean {
  const phase = pod.status?.phase;
  if (phase && phase !== "Running" && phase !== "Succeeded") return true;
  return containerStatuses(pod).some((cs) => cs.ready === false);
}

/** Compact JSON-ish excerpt of selected fields, for evidence blocks. */
export function jsonExcerpt(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}`)
    .join("\n");
}
