/**
 * verify.mjs — drive a Triage instance in a real browser and assert the core
 * flows work. Used for live-verify after deploy and locally before pushing.
 *
 *   BASE_URL=https://your-app.up.railway.app node scripts/verify.mjs
 *   node scripts/verify.mjs           # defaults to http://localhost:3000
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const results = [];
const ok = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(20000);

try {
  // 1. App loads
  await page.goto(BASE, { waitUntil: "networkidle" });
  ok("home page loads", await page.locator(".brand").first().isVisible());

  // 2. health endpoint
  const health = await page.evaluate(async () => (await fetch("/api/health")).json());
  ok("health endpoint", health.ok === true, `aiConfigured=${health.aiConfigured}`);

  // 3. Analyze the sample bundle
  await page.getByRole("button", { name: /Analyze sample bundle/i }).click();
  await page.waitForSelector("#page-report.active", { timeout: 30000 });
  const headline = (await page.locator("#v-head").textContent())?.trim();
  ok("sample analysis renders report", !!headline, headline);

  // 4. Findings present
  await page.locator('#report-tabs .tab[data-tab="findings"]').click();
  await page.waitForTimeout(300);
  const findingCount = await page.locator("#findings-list .finding").count();
  ok("findings detected", findingCount >= 4, `${findingCount} findings`);

  // 5. Evidence present in an expanded finding
  await page.locator("#findings-list .finding .fh").first().click();
  await page.waitForTimeout(200);
  const evidence = await page.locator("#findings-list .finding.open .evid").count();
  ok("findings carry evidence", evidence >= 1, `${evidence} excerpts`);

  // 6. AI summary or deterministic banner
  await page.locator('#report-tabs .tab[data-tab="summary"]').click();
  const summaryText = (await page.locator("#ai-summary").textContent()) || "";
  ok("summary populated", summaryText.length > 40, `${summaryText.length} chars`);

  // 7. Remediation
  await page.locator('#report-tabs .tab[data-tab="remediation"]').click();
  await page.waitForTimeout(200);
  const steps = await page.locator("#remediation-list .remstep").count();
  ok("remediation plan present", steps >= 1, `${steps} steps`);

  // 8. Cluster tab nodes
  await page.locator('#report-tabs .tab[data-tab="cluster"]').click();
  await page.waitForTimeout(200);
  const nodeRows = await page.locator("#nodes-table tbody tr").count();
  ok("cluster nodes listed", nodeRows >= 1, `${nodeRows} nodes`);

  // 9. Healthy bundle → healthy verdict
  await page.locator('.navlink[data-nav="upload"]').click();
  await page.getByRole("button", { name: /Analyze a healthy bundle/i }).click();
  await page.waitForSelector("#page-report.active");
  await page.waitForTimeout(500);
  const healthyHead = (await page.locator("#v-head").textContent()) || "";
  ok("healthy bundle → healthy verdict", /healthy/i.test(healthyHead), healthyHead);

  // 10. History lists runs
  await page.locator('.navlink[data-nav="history"]').click();
  await page.waitForTimeout(400);
  const historyRows = await page.locator("#history-table tbody tr").count();
  ok("history lists analyses", historyRows >= 1, `${historyRows} rows`);
} catch (err) {
  ok("run completed without exception", false, err.message);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed against ${BASE}`);
process.exit(failed.length ? 1 : 0);
