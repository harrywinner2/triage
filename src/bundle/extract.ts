import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);

export interface ExtractedBundle {
  /** Directory that contains the bundle contents (the support-bundle root). */
  root: string;
  /** Temp directory to remove when done. */
  tmpDir: string;
  cleanup: () => void;
}

/**
 * Extract a Troubleshoot `.tar.gz` to a temp directory using the system `tar`.
 *
 * Troubleshoot bundles normally contain a single top-level directory
 * (`support-bundle-<timestamp>/`). We descend into it so callers see the
 * resource tree directly, but tolerate flat archives too.
 */
export async function extractBundle(archivePath: string): Promise<ExtractedBundle> {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`bundle not found: ${archivePath}`);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "triage-"));
  try {
    await exec("tar", ["-xzf", archivePath, "-C", tmpDir], { maxBuffer: 1024 * 1024 * 64 });
  } catch (err: any) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`failed to extract bundle: ${err?.message ?? err}`);
  }

  const root = resolveRoot(tmpDir);
  return {
    root,
    tmpDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/** If the archive unpacked into a single wrapper directory, use that as the root. */
function resolveRoot(tmpDir: string): string {
  const entries = fs.readdirSync(tmpDir, { withFileTypes: true }).filter((e) => !e.name.startsWith("."));
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(tmpDir, entries[0].name);
  }
  return tmpDir;
}
