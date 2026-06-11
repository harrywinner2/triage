import { ParsedBundle, getByKind, eventsFor, K8sObject } from "../bundle/parse";
import {
  DraftFinding,
  containerStatuses,
  workloadKey,
  podNamespace,
  truncate,
} from "./util";

/**
 * Pod-level workload failures: OOMKills, crash loops, image-pull errors, and
 * pods that can't be scheduled (excluding volume-caused scheduling failures,
 * which the storage detector owns). Replica pods with the same problem under the
 * same workload are collapsed into a single finding.
 */
export function detectWorkloads(b: ParsedBundle): DraftFinding[] {
  const pods = getByKind(b, "pod");
  const findings: DraftFinding[] = [];

  type Issue = { kind: "oom" | "crashloop" | "imagepull"; pod: K8sObject; cs: any };
  const issues: Issue[] = [];

  for (const pod of pods) {
    for (const cs of containerStatuses(pod)) {
      const waiting = cs.state?.waiting?.reason;
      const lastTerm = cs.lastState?.terminated?.reason;
      if (lastTerm === "OOMKilled") issues.push({ kind: "oom", pod, cs });
      else if (waiting === "CrashLoopBackOff") issues.push({ kind: "crashloop", pod, cs });
      if (waiting === "ImagePullBackOff" || waiting === "ErrImagePull")
        issues.push({ kind: "imagepull", pod, cs });
    }
  }

  // group by (workload, issue-kind)
  const groups = new Map<string, Issue[]>();
  for (const i of issues) {
    const key = `${workloadKey(i.pod)}::${i.kind}`;
    (groups.get(key) || groups.set(key, []).get(key)!).push(i);
  }

  for (const [key, group] of groups) {
    const [app] = key.split("::");
    const kind = group[0].kind;
    const ns = podNamespace(group[0].pod);
    const podNames = [...new Set(group.map((g) => g.pod.metadata?.name))];
    const replicaInfo = workloadReadiness(b, app, ns);

    if (kind === "oom") {
      const restarts = group[0].cs.restartCount ?? 0;
      const limit = memLimit(group[0].pod, group[0].cs.name);
      findings.push({
        detector: "workload.oomkilled",
        severity: "critical",
        category: "workload",
        title: `${app} is being OOMKilled in a crash loop${limit ? ` (memory limit ${limit})` : ""}`,
        summary:
          `${podNames.length} ${app} pod(s) are crash-looping after the container was OOMKilled (exit 137)` +
          `${restarts ? `, ${restarts} restarts` : ""}.${replicaInfo ? ` ${replicaInfo}.` : ""}` +
          (limit ? ` The ${limit} memory limit is likely too low for the workload.` : ""),
        affectedResources: podNames.map((name) => ({ kind: "Pod", namespace: ns, name })),
        evidence: [
          podStatusEvidence(b, group[0].pod, group[0].cs),
          ...logEvidence(b, app, ns, [/outofmemory/i, /heap/i, /killed/i]),
          eventEvidence(b, group[0].pod),
        ].filter(Boolean) as any,
        remediation:
          `Raise the container memory limit (and request) to fit the workload, and for JVM apps set ` +
          `-XX:MaxRAMPercentage so the heap respects the cgroup limit. Then profile what is consuming memory at start-up.`,
        docsUrl:
          "https://kubernetes.io/docs/tasks/configure-pod-container/assign-memory-resource/",
      });
    } else if (kind === "crashloop") {
      const restarts = group[0].cs.restartCount ?? 0;
      findings.push({
        detector: "workload.crashloop",
        severity: restarts >= 5 ? "high" : "medium",
        category: "workload",
        title: `${app} is in CrashLoopBackOff`,
        summary:
          `${podNames.length} ${app} pod(s) keep restarting (${restarts} restarts).` +
          `${replicaInfo ? ` ${replicaInfo}.` : ""} Inspect the container logs for the crash cause.`,
        affectedResources: podNames.map((name) => ({ kind: "Pod", namespace: ns, name })),
        evidence: [
          podStatusEvidence(b, group[0].pod, group[0].cs),
          ...logEvidence(b, app, ns, [/error|fatal|panic|exception/i]),
          eventEvidence(b, group[0].pod),
        ].filter(Boolean) as any,
        remediation:
          `Read the container's last logs to find why it exits, fix the underlying error, and verify the ` +
          `liveness probe isn't killing a slow-starting container prematurely.`,
        docsUrl:
          "https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/",
      });
    } else if (kind === "imagepull") {
      const image = containerImage(group[0].pod, group[0].cs.name);
      const hasPullSecret =
        (group[0].pod.spec?.imagePullSecrets || []).length > 0;
      findings.push({
        detector: "workload.image-pull",
        severity: "high",
        category: "workload",
        title: `${app} cannot pull its image (ImagePullBackOff)`,
        summary:
          `${app} is stuck pulling ${image ? `\`${image}\`` : "its image"}.` +
          `${hasPullSecret ? "" : " The pod has no imagePullSecret, which is a likely cause for a private registry."}` +
          ` Confirm the tag exists in the registry and that credentials are configured.`,
        affectedResources: podNames.map((name) => ({ kind: "Pod", namespace: ns, name })),
        evidence: [
          podStatusEvidence(b, group[0].pod, group[0].cs),
          eventEvidence(b, group[0].pod),
        ].filter(Boolean) as any,
        remediation:
          `Verify the image tag was actually pushed to the registry, and attach a valid imagePullSecret to ` +
          `the pod's ServiceAccount if the registry is private. "manifest unknown" almost always means the tag doesn't exist.`,
        docsUrl:
          "https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/",
      });
    }
  }

  // Pods that can't be scheduled for non-volume reasons.
  for (const pod of pods) {
    if (pod.status?.phase !== "Pending") continue;
    if (containerStatuses(pod).length > 0) continue; // already covered above if it has container statuses
    const evs = eventsFor(b, { name: pod.metadata?.name, namespace: podNamespace(pod) }).filter(
      (e) => e.reason === "FailedScheduling"
    );
    if (!evs.length) continue;
    const msg = evs[0].message || "";
    if (/persistentvolumeclaim|volume/i.test(msg)) continue; // storage detector owns this
    findings.push({
      detector: "workload.unschedulable",
      severity: "high",
      category: "workload",
      title: `${pod.metadata?.name} cannot be scheduled`,
      summary: `The scheduler can't place this pod: ${truncate(msg, 200)}`,
      affectedResources: [{ kind: "Pod", namespace: podNamespace(pod), name: pod.metadata?.name }],
      evidence: [{ source: "cluster-resources/events", excerpt: truncate(msg, 400) }],
      remediation:
        "Check node capacity, taints/tolerations, affinity rules and resource requests against available nodes.",
      docsUrl: "https://kubernetes.io/docs/concepts/scheduling-eviction/",
    });
  }

  return findings;
}

