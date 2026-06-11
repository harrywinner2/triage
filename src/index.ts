import fs from "node:fs";
import path from "node:path";
import { createServer } from "./server";
import { initStore } from "./store";

// Load .env in development without adding a dependency (production uses real env vars).
loadDotEnv();

initStore();

const port = Number(process.env.PORT) || 3000;
createServer().listen(port, () => {
  const ai = process.env.OPENAI_API_KEY ? "on" : "off (deterministic only)";
  console.log(`[triage] listening on http://localhost:${port}  ·  AI reasoning: ${ai}`);
});

function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
