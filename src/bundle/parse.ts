import fs from "node:fs";
import path from "node:path";

/** A generic Kubernetes object. We avoid strict typing because bundle contents vary. */
export interface K8sObject {
  apiVersion?: string;
  kind?: string;
  metadata?: any;
  spec?: any;
  status?: any;
  data?: any;
  involvedObject?: any;
  [k: string]: any;
}

export interface LogFile {
  /** Path relative to the bundle root. */
  path: string;
  namespace?: string;
  pod?: string;
  container?: string;
  content: string;
}

export interface ParsedBundle {
  root: string;
  /** lowercased Kind -> objects (e.g. "pod", "deployment", "node", "event"). */
  byKind: Record<string, K8sObject[]>;
  events: K8sObject[];
  logs: LogFile[];
  clusterVersion: string | null;
  collectedAt: string | null;
  /** Every file path discovered, relative to root (for transparency / debugging). */
  files: string[];
}

const MAX_LOG_BYTES = 2 * 1024 * 1024; // cap per-log read so a giant log can't blow up memory

/**
 * Walk an extracted bundle and build a queryable model.
 *
 * The parser is deliberately layout-tolerant: rather than hard-coding paths it
 * parses every JSON file and buckets objects by their Kubernetes `kind`. List
 * objects (`PodList`, `EventList`, ...) are expanded and, because items in a
 * `kubectl -o json` list don't carry their own `kind`, the item kind is inferred
 * from the list kind (and the directory name as a fallback).
 */
export function parseBundle(root: string): ParsedBundle {
  const files = walk(root);
  const byKind: Record<string, K8sObject[]> = {};
  const logs: LogFile[] = [];

  const push = (kind: string | undefined, obj: K8sObject, dirHint?: string) => {
    const k = (kind || obj.kind || singularFromDir(dirHint) || "unknown").toLowerCase();
    (byKind[k] ||= []).push(obj);
  };

  for (const abs of files) {
    const rel = path.relative(root, abs);
    const lower = rel.toLowerCase();

    if (lower.endsWith(".log") || isLogPath(rel)) {
      logs.push(readLog(root, abs, rel));
      continue;
    }
    if (!lower.endsWith(".json")) continue;

    let data: any;
    try {
      data = JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch {
      continue; // skip unparseable JSON rather than failing the whole analysis
    }

    const dirHint = path.basename(path.dirname(rel));
    if (data && Array.isArray(data.items)) {
      const itemKind = listItemKind(data.kind) || singularFromDir(dirHint);
      for (const item of data.items) push(item.kind || itemKind, item, dirHint);
    } else if (data && data.kind) {
      push(data.kind, data, dirHint);
    }
  }

  return {
    root,
    byKind,
    events: byKind["event"] || [],
    logs,
    clusterVersion: readClusterVersion(root),
    collectedAt: deriveCollectedAt(root, byKind["event"] || []),
    files: files.map((f) => path.relative(root, f)),
  };
}

/* ----------------------------- helpers ----------------------------- */

export function getByKind(b: ParsedBundle, kind: string): K8sObject[] {
  return b.byKind[kind.toLowerCase()] || [];
}

/** Find Warning/Normal events that reference a given object. */
export function eventsFor(
  b: ParsedBundle,
  ref: { name?: string; kind?: string; namespace?: string }
): K8sObject[] {
  return b.events.filter((e) => {
    const io = e.involvedObject || {};
    if (ref.name && io.name !== ref.name) return false;
    if (ref.kind && io.kind && io.kind.toLowerCase() !== ref.kind.toLowerCase()) return false;
    if (ref.namespace && io.namespace && io.namespace !== ref.namespace) return false;
    return true;
  });
}

function walk(dir: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile()) acc.push(full);
  }
  return acc;
}

function listItemKind(listKind?: string): string | undefined {
  if (!listKind || !/List$/.test(listKind)) return undefined;
  return listKind.replace(/List$/, "");
}

/** Map a cluster-resources directory name to a singular kind, e.g. "pods" -> "pod". */
function singularFromDir(dir?: string): string | undefined {
  if (!dir) return undefined;
  const map: Record<string, string> = {
    pods: "pod",
    deployments: "deployment",
    statefulsets: "statefulset",
    daemonsets: "daemonset",
    replicasets: "replicaset",
    services: "service",
    events: "event",
    nodes: "node",
    namespaces: "namespace",
    configmaps: "configmap",
    secrets: "secret",
    persistentvolumeclaims: "persistentvolumeclaim",
    persistentvolumes: "persistentvolume",
    "storage-classes": "storageclass",
    ingress: "ingress",
    jobs: "job",
    cronjobs: "cronjob",
  };
  return map[dir.toLowerCase()];
}

/** Logs live under `<namespace>/<pod>/<container>.log`, outside cluster-resources/cluster-info. */
function isLogPath(rel: string): boolean {
  if (/^cluster-(resources|info)\b/i.test(rel)) return false;
  return /\.(log|txt)$/i.test(rel);
}

function readLog(root: string, abs: string, rel: string): LogFile {
  let content = "";
  try {
    const fd = fs.openSync(abs, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, MAX_LOG_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    content = buf.toString("utf8");
    if (size > MAX_LOG_BYTES) content += `\n…[truncated ${size - MAX_LOG_BYTES} bytes]`;
  } catch {
    /* unreadable log */
  }
  const parts = rel.split(path.sep);
  // Typical layout: <namespace>/<pod>/<container>.log
  const namespace = parts.length >= 3 ? parts[parts.length - 3] : undefined;
  const pod = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  const container = path.basename(rel).replace(/\.(log|txt)$/i, "");
  return { path: rel, namespace, pod, container, content };
}

function readClusterVersion(root: string): string | null {
  const candidates = [
    "cluster-info/cluster_version.json",
    "cluster-resources/cluster_version.json",
  ];
  for (const c of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(root, c), "utf8"));
      const v = data?.serverVersion?.gitVersion;
      if (v) return v;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Best-effort collection timestamp: version.yaml hint, else newest event timestamp. */
function deriveCollectedAt(root: string, events: K8sObject[]): string | null {
  try {
    const yaml = fs.readFileSync(path.join(root, "version.yaml"), "utf8");
    const m = yaml.match(/\d{4}-\d{2}-\d{2}T[\d:]+Z/);
    if (m) return m[0];
  } catch {
    /* no version.yaml */
  }
  let latest: string | null = null;
  for (const e of events) {
    const t = e.lastTimestamp || e.eventTime || e.firstTimestamp;
    if (t && (!latest || t > latest)) latest = t;
  }
  return latest;
}
