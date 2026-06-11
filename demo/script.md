# Triage — demo script (~5 minutes)

The spoken narration lives in `beats.json` (one entry per beat) and is voiced with `scripts/tts.py`; `[ACTION]` lines are the on-screen steps driven on the **live** site by `scripts/capture-demo.mjs`. Each beat is one narration clip plus one screen clip, matched in length and stitched by `assemble_video.sh`.

Final runtime ≈ **5:05**. Voice: OpenAI `gpt-4o-mini-tts` (onyx).

---

### Beat 1 — The problem (~44s)
[ACTION] Land on the Analyze page; slow scroll over the three-step pipeline.

> When a software vendor ships a Kubernetes application to a customer, they often give up the one thing they need to debug it: access… All they get is a support bundle — a frozen snapshot of a sick system. This is Triage. It automates that first pass.

### Beat 2 — Kick off an analysis (~33s)
[ACTION] Click **Analyze sample bundle**; watch extract → parse → detect → correlate.

> I'll run it against a sample bundle from acme-shop… It parses every resource and buckets it by its Kubernetes kind, runs a catalog of deterministic detectors, then hands the findings to a language model. It finishes in about a second.

### Beat 3 — The verdict (~25s)
[ACTION] Report loads on Summary; hover the verdict banner and metadata strip.

> The verdict is critical — and it names the actual problem, not just "errors found." Only eight of twenty-one pods are running; thirteen are failing.

### Beat 4 — AI root cause & the cascade (~48s)
[ACTION] Read the AI summary; scroll to the ranked root-cause cards.

> These failures aren't eight separate incidents — they're one root cause with a cascade. A missing `fast-ssd` StorageClass strands Postgres, so the app logs "connection refused." Triage labels those as symptoms, not bugs, and ranks the root causes with confidence and the findings each is based on.

### Beat 5 — Findings & evidence (~47s)
[ACTION] Findings tab; expand the storage finding, then the OOMKilled finding; filter by severity/category.

> The Findings tab is the "prove it." Each finding quotes the exact file path it came from. Here's the storage root cause; here's a separate OOM crash loop with exit code 137 and a Java OOM from the pod log. And I can filter to focus on the structural problems.

### Beat 6 — Remediation plan (~31s)
[ACTION] Remediation tab; scroll the prioritized steps and commands.

> Fix the storage first — it's the highest-impact change and clears the downstream errors for free. Then the memory limit, the image, the config key. Each step has a rationale and concrete kubectl commands.

### Beat 7 — Cluster & evidence views (~22s)
[ACTION] Cluster tab (node-2 NotReady, workloads table); then Evidence tab.

> The Cluster tab is the inventory — node-2 is NotReady under memory and disk pressure. The Evidence tab gathers every raw excerpt the report was built from.

### Beat 8 — Healthy contrast & history (~25s)
[ACTION] Analyze a healthy bundle → green verdict; open History.

> The same tool on a healthy bundle: green, no issues. Triage runs even without an AI key, and every analysis is saved to History.

### Beat 9 — Wrap (~35s)
[ACTION] Return to the report Summary; slow hold.

> The design bet: deterministic detectors cite their evidence; the model reasons only over facts they established — the guardrail against hallucination. Next: a rule language, and bundle-to-bundle diffing. Thanks for watching.
