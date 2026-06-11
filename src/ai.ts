import {
  AIReport,
  BundleMeta,
  Finding,
  RemediationStep,
  RootCause,
  SEVERITY_RANK,
  WorkloadRow,
} from "./types";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export interface DigestInput {
  meta: BundleMeta;
  findings: Finding[];
  workloads: WorkloadRow[];
  nodes: { name: string; status: string; pressure: string }[];
  logSamples: string[];
}

const SYSTEM_PROMPT = `You are a senior Kubernetes support / SRE engineer doing first-pass triage of a Troubleshoot support bundle. You are given STRUCTURED FACTS already extracted from the bundle by deterministic detectors — you do NOT see the raw archive.

Rules:
- Reason ONLY from the supplied evidence. Do not invent resources, namespaces, versions, or numbers.
- Cite findings by their id (e.g. F-001) in relatedFindingIds.
- Identify the most likely ROOT CAUSE(S) and correlate related findings into causal chains. Distinguish true root causes from downstream symptoms (e.g. "connection refused" is usually a symptom of a dependency being down).
- Be concrete and actionable. Prefer specific kubectl commands or manifest changes.
- Keep it tight: a support engineer should grasp the situation in under a minute.

Return ONLY JSON matching this shape:
{
  "summary": "markdown string: 1-3 short paragraphs. Use **bold** for resource names and the headline root cause.",
  "rootCauses": [{"title": "...", "confidence": "high|medium|low", "reasoning": "why the evidence points here", "relatedFindingIds": ["F-001"]}],
  "remediation": [{"priority": 1, "action": "short imperative", "rationale": "why / impact", "commands": ["kubectl ..."]}]
}`;

/**
 * Run the LLM reasoning layer. Returns null when no API key is configured or the
 * call fails — the caller then falls back to a deterministic report.
 */
export async function generateAIReport(digest: DigestInput): Promise<AIReport | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(digest) },
        ],
      }),
    });
    if (!res.ok) {
      console.error(`[triage] OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    return normalize(JSON.parse(content));
  } catch (err) {
    console.error("[triage] AI reasoning failed:", (err as Error)?.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Coerce/validate the model's JSON into a well-formed AIReport. */
function normalize(raw: any): AIReport {
  const rootCauses: RootCause[] = Array.isArray(raw?.rootCauses)
    ? raw.rootCauses.slice(0, 6).map((r: any) => ({
        title: String(r?.title ?? "Unspecified"),
        confidence: ["high", "medium", "low"].includes(r?.confidence) ? r.confidence : "medium",
        reasoning: String(r?.reasoning ?? ""),
        relatedFindingIds: Array.isArray(r?.relatedFindingIds) ? r.relatedFindingIds.map(String) : [],
      }))
    : [];
  const remediation: RemediationStep[] = Array.isArray(raw?.remediation)
    ? raw.remediation.slice(0, 12).map((s: any, i: number) => ({
        priority: Number.isFinite(s?.priority) ? Number(s.priority) : i + 1,
        action: String(s?.action ?? ""),
        rationale: String(s?.rationale ?? ""),
        commands: Array.isArray(s?.commands) ? s.commands.map(String) : undefined,
      }))
    : [];
  return { summary: String(raw?.summary ?? ""), rootCauses, remediation };
}

/**
 * Deterministic report used when the LLM is unavailable. It's intentionally
 * useful on its own — built entirely from the detector findings — so the product
 * is never a blank page without an API key.
 */
export function deterministicReport(findings: Finding[], meta: BundleMeta): AIReport {
  const sorted = [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const top = sorted.filter((f) => f.severity === "critical" || f.severity === "high");

  const counts = sorted.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {});
  const countPhrase =
    Object.entries(counts)
      .map(([s, n]) => `${n} ${s}`)
      .join(", ") || "no issues";

  const summary =
    findings.length === 0
      ? `No problems were detected across ${meta.nodeCount} node(s) and ${meta.podCount} pod(s). The bundle looks healthy.`
      : `Detected **${findings.length} issue(s)** (${countPhrase}) across ${meta.nodeCount} node(s) and ${meta.podCount} pod(s).` +
        (top.length
          ? ` The most severe is **${top[0].title}**. ` +
            (top.length > 1 ? `Other high-impact findings: ${top.slice(1, 3).map((f) => f.title).join("; ")}.` : "")
          : "") +
        `\n\n_AI reasoning is off — this is a deterministic summary built from the detectors. Set OPENAI_API_KEY to enable correlated root-cause analysis._`;

  const rootCauses: RootCause[] = top.slice(0, 3).map((f) => ({
    title: f.title,
    confidence: f.severity === "critical" ? "high" : "medium",
    reasoning: f.summary,
    relatedFindingIds: [f.id],
  }));

  const remediation: RemediationStep[] = sorted.slice(0, 8).map((f, i) => ({
    priority: i + 1,
    action: f.remediation.split(".")[0] + ".",
    rationale: f.title,
    commands: undefined,
  }));

  return { summary, rootCauses, remediation };
}
