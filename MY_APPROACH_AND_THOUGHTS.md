# My Approach & Thoughts

## The core bet: don't ask an LLM to read the archive

A support bundle is large, repetitive, and mostly noise. Dumping it into a model is slow, expensive, and — worse — invites hallucination: a plausible-sounding root cause with no evidence behind it. The thing a support engineer actually distrusts.

So Triage splits the job in two:

1. **A deterministic detector core** parses the bundle and finds known Kubernetes failure signals — OOMKills, crash loops, image-pull errors, unbound PVCs, `CreateContainerConfigError`, node pressure, warning-event spikes, and log patterns. Each detector emits a finding with a severity, the affected resources, and an **evidence excerpt with its source path**. Nothing is asserted without a citation.
2. **An LLM reasoning layer** receives the *extracted findings* — not the raw logs — and does what it's genuinely good at: correlating them into causal chains, naming the most likely root cause, separating cause from symptom, and writing a prioritized fix plan. Grounded in facts, it can't invent a pod that isn't there.

The deterministic layer is precision and trust; the LLM is synthesis and narrative. With no API key, the detectors still produce a full report — the product is never a blank page.

## Why this fits the domain

Most bundles are, as the brief says, "a misconfigured value." Detectors nail those instantly and cheaply. The hard cases are the cascades: a missing `fast-ssd` StorageClass leaves Postgres `Pending`, so every app logs `connection refused`. A naive scan flags ten "errors"; the valuable output is *one root cause and nine symptoms*. That correlation is exactly where the LLM earns its place — and where I focused the synthesized sample bundle, which plants a storage→DB→app cascade alongside independent OOM, image-pull, and node faults.

## Design choices I'd defend

- **Layout-tolerant parsing.** Rather than hard-coding paths, the parser buckets every JSON object by its Kubernetes `kind`, so it survives version drift between bundle formats.
- **Evidence-first UI.** Every finding links to the file and snippet it came from. A triage tool that can't show its work won't be trusted on a system you can't log into.
- **Modest severities for symptoms.** Log-pattern findings (connection-refused) rank *below* structural ones on purpose, so the root cause floats to the top.

## What I'd build next

- A **detector-rule DSL** so support engineers can codify a fix the moment they diagnose it once — turning tribal knowledge into a reusable check.
- **Multi-bundle diffing** ("what changed since the last healthy capture?"), which often localizes a regression faster than any single snapshot.
- Feeding Troubleshoot's own `analysis.json` analyzers in as additional signal (the parser already reads it).

## Honest limitations

It's a static snapshot — no live cluster to probe, so some root causes are "most likely," not proven. The catalog covers common failures, not every one. The LLM is a second opinion, not gospel. But for first-pass triage, grounding the model in extracted evidence is the right shape.
