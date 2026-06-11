import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { analyzeBundle } from "../src/analyze";
import { Analysis } from "../src/types";

const SAMPLE = path.resolve(__dirname, "../samples/sample-support-bundle.tar.gz");
const HEALTHY = path.resolve(__dirname, "../samples/healthy-support-bundle.tar.gz");

// Tests run without OPENAI_API_KEY, so the deterministic path is exercised — fast and offline.
const detectors = (a: Analysis) => a.findings.map((f) => f.detector);

describe("analyze: broken acme-shop bundle", () => {
  let a: Analysis;
  beforeAll(async () => {
    delete process.env.OPENAI_API_KEY; // force deterministic path
    a = await analyzeBundle(SAMPLE);
  });

  it("reaches a critical verdict", () => {
    expect(a.verdict.level).toBe("critical");
    expect(a.severityCounts.critical).toBeGreaterThanOrEqual(2);
  });

  it("parses cluster metadata", () => {
    expect(a.meta.clusterVersion).toBe("v1.27.6");
    expect(a.meta.nodeCount).toBe(3);
    expect(a.meta.podCount).toBeGreaterThanOrEqual(9);
    expect(a.meta.failingPods).toBeGreaterThanOrEqual(4);
  });

  it("detects the storage root cause (missing StorageClass)", () => {
    const f = a.findings.find((x) => x.detector === "storage.storageclass-missing");
    expect(f, "missing-storageclass finding").toBeTruthy();
    expect(f!.severity).toBe("critical");
    expect(f!.title).toMatch(/fast-ssd/);
    // affected resources should include the blocked postgres pod
    expect(f!.affectedResources.some((r) => r.name?.includes("postgres"))).toBe(true);
  });

  it("detects the OOMKilled crash loop", () => {
    const f = a.findings.find((x) => x.detector === "workload.oomkilled");
    expect(f, "oomkilled finding").toBeTruthy();
    expect(f!.title).toMatch(/payments-api/);
    expect(f!.severity).toBe("critical");
  });

  it("detects ImagePullBackOff", () => {
    const f = a.findings.find((x) => x.detector === "workload.image-pull");
    expect(f, "image-pull finding").toBeTruthy();
    expect(f!.title).toMatch(/web-frontend/);
  });

  it("detects the misconfigured ConfigMap key", () => {
    const f = a.findings.find((x) => x.detector === "config.missing-key");
    expect(f, "config finding").toBeTruthy();
    expect(f!.title).toMatch(/DATABASE_URL/);
  });

  it("detects the NotReady node", () => {
    const f = a.findings.find((x) => x.detector === "node.notready");
    expect(f, "node finding").toBeTruthy();
    expect(f!.title).toMatch(/node-2/);
  });

  it("flags connection-refused as a low-severity symptom (not a root cause)", () => {
    const f = a.findings.find((x) => x.detector === "logs.connection-refused");
    expect(f, "connection-refused finding").toBeTruthy();
    expect(f!.severity).toBe("low");
  });

  it("gives every finding at least one piece of evidence", () => {
    for (const f of a.findings) {
      expect(f.evidence.length, `evidence for ${f.id} ${f.detector}`).toBeGreaterThanOrEqual(1);
      expect(f.evidence[0].source.length).toBeGreaterThan(0);
    }
  });

  it("assigns stable, severity-ordered finding ids", () => {
    expect(a.findings[0].id).toBe("F-001");
    // first finding should be one of the critical ones
    expect(a.findings[0].severity).toBe("critical");
  });

  it("produces a deterministic report when no API key is set", () => {
    expect(a.aiEnabled).toBe(false);
    expect(a.ai).toBeTruthy();
    expect(a.ai!.summary.length).toBeGreaterThan(40);
    expect(a.ai!.remediation.length).toBeGreaterThanOrEqual(1);
  });
});

describe("analyze: healthy bundle", () => {
  let a: Analysis;
  beforeAll(async () => {
    delete process.env.OPENAI_API_KEY;
    a = await analyzeBundle(HEALTHY);
  });

  it("reaches a healthy (or near-clean) verdict", () => {
    expect(["healthy", "warning"]).toContain(a.verdict.level);
    expect(a.severityCounts.critical).toBe(0);
    expect(a.severityCounts.high).toBe(0);
  });

  it("finds no crash/storage/config failures", () => {
    const d = detectors(a);
    expect(d).not.toContain("storage.storageclass-missing");
    expect(d).not.toContain("workload.oomkilled");
    expect(d).not.toContain("config.missing-key");
  });
});
