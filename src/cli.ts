/**
 * CLI: `npm run analyze -- <bundle.tar.gz> [--json]`
 *
 * Runs the same pipeline as the web app and prints a readable triage report to
 * the terminal (or raw JSON with --json). Reads OPENAI_API_KEY from the env/.env.
 */
import fs from "node:fs";
import path from "node:path";
import { analyzeBundle } from "./analyze";
import { Analysis, Severity } from "./types";

loadDotEnv();

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  orange: "\x1b[33m",
  yellow: "\x1b[93m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};
const sevColor: Record<Severity, string> = {
  critical: C.red,
  high: C.orange,
  medium: C.yellow,
  low: C.blue,
  info: C.gray,
};

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: npm run analyze -- <support-bundle.tar.gz> [--json]");
    process.exit(1);
  }

  const analysis = await analyzeBundle(path.resolve(file));
  if (asJson) {
    process.stdout.write(JSON.stringify(analysis, null, 2));
    return;
  }
  printReport(analysis);
}

function printReport(a: Analysis) {
  const vColor = a.verdict.level === "critical" ? C.red : a.verdict.level === "warning" ? C.yellow : C.green;
  console.log();
  console.log(`${C.bold}${C.cyan}● Triage${C.reset}  ${C.dim}${a.filename}${C.reset}`);
  console.log(`${vColor}${C.bold}${a.verdict.level.toUpperCase()}${C.reset} — ${a.verdict.headline}`);
  console.log(`${C.dim}${a.verdict.sub}${C.reset}`);
  console.log(
    `${C.dim}cluster ${a.meta.clusterVersion ?? "?"} · ${a.meta.nodeCount} nodes · ` +
      `${a.meta.runningPods}/${a.meta.podCount} pods running · AI ${a.aiEnabled ? "on" : "off"}${C.reset}`
  );

  if (a.ai?.summary) {
    console.log(`\n${C.bold}Root cause${C.reset}`);
    console.log(stripMd(a.ai.summary));
  }

  console.log(`\n${C.bold}Findings (${a.findings.length})${C.reset}`);
  for (const f of a.findings) {
    const c = sevColor[f.severity];
    console.log(`${c}${C.bold}[${f.severity.toUpperCase()}]${C.reset} ${C.bold}${f.id}${C.reset} ${f.title}`);
    console.log(`  ${C.dim}${f.summary}${C.reset}`);
    for (const e of f.evidence.slice(0, 1)) {
      console.log(`  ${C.gray}↳ ${e.source}${C.reset}`);
    }
  }

  if (a.ai?.remediation?.length) {
    console.log(`\n${C.bold}Remediation plan${C.reset}`);
    for (const s of a.ai.remediation) {
      console.log(`  ${C.cyan}${s.priority}.${C.reset} ${C.bold}${s.action}${C.reset} ${C.dim}— ${s.rationale}${C.reset}`);
      for (const cmd of s.commands || []) console.log(`     ${C.green}$ ${cmd}${C.reset}`);
    }
  }
  console.log(`\n${C.dim}analyzed in ${a.durationMs}ms${C.reset}\n`);
}

function stripMd(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1").replace(/_/g, "");
}

function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

main().catch((err) => {
  console.error("error:", err?.message || err);
  process.exit(1);
});
