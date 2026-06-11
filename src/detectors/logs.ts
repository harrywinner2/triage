import { ParsedBundle } from "../bundle/parse";
import { DraftFinding, truncate } from "./util";
import { Severity, Category } from "../types";

interface Pattern {
  id: string;
  re: RegExp;
  severity: Severity;
  category: Category;
  title: string;
  summary: string;
  remediation: string;
  docsUrl?: string | null;
}

/**
 * Log-pattern catalog. Severities are deliberately modest: log lines are usually
 * *symptoms*, and we don't want them to outrank the structural root-cause findings.
 * Connection-refused in particular is kept low because it is typically downstream
 * of a service being down.
 */
const PATTERNS: Pattern[] = [
  {
    id: "logs.panic",
    re: /\b(panic:|fatal error:|goroutine \d+ \[running\]|stack trace:)/i,
    severity: "high",
    category: "logs",
    title: "Process panic / fatal error in logs",
    summary: "One or more containers logged a panic or fatal error and likely crashed.",
    remediation: "Read the full stack trace around the panic to locate the failing code path.",
  },
  {
    id: "logs.connection-refused",
    re: /connection refused|connect: connection refused|dial tcp .*refused/i,
    severity: "low",
    category: "logs",
    title: "Connection refused to a dependency",
    summary:
      "Services are logging 'connection refused' to a dependency. This is usually a downstream symptom of that dependency being down, not an independent bug.",
    remediation:
      "Identify the target host:port and confirm that service is healthy. These errors typically clear once the dependency recovers.",
  },
  {
    id: "logs.db-connect",
    re: /could not connect to database|FATAL:.*database|connection to .* failed|database is starting up/i,
    severity: "medium",
    category: "logs",
    title: "Database connectivity errors in logs",
    summary: "Application logs show repeated database connection failures.",
    remediation:
      "Confirm the database pod/service is running and reachable, and that credentials and the connection string are correct.",
  },
  {
    id: "logs.tls",
    re: /x509:|tls: |certificate (has expired|is not valid|signed by unknown)/i,
    severity: "medium",
    category: "logs",
    title: "TLS / certificate errors in logs",
    summary: "Containers logged TLS handshake or certificate validation failures.",
    remediation:
      "Check certificate validity dates and the trust chain; rotate or re-issue expired certs and mount the correct CA bundle.",
  },
  {
    id: "logs.permission",
    // Targeted: filesystem EACCES and RBAC-style "is forbidden: User ... cannot",
    // not bare "forbidden" (which matches ordinary HTTP 403 responses).
    re: /permission denied|operation not permitted|\bEACCES\b|is forbidden:/i,
    severity: "medium",
    category: "logs",
    title: "Permission denied errors in logs",
    summary: "Containers logged permission/authorization failures (filesystem, RBAC, or API).",
    remediation:
      "Check the pod's securityContext/fsGroup for filesystem access, and ServiceAccount RBAC for API access.",
  },
];

export function detectLogs(b: ParsedBundle): DraftFinding[] {
  const findings: DraftFinding[] = [];

  for (const p of PATTERNS) {
    const hits: { pod?: string; ns?: string; path: string; count: number; sample: string }[] = [];
    for (const log of b.logs) {
      const lines = log.content.split("\n");
      let count = 0;
      let sample = "";
      for (const line of lines) {
        if (p.re.test(line)) {
          count++;
          if (!sample) sample = line.trim();
        }
      }
      if (count > 0) hits.push({ pod: log.pod, ns: log.namespace, path: log.path, count, sample });
    }
    if (hits.length === 0) continue;

    const totalCount = hits.reduce((n, h) => n + h.count, 0);
    findings.push({
      detector: p.id,
      severity: p.severity,
      category: p.category,
      title: `${p.title} (${totalCount} line${totalCount === 1 ? "" : "s"} across ${hits.length} pod${hits.length === 1 ? "" : "s"})`,
      summary: p.summary,
      affectedResources: hits
        .filter((h) => h.pod)
        .map((h) => ({ kind: "Pod", namespace: h.ns, name: h.pod! })),
      evidence: hits.slice(0, 4).map((h) => ({
        source: h.path,
        excerpt: `${h.sample}${h.count > 1 ? `\n…(${h.count} matching lines)` : ""}`,
      })),
      remediation: p.remediation,
      docsUrl: p.docsUrl ?? null,
    });
  }

  return findings;
}

/** Exported so analyze can include a small set of representative log lines in the AI digest. */
export function sampleLogLines(b: ParsedBundle, perLog = 3, maxLogs = 8): string[] {
  const out: string[] = [];
  for (const log of b.logs.slice(0, maxLogs)) {
    const interesting = log.content
      .split("\n")
      .filter((l) => /error|fatal|panic|exception|warn|refused|killed|oom/i.test(l))
      .slice(0, perLog);
    for (const l of interesting) out.push(truncate(`${log.pod || log.path}: ${l.trim()}`, 160));
  }
  return out;
}