/* --------------------------- helpers --------------------------- */

function workloadReadiness(b: ParsedBundle, app: string, ns?: string): string | null {
  for (const kind of ["deployment", "statefulset", "daemonset"]) {
    const w = getByKind(b, kind).find(
      (x) => x.metadata?.name === app && (!ns || x.metadata?.namespace === ns)
    );
    if (w) {
      const desired = w.spec?.replicas ?? w.status?.replicas ?? 0;
      const ready = w.status?.readyReplicas ?? 0;
      return `${ready}/${desired} replicas ready`;
    }
  }
  return null;
}

function memLimit(pod: K8sObject, containerName?: string): string | null {
  const c = (pod.spec?.containers || []).find((x: any) => x.name === containerName) ||
    (pod.spec?.containers || [])[0];
  return c?.resources?.limits?.memory || null;
}

function containerImage(pod: K8sObject, containerName?: string): string | null {
  const c = (pod.spec?.containers || []).find((x: any) => x.name === containerName) ||
    (pod.spec?.containers || [])[0];
  return c?.image || null;
}

function podStatusEvidence(b: ParsedBundle, pod: K8sObject, cs: any) {
  const ns = podNamespace(pod);
  const fields: Record<string, unknown> = {
    "state.waiting.reason": cs.state?.waiting?.reason,
    "lastState.terminated.reason": cs.lastState?.terminated?.reason,
    "lastState.terminated.exitCode": cs.lastState?.terminated?.exitCode,
    restartCount: cs.restartCount,
    image: containerImage(pod, cs.name),
    "resources.limits.memory": memLimit(pod, cs.name),
  };
  const excerpt = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v}"` : v}`)
    .join("\n");
  return { source: `cluster-resources/pods/${ns}.json`, excerpt };
}

function eventEvidence(b: ParsedBundle, pod: K8sObject) {
  const evs = eventsFor(b, { name: pod.metadata?.name, namespace: podNamespace(pod) })
    .filter((e) => e.type === "Warning")
    .slice(0, 3);
  if (!evs.length) return null;
  const ns = podNamespace(pod);
  const excerpt = evs
    .map((e) => `Warning ${e.reason} (x${e.count ?? 1})  ${truncate(e.message || "", 120)}`)
    .join("\n");
  return { source: `cluster-resources/events/${ns}.json`, excerpt };
}

function logEvidence(b: ParsedBundle, app: string, ns: string | undefined, patterns: RegExp[]) {
  const log = b.logs.find(
    (l) => (l.pod?.startsWith(app) || l.container === app) && (!ns || l.namespace === ns)
  );
  if (!log) return [];
  const lines = log.content.split("\n");
  const matched: string[] = [];
  for (const line of lines) {
    if (patterns.some((p) => p.test(line))) {
      matched.push(line.trim());
      if (matched.length >= 4) break;
    }
  }
  if (!matched.length) return [];
  return [{ source: log.path, excerpt: truncate(matched.join("\n"), 500) }];
}
