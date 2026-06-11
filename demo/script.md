# Triage — demo script (~5 minutes)

Spoken narration in plain prose; `[ACTION]` lines are the on-screen step driven on the **live** site. Each beat becomes one narration clip + one screen capture, matched in length during assembly.

Target runtime ≈ 5:00. Speaking pace ~140 wpm.

---

### Beat 1 — The problem (~35s)
[ACTION] Land on the Triage home / Analyze page. Slow scroll over the three-step pipeline.

> When a vendor ships a Kubernetes app into a customer's locked-down environment, and it breaks, they have a real problem: they can't touch the cluster. All they get is a support bundle — a tarball of logs, events, and cluster state — and they have to figure out what went wrong in a system they've never seen. Today that's a manual slog: it takes deep Kubernetes expertise and a lot of time correlating signals by hand. This is Triage. It does that first pass automatically.

### Beat 2 — Kick off an analysis (~25s)
[ACTION] Click **Analyze sample bundle**. Let the progress bar run through extract → parse → detect → correlate.

> I'll run it against a sample support bundle from a fictional store called acme-shop. Triage extracts the archive, parses the cluster resources and logs, runs its failure detectors, and then asks an LLM to make sense of what it found. It finishes in about a second.

### Beat 3 — The verdict (~30s)
[ACTION] Report loads on the Summary tab. Hover the red verdict banner and the metadata strip.

> Right away we get a verdict: critical. The headline isn't a generic "errors found" — it names the actual root cause. Up top we can see the cluster version, node count, and that eight of twenty-one pods are failing. So something is broadly wrong.

### Beat 4 — AI root cause & the cascade (~70s)
[ACTION] Read the AI summary. Scroll to the "Most likely root causes" cards, point at the related finding ids.

> Here's where it gets interesting. The AI summary explains that this isn't eight separate problems — it's one root cause with a cascade. A Postgres database can't start because its storage claim asks for a StorageClass called fast-ssd that doesn't exist in the cluster. With no database, the checkout and payments services flood their logs with "connection refused." Those connection errors are symptoms, not bugs — and Triage says so explicitly. It separates the one thing you need to fix from the noise it produces. Below that, it lists the most likely root causes with a confidence level and the exact findings each one is based on. Nothing here is invented — every claim traces back to evidence.

### Beat 5 — Findings & evidence (~85s)
[ACTION] Click the **Findings** tab. Expand "PVC unbound — StorageClass fast-ssd does not exist"; show the evidence excerpts and source paths. Collapse it, expand "payments-api OOMKilled"; show the pod status excerpt and the Java OutOfMemoryError log line. Then click a severity chip and a category chip to filter.

> The Findings tab is the detail. Every finding is ranked by severity and tagged by category. Let's open the storage one — it shows the PVC stuck Pending, the missing StorageClass confirmed against what's actually in the cluster, and the scheduling event, each with the file it came from. This is the part that earns trust: when you can't log into the system, the tool has to show its work. Here's a second, independent issue — payments-api is being OOM-killed in a crash loop. The evidence is the container status with exit code 137 and a Java heap OutOfMemoryError straight from the pod log. And I can filter — by severity, or by category — to focus on just the critical structural problems and hide the symptom-level log noise.

### Beat 6 — Remediation plan (~40s)
[ACTION] Click the **Remediation** tab. Scroll through the prioritized steps and their commands.

> The Remediation tab turns that into an ordered plan. Fix the storage first — it's the highest-impact change and it clears the downstream connection errors for free. Then raise the payments memory limit and bound the JVM heap. Each step has a rationale and concrete kubectl commands. This is what you'd hand to whoever's on call.

### Beat 7 — Cluster & evidence views (~30s)
[ACTION] Click **Cluster** tab — show the nodes table with node-2 NotReady and the workloads readiness table. Click **Evidence** tab briefly.

> The Cluster tab gives the inventory view — here's node-2, NotReady and under memory and disk pressure, and the workloads with their ready-versus-desired counts. And the Evidence tab is every raw excerpt the report was built from, in one place.

### Beat 8 — Healthy contrast & history (~35s)
[ACTION] Go to **Analyze**, click **Analyze a healthy bundle** → show the green verdict. Then open **History** and show both runs listed.

> To show it's not just crying wolf — here's the same tool on a healthy bundle. Green verdict, no issues. And every analysis is saved to History, so you can reopen any past report.

### Beat 9 — Wrap (~30s)
[ACTION] Return to the report Summary. Slow zoom-out / hold.

> That's Triage. The design bet is simple: deterministic detectors do the grounded, precise work and cite their evidence; the LLM does the correlation and the writing, but only over facts the detectors already found — so it can't hallucinate. It runs with or without an API key. Next steps would be a rule DSL so engineers can codify fixes once, and diffing two bundles to localize regressions. Thanks for watching.
