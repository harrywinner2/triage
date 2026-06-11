# Triage — Expanded PRD

*AI triage for Troubleshoot support bundles.* Upload a `.tar.gz` support bundle from [troubleshoot.sh](https://troubleshoot.sh), and Triage parses it, runs a catalog of deterministic Kubernetes failure detectors, then layers an LLM on top to write a grounded root-cause narrative and a prioritized remediation plan.

## Original brief

Replicated's Troubleshoot tool creates archive snapshots of Kubernetes cluster data for remote debugging. An ISV ships a K8s app to a customer who runs it in a disconnected environment; when it breaks, the customer collects a support bundle (logs, cluster state, metrics) and sends it to the vendor, who must debug *without a live system*. Today that analysis is manual: it needs domain expertise, time-consuming correlation across log sources, and knowledge of common K8s/app/infra failure patterns. Most issues are a simple misconfigured value; some take engineers hours. Build a prototype AI system that takes a support bundle as input, analyzes it with AI, and outputs something useful. Judged on **breadth and quality of analysis**, not latency. Deliverables: runnable repo, `MY_APPROACH_AND_THOUGHTS.md` (≤500 words), ~2-min demo video.

## Problem & users

**User:** an ISV support engineer or SRE who just received a customer's support bundle and needs a fast, trustworthy first-pass triage. **Job:** "Tell me what's broken, why, and what to do — with evidence I can verify, since I can't touch the live cluster." **Most important flow:** drop a `.tar.gz` → get a ranked, evidence-cited issue report with an AI root-cause summary and remediation plan in seconds.

## Scope

**In scope**
- Upload a Troubleshoot `.tar.gz` (or analyze the bundled sample) entirely server-side.
- Robust bundle parser: discover and read `cluster-resources/*` JSON, pod logs, `cluster-info`, events, nodes — defensive to layout variation across bundle versions.
- Deterministic detector catalog (the grounded core): pod failures (CrashLoopBackOff, OOMKilled, ImagePull errors, CreateContainerConfigError, Pending/unschedulable), workload replica health, node conditions (NotReady, Memory/Disk/PID pressure), PVC binding, warning-event aggregation, and a log-pattern scanner (panics, OOM, connection-refused, TLS/cert, permission errors, etc.).
- LLM reasoning layer: takes the *extracted facts* (not raw logs) and produces a root-cause narrative, cross-finding correlations, and a prioritized remediation plan. Degrades to a deterministic summary when no API key is set.
- Per-finding evidence: file path + log/snippet excerpt so every claim is verifiable.
- Persisted analysis history; reopen any past report.

**Out of scope** (cut to avoid phantom features)
- No live cluster access, kubectl exec, or remediation execution — read-only analysis of a static bundle.
- No auth/multi-tenant/RBAC; no user accounts.
- No real-time streaming logs; the bundle is a snapshot.
- No bundle redaction/collection (Troubleshoot already does that upstream).
- No multi-bundle diffing (noted as a future idea, not built).

## Screens / routes (demo inventory)

| Route | Screen | Purpose | Key components | Data shown |
|---|---|---|---|---|
| `/` | **Upload** | Entry point; start an analysis | Drag-drop dropzone, "Analyze sample bundle" button, pipeline explainer, progress state | What Triage does; upload control; loading/progress |
| `/report/:id` → `#summary` | **Report · Summary** | The headline verdict + AI root cause | Health verdict banner, bundle metadata strip, AI root-cause narrative, correlations, severity counts | Verdict (Critical/Warning/Healthy), cluster version, node/ns/pod counts, AI summary |
| `#findings` | **Report · Findings** | Ranked list of all detected issues | Severity/category filter, finding cards expandable to evidence + remediation | Each finding: title, severity, category, affected resources, evidence snippets, fix |
| `#remediation` | **Report · Remediation** | Prioritized action plan | Ordered step list with commands/manifests, priority + rationale | AI (or templated) remediation steps tied to findings |
| `#cluster` | **Report · Cluster** | Inventory & health overview | Nodes table (status/conditions), namespace/workload health table | Nodes, namespaces, deployments/statefulsets desired-vs-ready |
| `#evidence` | **Report · Evidence** | Browse the parsed facts that grounded findings | Resource tree / log-excerpt viewer, searchable | Parsed resource summaries + captured log excerpts |
| `/history` | **History** | Reopen prior analyses | Table of analyses with verdict + counts + timestamp | id, filename, verdict, severity counts, analyzed-at |
| `/about` | **About** | How it works + detector catalog + privacy | Pipeline diagram (deterministic→AI), detector list, privacy note | Static explainer content |

The Report is one page with in-page tabs (`#summary`/`#findings`/`#remediation`/`#cluster`/`#evidence`).

## Data model

- **Analysis**: `id`, `filename`, `analyzedAt`, `sizeBytes`, `aiEnabled`, `verdict { level: critical|warning|healthy, headline }`, `meta { clusterVersion, collectedAt, nodeCount, namespaceCount, podCount, runningPods, failingPods }`, `severityCounts {critical,high,medium,low,info}`, `findings: Finding[]`, `ai { summary, rootCauses[], remediation[] } | null`.
- **Finding**: `id`, `detector`, `title`, `severity (critical|high|medium|low|info)`, `category (workload|node|storage|config|network|events|logs|cluster)`, `summary`, `affectedResources: [{kind, namespace, name}]`, `evidence: [{source, excerpt, lineRange?}]`, `remediation`, `docsUrl?`.
- Persistence: JSON-file store under `data/` (one file per analysis + an in-memory index loaded at boot). No native deps; portable to any PaaS. History resets on redeploy without a volume — acceptable for a demo; sample is always re-analyzable.

## AI surface (runtime)

One server-side structured LLM call per analysis (`POST /api/analyze` → after deterministic pass):
- **Input:** a compact, token-bounded *digest* — bundle metadata, every deterministic finding (title/severity/category/affected/evidence-excerpt), workload health table, node conditions, and a capped set of representative log lines. Raw logs are **never** dumped wholesale; the digest is sampled and truncated to stay within budget.
- **System prompt intent:** "You are a senior Kubernetes support/SRE engineer doing first-pass triage of a support bundle. Reason only from the supplied evidence; cite findings by id; do not invent resources. Identify the most likely root cause(s), correlate related findings into causal chains, and give a prioritized, concrete remediation plan."
- **Output shape (JSON mode):** `{ summary: markdown, rootCauses: [{title, confidence, reasoning, relatedFindingIds[]}], remediation: [{priority, action, rationale, commands?[]}] }`.
- **Renders:** Summary tab (narrative + correlations) and Remediation tab.
- **Degradation:** no `OPENAI_API_KEY` → skip the call, synthesize a deterministic summary + remediation from finding metadata, set `aiEnabled=false`, and surface a banner explaining how to enable AI.
- Model via `OPENAI_MODEL` (default `gpt-4o-mini`); key read server-side from env only — the browser never sees it.

## External integrations

- **OpenAI Chat Completions** (the only external call; optional). Nothing else — analysis is fully local file processing.

## Acceptance criteria

1. Uploading a `.tar.gz` (or clicking "Analyze sample") returns a report with a verdict and ≥1 finding.
2. The synthesized sample bundle surfaces its planted issues: OOMKilled, ImagePullBackOff, unbound PVC / Pending pod, CreateContainerConfigError (misconfig), a NotReady node, and cascading connection-refused log errors.
3. Every finding shows at least one evidence excerpt with its source path.
4. With a key set, the Summary tab shows an AI root-cause narrative that correlates findings; with no key, a deterministic summary renders and a banner explains AI is off.
5. Findings are filterable by severity and category; severity counts match the list.
6. History lists the analysis and the report reopens from it.
7. The deployed live URL performs 1–5 end-to-end in a browser.

## Open questions

None that block architecture. (Future, not built: multi-bundle diffing, a detector-rule DSL, and ingesting Troubleshoot's own `analysis.json` analyzers as additional signal — the parser reads it when present but the catalog doesn't yet depend on it.)
