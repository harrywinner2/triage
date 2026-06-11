# Build Log — Triage

One line per meaningful decision or phase transition. This is the running record so the run can proceed without interrupting the user.

- **Intake** — PRD: Replicated "Automated Technical Artifact Analysis". Decisions: web app form, deploy to Railway, synthesize a realistic support bundle. AI key not provided at intake → app architected dual-mode (deterministic detectors always on; OpenAI reasoning layer when `OPENAI_API_KEY` is set). Key flagged as the one thing needed before live demo/video.
- **Preflight** — git/gh(harrywinner2)/node all pass; railway authed (Harry W); vercel authed; ffmpeg present. WARN: no headless-browser MCP → Phase 2 style inferred, Phase 4 verify via HTTP + local Playwright, Phase 5 capture via local Playwright.
- **Phase 1** — Writing expanded PRD: product name "Triage", screen inventory, deterministic+LLM analysis pipeline, data model, AI surface.
- **Secrets** — User provided OpenAI key mid-run. Written to untracked `.env` (mode 600, git-ignored, verified via `git check-ignore`). `.env.example` tracked with placeholders. AI reasoning layer now live; will set as Railway secret at deploy. User to rotate after evaluation.
