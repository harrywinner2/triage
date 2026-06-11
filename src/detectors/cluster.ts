import { ParsedBundle } from "../bundle/parse";
import { DraftFinding } from "./util";

/** Newest minor release we assume as a reference point for "how far behind" messaging. */
const REFERENCE_MINOR = 31;

/**
 * Cluster-wide signals. Currently: an aging Kubernetes control-plane version,
 * which often correlates with deprecated APIs and unpatched CVEs. Informational —
 * it rarely is *the* incident, but it's useful context for a support engineer.
 */
export function detectCluster(b: ParsedBundle): DraftFinding[] {
  const findings: DraftFinding[] = [];
  const v = b.clusterVersion;
  if (v) {
    const m = v.match(/v?(\d+)\.(\d+)/);
    if (m) {
      const minor = Number(m[2]);
      const behind = REFERENCE_MINOR - minor;
      if (behind >= 3) {
        findings.push({
          detector: "cluster.version-skew",
          severity: "info",
          category: "cluster",
          title: `Kubernetes ${v} is several releases behind`,
          summary: `The control plane reports ${v}, roughly ${behind} minor releases behind current. Older releases miss security patches and may use APIs that newer charts have removed.`,
          affectedResources: [],
          evidence: [
            {
              source: "cluster-info/cluster_version.json",
              excerpt: `serverVersion.gitVersion: "${v}"`,
            },
          ],
          remediation:
            "Plan a staged upgrade of the control plane and nodes, checking for removed/deprecated APIs in your manifests first.",
          docsUrl: "https://kubernetes.io/releases/",
        });
      }
    }
  }
  return findings;
}
