import { ParsedBundle, getByKind, K8sObject } from "../bundle/parse";
import { DraftFinding } from "./util";

/**
 * Node health: a node that isn't Ready (or whose kubelet stopped heartbeating)
 * and resource-pressure conditions (Memory/Disk/PID). One finding per unhealthy
 * node, summarizing all of its bad conditions.
 */
export function detectNodes(b: ParsedBundle): DraftFinding[] {
  const findings: DraftFinding[] = [];

  for (const node of getByKind(b, "node")) {
    const conditions: any[] = node.status?.conditions || [];
    const ready = conditions.find((c) => c.type === "Ready");
    const notReady = ready && ready.status !== "True";
    const pressures = conditions.filter(
      (c) => /Pressure$/.test(c.type) && c.status === "True"
    );

    if (!notReady && pressures.length === 0) continue;

    const name = node.metadata?.name;
    const badBits: string[] = [];
    if (notReady) badBits.push(`Ready=${ready.status} (${ready.reason})`);
    for (const p of pressures) badBits.push(`${p.type}=True`);

    findings.push({
      detector: notReady ? "node.notready" : "node.pressure",
      severity: notReady ? "high" : "medium",
      category: "node",
      title: notReady
        ? `Node ${name} is NotReady${pressures.length ? " with resource pressure" : ""}`
        : `Node ${name} is under resource pressure`,
      summary: notReady
        ? `${name} isn't Ready — ${ready.message || ready.reason}.${
            pressures.length ? ` It also reports ${pressures.map((p) => p.type).join(" and ")}.` : ""
          } This reduces schedulable capacity and can starve workloads.`
        : `${name} reports ${pressures.map((p) => p.type).join(" and ")}, which can trigger evictions and scheduling failures.`,
      affectedResources: [{ kind: "Node", name }],
      evidence: [
        {
          source: "cluster-resources/nodes.json",
          excerpt: conditions
            .filter((c) => c.type === "Ready" || /Pressure$/.test(c.type))
            .map((c) => `${c.type}=${c.status}${c.reason ? ` (${c.reason})` : ""}${c.message ? `: ${c.message}` : ""}`)
            .join("\n"),
        },
      ],
      remediation: notReady
        ? `Check the kubelet on ${name} (it may have stopped posting status), then free memory/disk if under pressure. ` +
          `Cordon and drain the node if it needs recovery so the scheduler stops counting it as available.`
        : `Reclaim memory/disk on ${name} (image and log garbage collection, evict noisy pods) before the kubelet starts evicting workloads.`,
      docsUrl: "https://kubernetes.io/docs/concepts/architecture/nodes/#condition",
    });
  }

  return findings;
}

/** Exported for the cluster overview table. */
export function nodeRows(b: ParsedBundle) {
  return getByKind(b, "node").map((n: K8sObject) => {
    const conditions: any[] = n.status?.conditions || [];
    const ready = conditions.find((c) => c.type === "Ready");
    const pressures = conditions
      .filter((c) => /Pressure$/.test(c.type) && c.status === "True")
      .map((c) => c.type.replace("Pressure", ""));
    const labels = n.metadata?.labels || {};
    const isCP =
      "node-role.kubernetes.io/control-plane" in labels ||
      "node-role.kubernetes.io/master" in labels;
    return {
      name: n.metadata?.name || "?",
      status: ready ? (ready.status === "True" ? "Ready" : "NotReady") : "Unknown",
      roles: isCP ? "control-plane" : "worker",
      version: n.status?.nodeInfo?.kubeletVersion || "?",
      cpu: String(n.status?.capacity?.cpu ?? "?"),
      mem: humanMem(n.status?.capacity?.memory),
      pressure: pressures.length ? pressures.join(", ") : "—",
    };
  });
}

function humanMem(v?: string): string {
  if (!v) return "?";
  const m = v.match(/^(\d+)Ki$/);
  if (m) return `${Math.round(Number(m[1]) / 1024 / 1024)}Gi`;
  return v;
}
