import { ParsedBundle, getByKind, eventsFor, K8sObject } from "../bundle/parse";
import { DraftFinding, containerStatuses, workloadKey, podNamespace, truncate } from "./util";

/**
 * Configuration errors that stop a container from being created — most commonly
 * `CreateContainerConfigError` from a ConfigMap/Secret key that a container
 * references but that doesn't exist. We cross-check the referenced ConfigMap so
 * the finding names the exact missing key.
 */
export function detectConfig(b: ParsedBundle): DraftFinding[] {
  const pods = getByKind(b, "pod");
  const findings: DraftFinding[] = [];
  const seen = new Set<string>();

  for (const pod of pods) {
    for (const cs of containerStatuses(pod)) {
      const reason = cs.state?.waiting?.reason;
      if (reason !== "CreateContainerConfigError" && reason !== "CreateContainerError") continue;

      const app = workloadKey(pod);
      const ns = podNamespace(pod);
      const key = `${ns}/${app}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // The precise message is usually in the matching Warning event.
      const evs = eventsFor(b, { name: pod.metadata?.name, namespace: ns }).filter(
        (e) => e.type === "Warning" && /couldn't find key|configmap|secret/i.test(e.message || "")
      );
      const msg = evs[0]?.message || cs.state?.waiting?.message || "container configuration error";
      const ref = parseMissingKey(msg);
      const cm = ref ? findConfigMap(b, ref.configMap, ns) : null;

      findings.push({
        detector: "config.missing-key",
        severity: "medium",
        category: "config",
        title: ref
          ? `${app}: missing key ${ref.key} in ConfigMap ${ref.configMap}`
          : `${app}: CreateContainerConfigError`,
        summary: ref
          ? `${app} references \`${ref.key}\` from ConfigMap \`${ref.configMap}\`, but that key isn't present` +
            `${cm ? ` (the ConfigMap only has: ${Object.keys(cm.data || {}).join(", ")})` : ""}. ` +
            `The container can't start until the key is added. This is the classic one-line misconfiguration.`
          : `${app} can't create its container due to a configuration error: ${truncate(msg, 160)}`,
        affectedResources: [
          { kind: "Pod", namespace: ns, name: pod.metadata?.name },
          ...(ref ? [{ kind: "ConfigMap", namespace: ns, name: ref.configMap }] : []),
        ],
        evidence: [
          { source: `cluster-resources/events/${ns}.json`, excerpt: `Warning Failed  ${truncate(msg, 200)}` },
          cm
            ? {
                source: `cluster-resources/configmaps/${ns}.json`,
                excerpt: `data keys: [${Object.keys(cm.data || {}).map((k) => `"${k}"`).join(", ")}]${ref ? `  // "${ref.key}" missing` : ""}`,
              }
            : null,
        ].filter(Boolean) as any,
        remediation: ref
          ? `Add \`${ref.key}\` to ConfigMap \`${ref.configMap}\` (or correct the container's env reference), then restart the workload.`
          : `Inspect the container's env/envFrom and the referenced ConfigMaps/Secrets; a referenced key or resource is missing.`,
        docsUrl: "https://kubernetes.io/docs/concepts/configuration/configmap/",
      });
    }
  }

  return findings;
}

function parseMissingKey(msg: string): { key: string; configMap: string } | null {
  // "couldn't find key DATABASE_URL in ConfigMap acme-shop/order-config"
  const m = msg.match(/couldn't find key (\S+) in ConfigMap (?:\S+\/)?(\S+)/i);
  if (m) return { key: m[1], configMap: m[2] };
  return null;
}

function findConfigMap(b: ParsedBundle, name: string, ns?: string): K8sObject | null {
  return (
    getByKind(b, "configmap").find(
      (c) => c.metadata?.name === name && (!ns || c.metadata?.namespace === ns)
    ) || null
  );
}
