import { ParsedBundle, getByKind, eventsFor, K8sObject } from "../bundle/parse";
import { DraftFinding, truncate } from "./util";

/**
 * Storage problems: PersistentVolumeClaims that aren't Bound. We escalate to
 * critical when the requested StorageClass doesn't exist (the claim can never
 * bind) and a workload is blocked waiting on it — a common silent root cause.
 */
export function detectStorage(b: ParsedBundle): DraftFinding[] {
  const pvcs = getByKind(b, "persistentvolumeclaim");
  const storageClasses = getByKind(b, "storageclass").map((s) => s.metadata?.name);
  const findings: DraftFinding[] = [];

  for (const pvc of pvcs) {
    const phase = pvc.status?.phase;
    if (phase === "Bound") continue;

    const ns = pvc.metadata?.namespace;
    const name = pvc.metadata?.name;
    const sc = pvc.spec?.storageClassName;
    const scMissing = sc && !storageClasses.includes(sc);
    const req = pvc.spec?.resources?.requests?.storage;

    const blockedPods = podsUsingPvc(b, name, ns);
    const isBlocking = blockedPods.length > 0;

    const evs = eventsFor(b, { name, kind: "PersistentVolumeClaim", namespace: ns })
      .concat(blockedPods.flatMap((p) => eventsFor(b, { name: p.metadata?.name, namespace: ns })))
      .filter((e) => e.type === "Warning");

    findings.push({
      detector: scMissing ? "storage.storageclass-missing" : "storage.pvc-unbound",
      severity: scMissing && isBlocking ? "critical" : isBlocking ? "high" : "medium",
      category: "storage",
      title: scMissing
        ? `PVC ${name} is unbound — StorageClass "${sc}" does not exist`
        : `PVC ${name} is stuck ${phase || "unbound"}`,
      summary: scMissing
        ? `${name} requests StorageClass "${sc}" (for ${req || "its volume"}), but no such StorageClass exists in the ` +
          `cluster. The claim can never bind` +
          (isBlocking
            ? `, so ${blockedPods.map((p) => p.metadata?.name).join(", ")} stays Pending. This is a likely root cause of any downstream outage.`
            : ".")
        : `${name} is ${phase || "not Bound"}${isBlocking ? `, blocking ${blockedPods.map((p) => p.metadata?.name).join(", ")}` : ""}. No matching volume is available.`,
      affectedResources: [
        { kind: "PersistentVolumeClaim", namespace: ns, name },
        ...blockedPods.map((p) => ({ kind: "Pod", namespace: ns, name: p.metadata?.name })),
      ],
      evidence: [
        {
          source: `cluster-resources/persistentvolumeclaims/${ns}.json`,
          excerpt: `status.phase: "${phase}"\nspec.storageClassName: "${sc}"\nspec.resources.requests.storage: "${req}"`,
        },
        scMissing
          ? {
              source: "cluster-resources/storage-classes.json",
              excerpt: `available StorageClasses: [${storageClasses.map((s) => `"${s}"`).join(", ")}]  // "${sc}" is absent`,
            }
          : null,
        evs.length
          ? {
              source: `cluster-resources/events/${ns}.json`,
              excerpt: truncate(
                evs.slice(0, 3).map((e) => `Warning ${e.reason} (x${e.count ?? 1})  ${e.message}`).join("\n"),
                500
              ),
            }
          : null,
      ].filter(Boolean) as any,
      remediation: scMissing
        ? `Create the missing StorageClass "${sc}" backed by your provisioner, or repoint the claim to an existing class ` +
          `(${storageClasses.join(", ") || "none found"}). For StatefulSets the volumeClaimTemplate is immutable, so the PVC must be deleted and recreated.`
        : `Check that a provisioner or a matching PersistentVolume is available for this claim, then confirm capacity and access modes match.`,
      docsUrl: "https://kubernetes.io/docs/concepts/storage/storage-classes/",
    });
  }

  return findings;
}

/** Find pods that mount a given PVC, either directly or via a StatefulSet volumeClaimTemplate. */
function podsUsingPvc(b: ParsedBundle, pvcName?: string, ns?: string): K8sObject[] {
  if (!pvcName) return [];
  return getByKind(b, "pod").filter((pod) => {
    if (ns && pod.metadata?.namespace !== ns) return false;
    const vols = pod.spec?.volumes || [];
    if (vols.some((v: any) => v.persistentVolumeClaim?.claimName === pvcName)) return true;
    // StatefulSet pods: PVC name is `<template>-<statefulset>-<ordinal>`, matching the pod name suffix.
    const podName = pod.metadata?.name || "";
    return pvcName.endsWith(podName.replace(/^.*?-/, "-")) || pvcName.includes(podName);
  });
}
