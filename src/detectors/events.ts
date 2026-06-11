import { ParsedBundle } from "../bundle/parse";
import { DraftFinding, truncate } from "./util";

/**
 * Aggregate Warning events across the cluster into a single digest finding. This
 * is supporting signal — the specific detectors already own the high-severity
 * cases — but the volume and spread of warnings is useful triage context.
 */
export function detectEvents(b: ParsedBundle): DraftFinding[] {
  const warnings = b.events.filter((e) => e.type === "Warning");
  if (warnings.length === 0) return [];

  const byReason = new Map<string, { count: number; sample: string }>();
  for (const e of warnings) {
    const r = e.reason || "Unknown";
    const cur = byReason.get(r) || { count: 0, sample: e.message || "" };
    cur.count += e.count ?? 1;
    byReason.set(r, cur);
  }

  const ranked = [...byReason.entries()].sort((a, b) => b[1].count - a[1].count);
  const highSignal = ranked.some(([r]) =>
    /FailedScheduling|ProvisioningFailed|FailedMount|FailedCreate/.test(r)
  );
  const total = ranked.reduce((n, [, v]) => n + v.count, 0);

  return [
    {
      detector: "events.warning-summary",
      severity: highSignal ? "medium" : "low",
      category: "events",
      title: `${total} warning events across the cluster (${ranked.length} distinct reasons)`,
      summary:
        `Top reasons: ${ranked
          .slice(0, 5)
          .map(([r, v]) => `${r} (×${v.count})`)
          .join(", ")}. Warning events corroborate the specific findings above and show how often each issue is recurring.`,
      affectedResources: [],
      evidence: [
        {
          source: "cluster-resources/events",
          excerpt: truncate(
            ranked
              .slice(0, 8)
              .map(([r, v]) => `${r}  ×${v.count}  e.g. ${truncate(v.sample, 90)}`)
              .join("\n"),
            700
          ),
        },
      ],
      remediation:
        "Use the breakdown to prioritise: scheduling/provisioning warnings point at infrastructure; BackOff/Unhealthy point at the workloads flagged above.",
      docsUrl: null,
    },
  ];
}
