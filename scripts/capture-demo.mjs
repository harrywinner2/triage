/**
 * capture-demo.mjs — drive the live app through the demo script and record one
 * video clip per narration beat, each paced to its narration length from
 * demo/audio/manifest.json. Clips land in demo/clips/clip_00N.webm for
 * assemble_video.sh to stitch with the matching audio.
 *
 *   BASE_URL=https://your-app.up.railway.app node scripts/capture-demo.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const CLIPS = "demo/clips";
const MANIFEST = "demo/audio/manifest.json";
const VW = 1600, VH = 1000;

fs.mkdirSync(CLIPS, { recursive: true });
const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, "utf8")) : [];
const durOf = (id) => {
  const b = manifest.find((m) => m.id === id);
  return b ? Math.max(b.seconds + 0.6, 4) : 7;
};
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

const browser = await chromium.launch();

// Ensure a sample analysis is persisted server-side so report beats can open instantly.
{
  const p = await browser.newPage();
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.evaluate(async () => {
    await fetch("/api/analyze-sample", { method: "POST" });
  });
  await p.close();
}

async function openReport(page) {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const rows = await (await fetch("/api/analyses")).json();
    const broken = rows.find((r) => r.level === "critical") || rows[0];
    if (broken) await loadAnalysis(broken.id);
  });
  await page.waitForSelector("#page-report.active", { timeout: 20000 });
}
const tab = (page, name) => page.locator(`#report-tabs .tab[data-tab="${name}"]`).click();

async function beat(id, fn) {
  const ctx = await browser.newContext({
    viewport: { width: VW, height: VH },
    recordVideo: { dir: CLIPS, size: { width: VW, height: VH } },
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const seconds = durOf(id);
  const start = Date.now();
  try {
    await fn(page, seconds);
  } catch (e) {
    console.error(`  beat ${id} action error: ${e.message}`);
  }
  const elapsed = (Date.now() - start) / 1000;
  if (elapsed < seconds) await sleep(seconds - elapsed);
  const video = page.video();
  await ctx.close();
  const src = await video.path();
  const dest = path.join(CLIPS, `clip_${String(id).padStart(3, "0")}.webm`);
  fs.renameSync(src, dest);
  console.log(`✓ clip ${String(id).padStart(3, "0")}  ${seconds.toFixed(1)}s`);
}

/* --------------------------- beats --------------------------- */

await beat(1, async (page, s) => {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(Math.min(3, s / 3));
  await page.locator(".pipe").scrollIntoViewIfNeeded();
});

await beat(2, async (page) => {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(1);
  await page.getByRole("button", { name: /Analyze sample bundle/i }).click();
  await page.waitForSelector("#page-report.active", { timeout: 30000 });
});

await beat(3, async (page) => {
  await openReport(page);
  await tab(page, "summary");
  await sleep(1);
  await page.locator("#meta").scrollIntoViewIfNeeded();
});

await beat(4, async (page, s) => {
  await openReport(page);
  await tab(page, "summary");
  await sleep(1);
  await page.locator("#ai-summary").scrollIntoViewIfNeeded();
  await sleep(s / 2);
  await page.locator("#ai-rootcauses").scrollIntoViewIfNeeded();
});

await beat(5, async (page, s) => {
  await openReport(page);
  await tab(page, "findings");
  await sleep(1);
  const storage = page.locator(".finding", { hasText: /StorageClass|PVC/ }).first();
  await storage.locator(".fh").click();
  await sleep(2);
  await storage.locator(".evid").first().scrollIntoViewIfNeeded();
  await sleep(Math.max(2, s * 0.25));
  await storage.locator(".fh").click(); // collapse
  const oom = page.locator(".finding", { hasText: /OOMKilled|memory/i }).first();
  await oom.locator(".fh").click();
  await sleep(2);
  await oom.locator(".evid").first().scrollIntoViewIfNeeded();
  await sleep(2);
  // filter demo
  await page.locator('#sev-filters .chip[data-sev="low"]').click().catch(() => {});
  await sleep(1.5);
  await page.locator('#sev-filters .chip[data-sev="info"]').click().catch(() => {});
});

await beat(6, async (page) => {
  await openReport(page);
  await tab(page, "remediation");
  await sleep(1.5);
  await page.locator("#remediation-list").scrollIntoViewIfNeeded();
});

await beat(7, async (page, s) => {
  await openReport(page);
  await tab(page, "cluster");
  await sleep(1.5);
  await page.locator("#workloads-table").scrollIntoViewIfNeeded();
  await sleep(Math.max(2, s * 0.4));
  await tab(page, "evidence");
});

await beat(8, async (page) => {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(0.8);
  await page.getByRole("button", { name: /Analyze a healthy bundle/i }).click();
  await page.waitForSelector("#page-report.active", { timeout: 30000 });
  await sleep(2.5);
  await page.locator('.navlink[data-nav="history"]').click();
  await sleep(1.5);
});

await beat(9, async (page) => {
  await openReport(page);
  await tab(page, "summary");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
});

await browser.close();
console.log(`\nWrote ${manifest.length || 9} clips to ${CLIPS}`);
