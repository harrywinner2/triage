#!/usr/bin/env node
/**
 * generate-sample-bundle.mjs
 * ----------------------------------------------------------------------------
 * Generates a realistic troubleshoot.sh support bundle for the triage tool's
 * test/demo fixtures, then tars it to a .tar.gz with the system `tar`.
 *
 * Usage:
 *   node scripts/generate-sample-bundle.mjs            # the "broken" bundle
 *   node scripts/generate-sample-bundle.mjs --healthy  # a clean baseline bundle
 *
 * No npm dependencies — only node:fs, node:path, node:child_process.
 * Output is deterministic (fixed timestamps, uids, and pod hash suffixes).
 *
 * ----------------------------------------------------------------------------
 * PLANTED FAILURE SCENARIOS (broken bundle, namespace `acme-shop`):
 *
 *   1. OOMKilled / CrashLoopBackOff  -> Deployment `payments-api`
 *        Java app OOMs (heap 128Mi), exitCode 137, restartCount 14,
 *        BackOff + Unhealthy(liveness 500) events, heap-dump logs.
 *
 *   2. ImagePullBackOff             -> Deployment `web-frontend`
 *        image registry.acme.internal/web-frontend:v2.4.0 manifest unknown,
 *        ErrImagePull -> ImagePullBackOff, no imagePullSecrets, no app log.
 *
 *   3. Unbound PVC -> Pending pod   -> StatefulSet `postgres`  (ROOT CAUSE)
 *        PVC data-postgres-0 wants storageClass `fast-ssd` which does NOT
 *        exist (only `standard`). PVC Pending, postgres-0 Pending/Unschedulable,
 *        FailedScheduling + ProvisioningFailed events.
 *
 *   4. CreateContainerConfigError   -> Deployment `order-worker`
 *        ConfigMap `order-config` is missing key DATABASE_URL that the
 *        container references via valueFrom; container can't be created.
 *
 *   5. Node NotReady + MemoryPressure -> `node-2`
 *        Ready=Unknown (kubelet stopped posting), MemoryPressure=True,
 *        DiskPressure=True.
 *
 *   6. Cascade: app can't reach DB  -> logs in payments-api / checkout-api
 *        Repeated `dial tcp ...:5432: connect: connection refused` to
 *        postgres.acme-shop.svc.cluster.local — downstream of scenario 3.
 *
 *   Plus a HEALTHY baseline: Deployment `checkout-api` 3/3 ready, normal
 *   kube-system pods (coredns etc.) Running.
 * ----------------------------------------------------------------------------
 */

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

// ----------------------------------------------------------------------------
// Deterministic constants
// ----------------------------------------------------------------------------
const PROJECT_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const SAMPLES_DIR = join(PROJECT_ROOT, "samples");

const NOW = "2026-06-11T14:32:10Z"; // "collection time"
const T_CREATE = "2026-06-09T08:00:00Z"; // resource creation baseline
const T_FIRST = "2026-06-11T13:50:00Z"; // first event timestamp
const T_LAST = "2026-06-11T14:31:55Z"; // last event timestamp

const NAMESPACES = ["acme-shop", "kube-system", "default"];

// ----------------------------------------------------------------------------
// Small JSON / fs helpers
// ----------------------------------------------------------------------------
function write(root, relPath, contents) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function writeJson(root, relPath, obj) {
  write(root, relPath, JSON.stringify(obj, null, 2) + "\n");
}

function list(kind, items) {
  return {
    apiVersion: "v1",
    kind,
    metadata: { resourceVersion: "184213" },
    items,
  };
}

// ----------------------------------------------------------------------------
// Resource builders
// ----------------------------------------------------------------------------
function metadata({ name, namespace, uid, labels = {}, annotations, ownerReferences }) {
  const m = {
    name,
    uid,
    creationTimestamp: T_CREATE,
    labels,
  };
  if (namespace) m.namespace = namespace;
  if (annotations) m.annotations = annotations;
  if (ownerReferences) m.ownerReferences = ownerReferences;
  return m;
}

function node({ name, uid, ready, conditions, kubeletVersion = "v1.27.6" }) {
  return {
    apiVersion: "v1",
    kind: "Node",
    metadata: metadata({
      name,
      uid,
      labels: {
        "kubernetes.io/hostname": name,
        "kubernetes.io/os": "linux",
        "kubernetes.io/arch": "amd64",
        "node.kubernetes.io/instance-type": "m5.xlarge",
      },
    }),
    spec: { podCIDR: "10.244.0.0/24", providerID: `aws:///us-east-1a/${name}` },
    status: {
      capacity: { cpu: "4", "ephemeral-storage": "104846316Ki", memory: "16374648Ki", pods: "110" },
      allocatable: { cpu: "3920m", "ephemeral-storage": "95551679124", memory: "15748856Ki", pods: "110" },
      conditions,
      addresses: [
        { type: "InternalIP", address: `10.0.1.${name.endsWith("1") ? 11 : name.endsWith("2") ? 12 : 13}` },
        { type: "Hostname", address: name },
      ],
      nodeInfo: {
        machineID: uid.replace(/-/g, "").slice(0, 32),
        kernelVersion: "5.15.0-1051-aws",
        osImage: "Ubuntu 22.04.3 LTS",
        containerRuntimeVersion: "containerd://1.7.2",
        kubeletVersion,
        kubeProxyVersion: kubeletVersion,
        operatingSystem: "linux",
        architecture: "amd64",
      },
    },
  };
}

function nodeCondition(type, status, reason, message, { lastHeartbeat = T_LAST, lastTransition = T_CREATE } = {}) {
  return { type, status, reason, message, lastHeartbeatTime: lastHeartbeat, lastTransitionTime: lastTransition };
}

function namespace(name, uid) {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: metadata({ name, uid, labels: { "kubernetes.io/metadata.name": name } }),
    spec: { finalizers: ["kubernetes"] },
    status: { phase: "Active" },
  };
}

function containerStatus({
  name,
  image,
  imageID = "",
  ready,
  restartCount = 0,
  started = ready,
  waiting,
  running,
  terminated,
  lastTerminated,
}) {
  const state = {};
  if (waiting) state.waiting = waiting;
  else if (terminated) state.terminated = terminated;
  else state.running = running || { startedAt: T_CREATE };

  const cs = {
    name,
    image,
    imageID,
    containerID: running || terminated ? "containerd://" + (image.length * 7919).toString(16).padStart(12, "0") : "",
    ready,
    restartCount,
    started,
    state,
  };
  if (lastTerminated) cs.lastState = { terminated: lastTerminated };
  else cs.lastState = {};
  return cs;
}

function pod({
  name,
  namespace: ns,
  uid,
  labels = {},
  nodeName = "node-1",
  phase,
  containers,
  containerStatuses,
  conditions,
  initContainerStatuses,
  ownerReferences,
}) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: metadata({ name, namespace: ns, uid, labels, ownerReferences }),
    spec: {
      nodeName: phase === "Pending" ? undefined : nodeName,
      restartPolicy: "Always",
      terminationGracePeriodSeconds: 30,
      dnsPolicy: "ClusterFirst",
      serviceAccountName: "default",
      containers,
    },
    status: {
      phase,
      conditions:
        conditions ||
        [
          { type: "Initialized", status: "True", lastTransitionTime: T_CREATE },
          { type: "Ready", status: phase === "Running" ? "True" : "False", lastTransitionTime: T_CREATE },
          { type: "ContainersReady", status: phase === "Running" ? "True" : "False", lastTransitionTime: T_CREATE },
          { type: "PodScheduled", status: "True", lastTransitionTime: T_CREATE },
        ],
      hostIP: "10.0.1.11",
      podIP: phase === "Pending" ? undefined : "10.244.0." + (uid.charCodeAt(uid.length - 1) % 200),
      startTime: phase === "Pending" ? undefined : T_CREATE,
      ...(containerStatuses ? { containerStatuses } : {}),
      ...(initContainerStatuses ? { initContainerStatuses } : {}),
    },
  };
}

function container({ name, image, resources, env, envFrom, ports, livenessProbe }) {
  const c = { name, image, imagePullPolicy: "IfNotPresent" };
  if (ports) c.ports = ports;
  if (env) c.env = env;
  if (envFrom) c.envFrom = envFrom;
  if (resources) c.resources = resources;
  if (livenessProbe) c.livenessProbe = livenessProbe;
  c.terminationMessagePath = "/dev/termination-log";
  c.terminationMessagePolicy = "File";
  return c;
}

function deployment({ name, namespace: ns, uid, labels = {}, replicas, status, template }) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: metadata({
      name,
      namespace: ns,
      uid,
      labels,
      annotations: { "deployment.kubernetes.io/revision": "1" },
    }),
    spec: {
      replicas,
      selector: { matchLabels: { app: name } },
      strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } },
      template: template || {
        metadata: { labels: { app: name, ...labels } },
        spec: { containers: [] },
      },
    },
    status: {
      observedGeneration: 1,
      replicas: status.replicas,
      updatedReplicas: status.replicas,
      readyReplicas: status.readyReplicas,
      availableReplicas: status.availableReplicas ?? status.readyReplicas,
      unavailableReplicas: status.unavailableReplicas,
      conditions: status.conditions || [
        {
          type: "Available",
          status: status.readyReplicas > 0 ? "True" : "False",
          reason: status.readyReplicas > 0 ? "MinimumReplicasAvailable" : "MinimumReplicasUnavailable",
          message:
            status.readyReplicas > 0
              ? "Deployment has minimum availability."
              : "Deployment does not have minimum availability.",
          lastTransitionTime: T_CREATE,
          lastUpdateTime: T_LAST,
        },
      ],
    },
  };
}

function statefulSet({ name, namespace: ns, uid, labels = {}, replicas, status, template, volumeClaimTemplates }) {
  return {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: metadata({ name, namespace: ns, uid, labels }),
    spec: {
      replicas,
      serviceName: name,
      selector: { matchLabels: { app: name } },
      podManagementPolicy: "OrderedReady",
      updateStrategy: { type: "RollingUpdate" },
      template,
      volumeClaimTemplates,
    },
    status: {
      observedGeneration: 1,
      replicas: status.replicas,
      readyReplicas: status.readyReplicas,
      currentReplicas: status.replicas,
      updatedReplicas: status.replicas,
      currentRevision: `${name}-7f9c5d8b6`,
      updateRevision: `${name}-7f9c5d8b6`,
    },
  };
}

function replicaSet({ name, namespace: ns, uid, app, replicas, ready }) {
  return {
    apiVersion: "apps/v1",
    kind: "ReplicaSet",
    metadata: metadata({
      name,
      namespace: ns,
      uid,
      labels: { app, "pod-template-hash": name.split("-").pop() },
      ownerReferences: [
        { apiVersion: "apps/v1", kind: "Deployment", name: app, uid: `dep-${app}`, controller: true, blockOwnerDeletion: true },
      ],
    }),
    spec: { replicas, selector: { matchLabels: { app, "pod-template-hash": name.split("-").pop() } } },
    status: { replicas, readyReplicas: ready, availableReplicas: ready, fullyLabeledReplicas: replicas, observedGeneration: 1 },
  };
}

function service({ name, namespace: ns, uid, app, port, targetPort, clusterIP, type = "ClusterIP" }) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: metadata({ name, namespace: ns, uid, labels: { app } }),
    spec: {
      selector: { app },
      type,
      clusterIP,
      clusterIPs: [clusterIP],
      ports: [{ name: "http", protocol: "TCP", port, targetPort }],
      sessionAffinity: "None",
    },
    status: { loadBalancer: {} },
  };
}

function pvc({ name, namespace: ns, uid, storageClassName, storage, phase, volumeName }) {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: metadata({
      name,
      namespace: ns,
      uid,
      labels: { app: "postgres" },
      annotations: { "volume.beta.kubernetes.io/storage-provisioner": "ebs.csi.aws.com" },
    }),
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage } },
      storageClassName,
      volumeMode: "Filesystem",
      ...(volumeName ? { volumeName } : {}),
    },
    status: {
      phase,
      ...(phase === "Bound"
        ? { accessModes: ["ReadWriteOnce"], capacity: { storage } }
        : {}),
    },
  };
}

function pv({ name, uid, storage, storageClassName, claimRef }) {
  return {
    apiVersion: "v1",
    kind: "PersistentVolume",
    metadata: metadata({ name, uid, labels: {} }),
    spec: {
      capacity: { storage },
      accessModes: ["ReadWriteOnce"],
      persistentVolumeReclaimPolicy: "Delete",
      storageClassName,
      volumeMode: "Filesystem",
      csi: { driver: "ebs.csi.aws.com", volumeHandle: "vol-0a1b2c3d4e5f6" },
      ...(claimRef ? { claimRef } : {}),
    },
    status: { phase: claimRef ? "Bound" : "Available" },
  };
}

function storageClass({ name, isDefault = false }) {
  return {
    apiVersion: "storage.k8s.io/v1",
    kind: "StorageClass",
    metadata: metadata({
      name,
      uid: `sc-${name}`,
      labels: {},
      annotations: isDefault ? { "storageclass.kubernetes.io/is-default-class": "true" } : undefined,
    }),
    provisioner: "ebs.csi.aws.com",
    parameters: { type: "gp3", encrypted: "true" },
    reclaimPolicy: "Delete",
    allowVolumeExpansion: true,
    volumeBindingMode: "WaitForFirstConsumer",
  };
}

function configMap({ name, namespace: ns, uid, data }) {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: metadata({ name, namespace: ns, uid, labels: {} }),
    data,
  };
}

function event({
  ns,
  reason,
  message,
  type,
  count,
  involvedObject,
  firstTimestamp = T_FIRST,
  lastTimestamp = T_LAST,
  source = "kubelet",
  host = "node-1",
}) {
  const uid = `evt-${reason}-${involvedObject.name}`.toLowerCase();
  return {
    apiVersion: "v1",
    kind: "Event",
    metadata: {
      name: `${involvedObject.name}.${(reason.length * 31).toString(16)}`,
      namespace: ns,
      uid,
      creationTimestamp: firstTimestamp,
    },
    involvedObject: { apiVersion: "v1", ...involvedObject, namespace: ns },
    reason,
    message,
    type,
    count,
    firstTimestamp,
    lastTimestamp,
    eventTime: null,
    reportingComponent: source === "kubelet" ? "kubelet" : source,
    reportingInstance: source === "kubelet" ? host : "",
    source: source === "kubelet" ? { component: "kubelet", host } : { component: source },
  };
}

// ----------------------------------------------------------------------------
// Log helpers
// ----------------------------------------------------------------------------
const PG_HOST = "postgres.acme-shop.svc.cluster.local";

function ts(secondsOffset) {
  // produce a deterministic ISO-ish timestamp relative to a base
  const base = Date.parse("2026-06-11T14:25:00Z") + secondsOffset * 1000;
  return new Date(base).toISOString().replace("T", " ").replace("Z", "");
}

// ----------------------------------------------------------------------------
// BROKEN BUNDLE
// ----------------------------------------------------------------------------
function generateBrokenBundle(root) {
  writeVersionAndClusterInfo(root, "v1.27.6");

  // ---- nodes -------------------------------------------------------------
  writeJson(
    root,
    "cluster-resources/nodes.json",
    list("NodeList", [
      node({
        name: "node-1",
        uid: "11111111-aaaa-4bbb-8ccc-000000000001",
        conditions: [
          nodeCondition("MemoryPressure", "False", "KubeletHasSufficientMemory", "kubelet has sufficient memory available"),
          nodeCondition("DiskPressure", "False", "KubeletHasNoDiskPressure", "kubelet has no disk pressure"),
          nodeCondition("PIDPressure", "False", "KubeletHasSufficientPID", "kubelet has sufficient PID available"),
          nodeCondition("Ready", "True", "KubeletReady", "kubelet is posting ready status"),
        ],
      }),
      node({
        name: "node-2",
        uid: "22222222-aaaa-4bbb-8ccc-000000000002",
        conditions: [
          nodeCondition("MemoryPressure", "True", "KubeletHasInsufficientMemory", "kubelet has insufficient memory available", {
            lastHeartbeat: "2026-06-11T14:08:30Z",
            lastTransition: "2026-06-11T14:05:00Z",
          }),
          nodeCondition("DiskPressure", "True", "KubeletHasDiskPressure", "kubelet has disk pressure", {
            lastHeartbeat: "2026-06-11T14:08:30Z",
            lastTransition: "2026-06-11T14:06:10Z",
          }),
          nodeCondition("PIDPressure", "False", "KubeletHasSufficientPID", "kubelet has sufficient PID available", {
            lastHeartbeat: "2026-06-11T14:08:30Z",
          }),
          nodeCondition("Ready", "Unknown", "NodeStatusUnknown", "Kubelet stopped posting node status.", {
            lastHeartbeat: "2026-06-11T14:08:30Z",
            lastTransition: "2026-06-11T14:09:45Z",
          }),
        ],
      }),
      node({
        name: "node-3",
        uid: "33333333-aaaa-4bbb-8ccc-000000000003",
        conditions: [
          nodeCondition("MemoryPressure", "False", "KubeletHasSufficientMemory", "kubelet has sufficient memory available"),
          nodeCondition("DiskPressure", "False", "KubeletHasNoDiskPressure", "kubelet has no disk pressure"),
          nodeCondition("PIDPressure", "False", "KubeletHasSufficientPID", "kubelet has sufficient PID available"),
          nodeCondition("Ready", "True", "KubeletReady", "kubelet is posting ready status"),
        ],
      }),
    ])
  );

  writeCommonClusterResources(root);

  // ---- acme-shop pods ----------------------------------------------------
  const acmePods = [];

  // Scenario 1: payments-api OOMKilled / CrashLoopBackOff (3 pods)
  const paymentsHashes = ["payments-api-7c9d8f6b5-2k4lq", "payments-api-7c9d8f6b5-9xv7m", "payments-api-7c9d8f6b5-r8j2p"];
  paymentsHashes.forEach((podName, i) => {
    acmePods.push(
      pod({
        name: podName,
        namespace: "acme-shop",
        uid: `aaaa0001-0000-4000-8000-00000000000${i + 1}`,
        labels: { app: "payments-api", "pod-template-hash": "7c9d8f6b5" },
        nodeName: i === 0 ? "node-1" : "node-3",
        phase: "Running",
        ownerReferences: [
          { apiVersion: "apps/v1", kind: "ReplicaSet", name: "payments-api-7c9d8f6b5", uid: "rs-payments", controller: true },
        ],
        containers: [
          container({
            name: "payments-api",
            image: "registry.acme.internal/payments-api:v1.8.2",
            ports: [{ containerPort: 8080, protocol: "TCP" }],
            env: [{ name: "JAVA_OPTS", value: "-Xmx96m" }, { name: "DB_HOST", value: PG_HOST }],
            resources: { limits: { memory: "128Mi", cpu: "500m" }, requests: { memory: "128Mi", cpu: "250m" } },
            livenessProbe: {
              httpGet: { path: "/healthz", port: 8080 },
              initialDelaySeconds: 30,
              periodSeconds: 10,
              failureThreshold: 3,
            },
          }),
        ],
        containerStatuses: [
          containerStatus({
            name: "payments-api",
            image: "registry.acme.internal/payments-api:v1.8.2",
            imageID: "registry.acme.internal/payments-api@sha256:9f3c1a",
            ready: false,
            started: false,
            restartCount: 14,
            waiting: {
              reason: "CrashLoopBackOff",
              message: "back-off 5m0s restarting failed container=payments-api pod=" + podName + "_acme-shop",
            },
            lastTerminated: {
              reason: "OOMKilled",
              exitCode: 137,
              startedAt: "2026-06-11T14:23:01Z",
              finishedAt: "2026-06-11T14:25:48Z",
              containerID: "containerd://a1b2c3d4e5f6",
            },
          }),
        ],
        conditions: [
          { type: "Initialized", status: "True", lastTransitionTime: T_CREATE },
          { type: "Ready", status: "False", reason: "ContainersNotReady", message: "containers with unready status: [payments-api]", lastTransitionTime: T_CREATE },
          { type: "ContainersReady", status: "False", reason: "ContainersNotReady", message: "containers with unready status: [payments-api]", lastTransitionTime: T_CREATE },
          { type: "PodScheduled", status: "True", lastTransitionTime: T_CREATE },
        ],
      })
    );
  });

  // Scenario 2: web-frontend ImagePullBackOff
  acmePods.push(
    pod({
      name: "web-frontend-5b8c7d9f4-yq2wn",
      namespace: "acme-shop",
      uid: "bbbb0001-0000-4000-8000-000000000001",
      labels: { app: "web-frontend", "pod-template-hash": "5b8c7d9f4" },
      nodeName: "node-1",
      phase: "Pending",
      ownerReferences: [
        { apiVersion: "apps/v1", kind: "ReplicaSet", name: "web-frontend-5b8c7d9f4", uid: "rs-webfrontend", controller: true },
      ],
      containers: [
        container({
          name: "web",
          image: "registry.acme.internal/web-frontend:v2.4.0",
          ports: [{ containerPort: 80, protocol: "TCP" }],
        }),
      ],
      containerStatuses: [
        containerStatus({
          name: "web",
          image: "registry.acme.internal/web-frontend:v2.4.0",
          ready: false,
          started: false,
          restartCount: 0,
          waiting: {
            reason: "ImagePullBackOff",
            message:
              'Back-off pulling image "registry.acme.internal/web-frontend:v2.4.0"',
          },
        }),
      ],
      conditions: [
        { type: "Initialized", status: "True", lastTransitionTime: T_CREATE },
        { type: "Ready", status: "False", reason: "ContainersNotReady", message: "containers with unready status: [web]", lastTransitionTime: T_CREATE },
        { type: "ContainersReady", status: "False", reason: "ContainersNotReady", message: "containers with unready status: [web]", lastTransitionTime: T_CREATE },
        { type: "PodScheduled", status: "True", lastTransitionTime: T_CREATE },
      ],
    })
  );

  // Scenario 3: postgres-0 Pending (unbound PVC)
  acmePods.push(
    pod({
      name: "postgres-0",
      namespace: "acme-shop",
      uid: "cccc0001-0000-4000-8000-000000000001",
      labels: { app: "postgres", "apps.kubernetes.io/pod-index": "0", "statefulset.kubernetes.io/pod-name": "postgres-0" },
      phase: "Pending",
      ownerReferences: [
        { apiVersion: "apps/v1", kind: "StatefulSet", name: "postgres", uid: "sts-postgres", controller: true },
      ],
      containers: [
        container({
          name: "postgres",
          image: "postgres:15.4-alpine",
          ports: [{ containerPort: 5432, protocol: "TCP" }],
          env: [{ name: "POSTGRES_DB", value: "payments" }, { name: "POSTGRES_USER", value: "acme" }],
          resources: { requests: { memory: "256Mi", cpu: "250m" }, limits: { memory: "512Mi", cpu: "1" } },
        }),
      ],
      conditions: [
        {
          type: "PodScheduled",
          status: "False",
          reason: "Unschedulable",
          message: "0/3 nodes are available: pod has unbound immediate PersistentVolumeClaims. preemption: 0/3 nodes are available: 3 Preemption is not helpful for scheduling.",
          lastTransitionTime: "2026-06-11T13:50:12Z",
        },
      ],
      // no containerStatuses: never scheduled
    })
  );

  // Scenario 4: order-worker CreateContainerConfigError
  acmePods.push(
    pod({
      name: "order-worker-6d4b9c8f7-mn3lk",
      namespace: "acme-shop",
      uid: "dddd0001-0000-4000-8000-000000000001",
      labels: { app: "order-worker", "pod-template-hash": "6d4b9c8f7" },
      nodeName: "node-3",
      phase: "Pending",
      ownerReferences: [
        { apiVersion: "apps/v1", kind: "ReplicaSet", name: "order-worker-6d4b9c8f7", uid: "rs-orderworker", controller: true },
      ],
      containers: [
        container({
          name: "order-worker",
          image: "registry.acme.internal/order-worker:v3.1.0",
          env: [
            {
              name: "DATABASE_URL",
              valueFrom: { configMapKeyRef: { name: "order-config", key: "DATABASE_URL" } },
            },
            {
              name: "LOG_LEVEL",
              valueFrom: { configMapKeyRef: { name: "order-config", key: "LOG_LEVEL" } },
            },
          ],
        }),
      ],
      containerStatuses: [
        containerStatus({
          name: "order-worker",
          image: "registry.acme.internal/order-worker:v3.1.0",
          ready: false,
          started: false,
          restartCount: 0,
          waiting: {
            reason: "CreateContainerConfigError",
            message: "couldn't find key DATABASE_URL in ConfigMap acme-shop/order-config",
          },
        }),
      ],
      conditions: [
        { type: "Initialized", status: "True", lastTransitionTime: T_CREATE },
        { type: "Ready", status: "False", reason: "ContainersNotReady", message: "containers with unready status: [order-worker]", lastTransitionTime: T_CREATE },
        { type: "ContainersReady", status: "False", reason: "ContainersNotReady", message: "containers with unready status: [order-worker]", lastTransitionTime: T_CREATE },
        { type: "PodScheduled", status: "True", lastTransitionTime: T_CREATE },
      ],
    })
  );

  // Healthy baseline: checkout-api 3/3
  const checkoutHashes = ["checkout-api-849f7b6c5-aa11b", "checkout-api-849f7b6c5-bb22c", "checkout-api-849f7b6c5-cc33d"];
  checkoutHashes.forEach((podName, i) => {
    acmePods.push(
      pod({
        name: podName,
        namespace: "acme-shop",
        uid: `eeee0001-0000-4000-8000-00000000000${i + 1}`,
        labels: { app: "checkout-api", "pod-template-hash": "849f7b6c5" },
        nodeName: ["node-1", "node-3", "node-1"][i],
        phase: "Running",
        containers: [
          container({
            name: "checkout-api",
            image: "registry.acme.internal/checkout-api:v4.0.1",
            ports: [{ containerPort: 8080, protocol: "TCP" }],
            env: [{ name: "DB_HOST", value: PG_HOST }],
            resources: { requests: { memory: "256Mi", cpu: "250m" }, limits: { memory: "512Mi", cpu: "1" } },
          }),
        ],
        containerStatuses: [
          containerStatus({
            name: "checkout-api",
            image: "registry.acme.internal/checkout-api:v4.0.1",
            imageID: "registry.acme.internal/checkout-api@sha256:abc123",
            ready: true,
            started: true,
            restartCount: 0,
            running: { startedAt: "2026-06-10T09:14:00Z" },
          }),
        ],
      })
    );
  });

  writeJson(root, "cluster-resources/pods/acme-shop.json", list("PodList", acmePods));

  // ---- kube-system pods (healthy) ---------------------------------------
  writeJson(
    root,
    "cluster-resources/pods/kube-system.json",
    list("PodList", [
      kubeSystemPod("coredns-5d78c9869d-h7x2k", "coredns", "registry.k8s.io/coredns/coredns:v1.10.1", "node-1", "ksys0001"),
      kubeSystemPod("coredns-5d78c9869d-p4m9n", "coredns", "registry.k8s.io/coredns/coredns:v1.10.1", "node-3", "ksys0002"),
      kubeSystemPod("kube-proxy-7gw2x", "kube-proxy", "registry.k8s.io/kube-proxy:v1.27.6", "node-1", "ksys0003"),
      kubeSystemPod("kube-proxy-x9plm", "kube-proxy", "registry.k8s.io/kube-proxy:v1.27.6", "node-3", "ksys0004"),
      kubeSystemPod("etcd-node-1", "etcd", "registry.k8s.io/etcd:3.5.9-0", "node-1", "ksys0005"),
    ])
  );
  writeJson(root, "cluster-resources/pods/default.json", list("PodList", []));

  // ---- deployments -------------------------------------------------------
  writeJson(
    root,
    "cluster-resources/deployments/acme-shop.json",
    list("DeploymentList", [
      deployment({
        name: "payments-api",
        namespace: "acme-shop",
        uid: "dep-payments-api",
        labels: { app: "payments-api" },
        replicas: 3,
        status: { replicas: 3, readyReplicas: 1, availableReplicas: 1, unavailableReplicas: 2 },
        template: deploymentTemplate("payments-api", "registry.acme.internal/payments-api:v1.8.2", {
          resources: { limits: { memory: "128Mi", cpu: "500m" }, requests: { memory: "128Mi", cpu: "250m" } },
        }),
      }),
      deployment({
        name: "web-frontend",
        namespace: "acme-shop",
        uid: "dep-web-frontend",
        labels: { app: "web-frontend" },
        replicas: 2,
        status: { replicas: 2, readyReplicas: 0, availableReplicas: 0, unavailableReplicas: 2 },
        template: deploymentTemplate("web-frontend", "registry.acme.internal/web-frontend:v2.4.0", {}, "web"),
      }),
      deployment({
        name: "order-worker",
        namespace: "acme-shop",
        uid: "dep-order-worker",
        labels: { app: "order-worker" },
        replicas: 1,
        status: { replicas: 1, readyReplicas: 0, availableReplicas: 0, unavailableReplicas: 1 },
        template: deploymentTemplate("order-worker", "registry.acme.internal/order-worker:v3.1.0", {
          env: [{ name: "DATABASE_URL", valueFrom: { configMapKeyRef: { name: "order-config", key: "DATABASE_URL" } } }],
        }),
      }),
      deployment({
        name: "checkout-api",
        namespace: "acme-shop",
        uid: "dep-checkout-api",
        labels: { app: "checkout-api" },
        replicas: 3,
        status: { replicas: 3, readyReplicas: 3, availableReplicas: 3, unavailableReplicas: 0 },
        template: deploymentTemplate("checkout-api", "registry.acme.internal/checkout-api:v4.0.1", {
          resources: { requests: { memory: "256Mi", cpu: "250m" }, limits: { memory: "512Mi", cpu: "1" } },
        }),
      }),
    ])
  );
  writeJson(root, "cluster-resources/deployments/kube-system.json", list("DeploymentList", [
    deployment({
      name: "coredns",
      namespace: "kube-system",
      uid: "dep-coredns",
      labels: { "k8s-app": "kube-dns" },
      replicas: 2,
      status: { replicas: 2, readyReplicas: 2, availableReplicas: 2, unavailableReplicas: 0 },
      template: deploymentTemplate("coredns", "registry.k8s.io/coredns/coredns:v1.10.1", {}, "coredns"),
    }),
  ]));
  writeJson(root, "cluster-resources/deployments/default.json", list("DeploymentList", []));

  // ---- statefulsets ------------------------------------------------------
  writeJson(
    root,
    "cluster-resources/statefulsets/acme-shop.json",
    list("StatefulSetList", [
      statefulSet({
        name: "postgres",
        namespace: "acme-shop",
        uid: "sts-postgres",
        labels: { app: "postgres" },
        replicas: 1,
        status: { replicas: 1, readyReplicas: 0 },
        template: {
          metadata: { labels: { app: "postgres" } },
          spec: {
            containers: [
              container({
                name: "postgres",
                image: "postgres:15.4-alpine",
                ports: [{ containerPort: 5432 }],
                resources: { requests: { memory: "256Mi", cpu: "250m" }, limits: { memory: "512Mi", cpu: "1" } },
              }),
            ],
          },
        },
        volumeClaimTemplates: [
          {
            metadata: { name: "data" },
            spec: {
              accessModes: ["ReadWriteOnce"],
              storageClassName: "fast-ssd",
              resources: { requests: { storage: "20Gi" } },
            },
          },
        ],
      }),
    ])
  );
  writeJson(root, "cluster-resources/statefulsets/kube-system.json", list("StatefulSetList", []));
  writeJson(root, "cluster-resources/statefulsets/default.json", list("StatefulSetList", []));

  // ---- replicasets -------------------------------------------------------
  writeJson(
    root,
    "cluster-resources/replicasets/acme-shop.json",
    list("ReplicaSetList", [
      replicaSet({ name: "payments-api-7c9d8f6b5", namespace: "acme-shop", uid: "rs-payments", app: "payments-api", replicas: 3, ready: 1 }),
      replicaSet({ name: "web-frontend-5b8c7d9f4", namespace: "acme-shop", uid: "rs-webfrontend", app: "web-frontend", replicas: 2, ready: 0 }),
      replicaSet({ name: "order-worker-6d4b9c8f7", namespace: "acme-shop", uid: "rs-orderworker", app: "order-worker", replicas: 1, ready: 0 }),
      replicaSet({ name: "checkout-api-849f7b6c5", namespace: "acme-shop", uid: "rs-checkout", app: "checkout-api", replicas: 3, ready: 3 }),
    ])
  );

  // ---- services ----------------------------------------------------------
  writeJson(
    root,
    "cluster-resources/services/acme-shop.json",
    list("ServiceList", [
      service({ name: "payments-api", namespace: "acme-shop", uid: "svc-payments", app: "payments-api", port: 80, targetPort: 8080, clusterIP: "10.96.10.10" }),
      service({ name: "web-frontend", namespace: "acme-shop", uid: "svc-web", app: "web-frontend", port: 80, targetPort: 80, clusterIP: "10.96.10.20", type: "LoadBalancer" }),
      service({ name: "checkout-api", namespace: "acme-shop", uid: "svc-checkout", app: "checkout-api", port: 80, targetPort: 8080, clusterIP: "10.96.10.30" }),
      service({ name: "postgres", namespace: "acme-shop", uid: "svc-postgres", app: "postgres", port: 5432, targetPort: 5432, clusterIP: "None" }),
    ])
  );
  writeJson(root, "cluster-resources/services/kube-system.json", list("ServiceList", [
    service({ name: "kube-dns", namespace: "kube-system", uid: "svc-kubedns", app: "kube-dns", port: 53, targetPort: 53, clusterIP: "10.96.0.10" }),
  ]));
  writeJson(root, "cluster-resources/services/default.json", list("ServiceList", [
    service({ name: "kubernetes", namespace: "default", uid: "svc-kubernetes", app: "kubernetes", port: 443, targetPort: 6443, clusterIP: "10.96.0.1" }),
  ]));

  // ---- PVCs / PVs / storage classes -------------------------------------
  writeJson(
    root,
    "cluster-resources/persistentvolumeclaims/acme-shop.json",
    list("PersistentVolumeClaimList", [
      pvc({
        name: "data-postgres-0",
        namespace: "acme-shop",
        uid: "pvc-data-postgres-0",
        storageClassName: "fast-ssd",
        storage: "20Gi",
        phase: "Pending",
      }),
    ])
  );
  writeJson(root, "cluster-resources/persistentvolumeclaims/kube-system.json", list("PersistentVolumeClaimList", []));
  writeJson(root, "cluster-resources/persistentvolumeclaims/default.json", list("PersistentVolumeClaimList", []));

  // No matching PVs (fast-ssd unprovisioned). One unrelated standard PV exists.
  writeJson(
    root,
    "cluster-resources/persistentvolumes.json",
    list("PersistentVolumeList", [
      pv({ name: "pvc-legacy-logs", uid: "pv-legacy", storage: "5Gi", storageClassName: "standard" }),
    ])
  );

  // Only `standard` exists — NO fast-ssd -> PVC can never bind.
  writeJson(
    root,
    "cluster-resources/storage-classes.json",
    list("StorageClassList", [storageClass({ name: "standard", isDefault: true })])
  );

  // ---- configmaps (order-config MISSING DATABASE_URL) -------------------
  writeJson(
    root,
    "cluster-resources/configmaps/acme-shop.json",
    list("ConfigMapList", [
      configMap({
        name: "order-config",
        namespace: "acme-shop",
        uid: "cm-order-config",
        // NOTE: intentionally missing DATABASE_URL
        data: { LOG_LEVEL: "info", QUEUE_NAME: "orders.inbound", MAX_RETRIES: "5" },
      }),
      configMap({
        name: "payments-config",
        namespace: "acme-shop",
        uid: "cm-payments-config",
        data: { LOG_LEVEL: "info", DB_HOST: PG_HOST, DB_PORT: "5432" },
      }),
    ])
  );
  writeJson(root, "cluster-resources/configmaps/kube-system.json", list("ConfigMapList", []));
  writeJson(root, "cluster-resources/configmaps/default.json", list("ConfigMapList", []));

  // ---- EVENTS (the rich signal) -----------------------------------------
  writeJson(
    root,
    "cluster-resources/events/acme-shop.json",
    list("EventList", brokenAcmeEvents())
  );
  writeJson(
    root,
    "cluster-resources/events/kube-system.json",
    list("EventList", [
      event({
        ns: "kube-system",
        type: "Normal",
        reason: "Pulled",
        count: 1,
        message: 'Successfully pulled image "registry.k8s.io/coredns/coredns:v1.10.1"',
        involvedObject: { kind: "Pod", name: "coredns-5d78c9869d-h7x2k", uid: "ksys0001-0000-4000-8000-000000000001" },
      }),
    ])
  );
  writeJson(root, "cluster-resources/events/default.json", list("EventList", []));

  // ---- LOGS --------------------------------------------------------------
  write(root, "acme-shop/payments-api-7c9d8f6b5-2k4lq/payments-api.log", paymentsApiLog());
  write(root, "acme-shop/payments-api-7c9d8f6b5-9xv7m/payments-api.log", paymentsApiLog());
  write(root, "acme-shop/payments-api-7c9d8f6b5-r8j2p/payments-api.log", paymentsApiLog());
  write(root, "acme-shop/checkout-api-849f7b6c5-aa11b/checkout-api.log", checkoutApiLog());
  write(root, "acme-shop/checkout-api-849f7b6c5-bb22c/checkout-api.log", checkoutApiLog());
  // web-frontend container never started -> tiny/near-empty log
  write(
    root,
    "acme-shop/web-frontend-5b8c7d9f4-yq2wn/web.log",
    "Error from server (BadRequest): container \"web\" in pod \"web-frontend-5b8c7d9f4-yq2wn\" is waiting to start: image can't be pulled\n"
  );
  // order-worker never created container
  write(
    root,
    "acme-shop/order-worker-6d4b9c8f7-mn3lk/order-worker.log",
    "Error from server (BadRequest): container \"order-worker\" in pod \"order-worker-6d4b9c8f7-mn3lk\" is waiting to start: CreateContainerConfigError\n"
  );
  // kube-system coredns log (healthy)
  write(root, "kube-system/coredns-5d78c9869d-h7x2k/coredns.log", corednsLog());
}

// ----------------------------------------------------------------------------
// HEALTHY BUNDLE
// ----------------------------------------------------------------------------
function generateHealthyBundle(root) {
  writeVersionAndClusterInfo(root, "v1.29.4");

  writeJson(
    root,
    "cluster-resources/nodes.json",
    list("NodeList", [
      node({
        name: "node-1",
        uid: "11111111-aaaa-4bbb-8ccc-000000000001",
        kubeletVersion: "v1.29.4",
        conditions: healthyNodeConditions(),
      }),
      node({
        name: "node-2",
        uid: "22222222-aaaa-4bbb-8ccc-000000000002",
        kubeletVersion: "v1.29.4",
        conditions: healthyNodeConditions(),
      }),
      node({
        name: "node-3",
        uid: "33333333-aaaa-4bbb-8ccc-000000000003",
        kubeletVersion: "v1.29.4",
        conditions: healthyNodeConditions(),
      }),
    ])
  );

  writeCommonClusterResources(root);

  // All acme-shop pods healthy/Running
  const acmePods = [];
  const apps = [
    { app: "payments-api", hash: "7c9d8f6b5", image: "registry.acme.internal/payments-api:v1.9.0", n: 3 },
    { app: "web-frontend", hash: "5b8c7d9f4", image: "registry.acme.internal/web-frontend:v2.4.1", n: 2 },
    { app: "checkout-api", hash: "849f7b6c5", image: "registry.acme.internal/checkout-api:v4.0.1", n: 3 },
    { app: "order-worker", hash: "6d4b9c8f7", image: "registry.acme.internal/order-worker:v3.1.0", n: 1 },
  ];
  let u = 1;
  for (const { app, hash, image, n } of apps) {
    for (let i = 0; i < n; i++) {
      acmePods.push(
        pod({
          name: `${app}-${hash}-${["aa", "bb", "cc"][i] || "zz"}${u}1x`,
          namespace: "acme-shop",
          uid: `hhhh000${u}-0000-4000-8000-00000000000${i + 1}`,
          labels: { app, "pod-template-hash": hash },
          nodeName: ["node-1", "node-2", "node-3"][i % 3],
          phase: "Running",
          containers: [
            container({
              name: app,
              image,
              ports: [{ containerPort: 8080 }],
              resources: { requests: { memory: "256Mi", cpu: "250m" }, limits: { memory: "512Mi", cpu: "1" } },
            }),
          ],
          containerStatuses: [
            containerStatus({
              name: app,
              image,
              imageID: `${image.split(":")[0]}@sha256:healthy0`,
              ready: true,
              started: true,
              restartCount: 0,
              running: { startedAt: "2026-06-10T09:00:00Z" },
            }),
          ],
        })
      );
      u++;
    }
  }
  // healthy postgres-0 (bound PVC)
  acmePods.push(
    pod({
      name: "postgres-0",
      namespace: "acme-shop",
      uid: "hhhhpg00-0000-4000-8000-000000000001",
      labels: { app: "postgres", "statefulset.kubernetes.io/pod-name": "postgres-0" },
      nodeName: "node-2",
      phase: "Running",
      ownerReferences: [{ apiVersion: "apps/v1", kind: "StatefulSet", name: "postgres", uid: "sts-postgres", controller: true }],
      containers: [container({ name: "postgres", image: "postgres:15.4-alpine", ports: [{ containerPort: 5432 }] })],
      containerStatuses: [
        containerStatus({
          name: "postgres",
          image: "postgres:15.4-alpine",
          imageID: "docker.io/library/postgres@sha256:healthy",
          ready: true,
          started: true,
          restartCount: 0,
          running: { startedAt: "2026-06-10T09:00:00Z" },
        }),
      ],
    })
  );
  writeJson(root, "cluster-resources/pods/acme-shop.json", list("PodList", acmePods));

  writeJson(
    root,
    "cluster-resources/pods/kube-system.json",
    list("PodList", [
      kubeSystemPod("coredns-5d78c9869d-h7x2k", "coredns", "registry.k8s.io/coredns/coredns:v1.11.1", "node-1", "ksys0001"),
      kubeSystemPod("coredns-5d78c9869d-p4m9n", "coredns", "registry.k8s.io/coredns/coredns:v1.11.1", "node-3", "ksys0002"),
      kubeSystemPod("kube-proxy-7gw2x", "kube-proxy", "registry.k8s.io/kube-proxy:v1.29.4", "node-1", "ksys0003"),
    ])
  );
  writeJson(root, "cluster-resources/pods/default.json", list("PodList", []));

  // healthy deployments (all ready)
  writeJson(
    root,
    "cluster-resources/deployments/acme-shop.json",
    list("DeploymentList", [
      deployment({ name: "payments-api", namespace: "acme-shop", uid: "dep-payments-api", labels: { app: "payments-api" }, replicas: 3, status: { replicas: 3, readyReplicas: 3, availableReplicas: 3, unavailableReplicas: 0 }, template: deploymentTemplate("payments-api", "registry.acme.internal/payments-api:v1.9.0", {}) }),
      deployment({ name: "web-frontend", namespace: "acme-shop", uid: "dep-web-frontend", labels: { app: "web-frontend" }, replicas: 2, status: { replicas: 2, readyReplicas: 2, availableReplicas: 2, unavailableReplicas: 0 }, template: deploymentTemplate("web-frontend", "registry.acme.internal/web-frontend:v2.4.1", {}, "web") }),
      deployment({ name: "checkout-api", namespace: "acme-shop", uid: "dep-checkout-api", labels: { app: "checkout-api" }, replicas: 3, status: { replicas: 3, readyReplicas: 3, availableReplicas: 3, unavailableReplicas: 0 }, template: deploymentTemplate("checkout-api", "registry.acme.internal/checkout-api:v4.0.1", {}) }),
      deployment({ name: "order-worker", namespace: "acme-shop", uid: "dep-order-worker", labels: { app: "order-worker" }, replicas: 1, status: { replicas: 1, readyReplicas: 1, availableReplicas: 1, unavailableReplicas: 0 }, template: deploymentTemplate("order-worker", "registry.acme.internal/order-worker:v3.1.0", {}) }),
    ])
  );
  writeJson(root, "cluster-resources/deployments/kube-system.json", list("DeploymentList", [
    deployment({ name: "coredns", namespace: "kube-system", uid: "dep-coredns", labels: { "k8s-app": "kube-dns" }, replicas: 2, status: { replicas: 2, readyReplicas: 2, availableReplicas: 2, unavailableReplicas: 0 }, template: deploymentTemplate("coredns", "registry.k8s.io/coredns/coredns:v1.11.1", {}, "coredns") }),
  ]));
  writeJson(root, "cluster-resources/deployments/default.json", list("DeploymentList", []));

  writeJson(
    root,
    "cluster-resources/statefulsets/acme-shop.json",
    list("StatefulSetList", [
      statefulSet({
        name: "postgres",
        namespace: "acme-shop",
        uid: "sts-postgres",
        labels: { app: "postgres" },
        replicas: 1,
        status: { replicas: 1, readyReplicas: 1 },
        template: { metadata: { labels: { app: "postgres" } }, spec: { containers: [container({ name: "postgres", image: "postgres:15.4-alpine", ports: [{ containerPort: 5432 }] })] } },
        volumeClaimTemplates: [
          { metadata: { name: "data" }, spec: { accessModes: ["ReadWriteOnce"], storageClassName: "standard", resources: { requests: { storage: "20Gi" } } } },
        ],
      }),
    ])
  );
  writeJson(root, "cluster-resources/statefulsets/kube-system.json", list("StatefulSetList", []));
  writeJson(root, "cluster-resources/statefulsets/default.json", list("StatefulSetList", []));

  writeJson(root, "cluster-resources/replicasets/acme-shop.json", list("ReplicaSetList", [
    replicaSet({ name: "payments-api-7c9d8f6b5", namespace: "acme-shop", uid: "rs-payments", app: "payments-api", replicas: 3, ready: 3 }),
    replicaSet({ name: "web-frontend-5b8c7d9f4", namespace: "acme-shop", uid: "rs-webfrontend", app: "web-frontend", replicas: 2, ready: 2 }),
    replicaSet({ name: "checkout-api-849f7b6c5", namespace: "acme-shop", uid: "rs-checkout", app: "checkout-api", replicas: 3, ready: 3 }),
    replicaSet({ name: "order-worker-6d4b9c8f7", namespace: "acme-shop", uid: "rs-orderworker", app: "order-worker", replicas: 1, ready: 1 }),
  ]));

  writeJson(root, "cluster-resources/services/acme-shop.json", list("ServiceList", [
    service({ name: "payments-api", namespace: "acme-shop", uid: "svc-payments", app: "payments-api", port: 80, targetPort: 8080, clusterIP: "10.96.10.10" }),
    service({ name: "checkout-api", namespace: "acme-shop", uid: "svc-checkout", app: "checkout-api", port: 80, targetPort: 8080, clusterIP: "10.96.10.30" }),
    service({ name: "postgres", namespace: "acme-shop", uid: "svc-postgres", app: "postgres", port: 5432, targetPort: 5432, clusterIP: "None" }),
  ]));
  writeJson(root, "cluster-resources/services/kube-system.json", list("ServiceList", [
    service({ name: "kube-dns", namespace: "kube-system", uid: "svc-kubedns", app: "kube-dns", port: 53, targetPort: 53, clusterIP: "10.96.0.10" }),
  ]));
  writeJson(root, "cluster-resources/services/default.json", list("ServiceList", [
    service({ name: "kubernetes", namespace: "default", uid: "svc-kubernetes", app: "kubernetes", port: 443, targetPort: 6443, clusterIP: "10.96.0.1" }),
  ]));

  // Bound PVC + matching PV + fast-ssd storage class present
  writeJson(root, "cluster-resources/persistentvolumeclaims/acme-shop.json", list("PersistentVolumeClaimList", [
    pvc({ name: "data-postgres-0", namespace: "acme-shop", uid: "pvc-data-postgres-0", storageClassName: "standard", storage: "20Gi", phase: "Bound", volumeName: "pvc-data-postgres-0-vol" }),
  ]));
  writeJson(root, "cluster-resources/persistentvolumeclaims/kube-system.json", list("PersistentVolumeClaimList", []));
  writeJson(root, "cluster-resources/persistentvolumeclaims/default.json", list("PersistentVolumeClaimList", []));

  writeJson(root, "cluster-resources/persistentvolumes.json", list("PersistentVolumeList", [
    pv({
      name: "pvc-data-postgres-0-vol",
      uid: "pv-postgres",
      storage: "20Gi",
      storageClassName: "standard",
      claimRef: { kind: "PersistentVolumeClaim", namespace: "acme-shop", name: "data-postgres-0", uid: "pvc-data-postgres-0" },
    }),
  ]));

  writeJson(root, "cluster-resources/storage-classes.json", list("StorageClassList", [storageClass({ name: "standard", isDefault: true })]));

  // order-config now HAS DATABASE_URL
  writeJson(root, "cluster-resources/configmaps/acme-shop.json", list("ConfigMapList", [
    configMap({
      name: "order-config",
      namespace: "acme-shop",
      uid: "cm-order-config",
      data: { LOG_LEVEL: "info", QUEUE_NAME: "orders.inbound", MAX_RETRIES: "5", DATABASE_URL: `postgres://acme@${PG_HOST}:5432/payments` },
    }),
  ]));
  writeJson(root, "cluster-resources/configmaps/kube-system.json", list("ConfigMapList", []));
  writeJson(root, "cluster-resources/configmaps/default.json", list("ConfigMapList", []));

  // Only benign Normal events
  const normalEvents = [
    event({ ns: "acme-shop", type: "Normal", reason: "Scheduled", count: 1, message: "Successfully assigned acme-shop/payments-api to node-1", source: "default-scheduler", involvedObject: { kind: "Pod", name: "payments-api-7c9d8f6b5-aa11x", uid: "hhhh0001" } }),
    event({ ns: "acme-shop", type: "Normal", reason: "Pulled", count: 1, message: 'Successfully pulled image "registry.acme.internal/checkout-api:v4.0.1"', involvedObject: { kind: "Pod", name: "checkout-api-849f7b6c5-aa41x", uid: "hhhh0006" } }),
    event({ ns: "acme-shop", type: "Normal", reason: "Started", count: 1, message: "Started container postgres", involvedObject: { kind: "Pod", name: "postgres-0", uid: "hhhhpg00" } }),
  ];
  writeJson(root, "cluster-resources/events/acme-shop.json", list("EventList", normalEvents));
  writeJson(root, "cluster-resources/events/kube-system.json", list("EventList", []));
  writeJson(root, "cluster-resources/events/default.json", list("EventList", []));

  // Healthy logs
  write(root, "acme-shop/payments-api-7c9d8f6b5-aa11x/payments-api.log", healthyPaymentsLog());
  write(root, "acme-shop/checkout-api-849f7b6c5-aa41x/checkout-api.log", healthyCheckoutLog());
  write(root, "kube-system/coredns-5d78c9869d-h7x2k/coredns.log", corednsLog());
}

// ----------------------------------------------------------------------------
// Shared resource fragments
// ----------------------------------------------------------------------------
function healthyNodeConditions() {
  return [
    nodeCondition("MemoryPressure", "False", "KubeletHasSufficientMemory", "kubelet has sufficient memory available"),
    nodeCondition("DiskPressure", "False", "KubeletHasNoDiskPressure", "kubelet has no disk pressure"),
    nodeCondition("PIDPressure", "False", "KubeletHasSufficientPID", "kubelet has sufficient PID available"),
    nodeCondition("Ready", "True", "KubeletReady", "kubelet is posting ready status"),
  ];
}

function kubeSystemPod(name, app, image, nodeName, uidPrefix) {
  return pod({
    name,
    namespace: "kube-system",
    uid: `${uidPrefix}-0000-4000-8000-000000000001`,
    labels: { "k8s-app": app },
    nodeName,
    phase: "Running",
    containers: [container({ name: app, image })],
    containerStatuses: [
      containerStatus({
        name: app,
        image,
        imageID: `${image.split(":")[0]}@sha256:ksys`,
        ready: true,
        started: true,
        restartCount: 0,
        running: { startedAt: "2026-06-09T08:01:00Z" },
      }),
    ],
  });
}

function deploymentTemplate(app, image, extra, containerName) {
  return {
    metadata: { labels: { app } },
    spec: {
      containers: [
        container({
          name: containerName || app,
          image,
          ports: [{ containerPort: 8080, protocol: "TCP" }],
          ...extra,
        }),
      ],
    },
  };
}

function writeVersionAndClusterInfo(root, serverGitVersion) {
  write(
    root,
    "version.yaml",
    [
      "apiVersion: troubleshoot.sh/v1beta2",
      "kind: SupportBundle",
      "spec:",
      "  collectors:",
      "    - clusterInfo: {}",
      "    - clusterResources: {}",
      "    - logs:",
      "        namespace: acme-shop",
      "metadata:",
      `  createdAt: "${NOW}"`,
      "  version: 0.79.0",
      "",
    ].join("\n")
  );

  const [maj, min] = serverGitVersion.replace("v", "").split(".");
  writeJson(root, "cluster-info/cluster_version.json", {
    clientVersion: {
      major: "1",
      minor: "29",
      gitVersion: "v1.29.4",
      gitCommit: "55a1a04e80c6b3a2d2f95d9e1a1b6f4d5c3e2b1a",
      buildDate: "2026-04-19T16:51:25Z",
      goVersion: "go1.21.9",
      compiler: "gc",
      platform: "linux/amd64",
    },
    serverVersion: {
      major: maj,
      minor: min,
      gitVersion: serverGitVersion,
      gitCommit: "be3af46a4654d1da30dc04b7a2dc4a8f5b9c7e21",
      buildDate: "2026-02-14T10:21:05Z",
      goVersion: "go1.20.10",
      compiler: "gc",
      platform: "linux/amd64",
    },
  });
}

function writeCommonClusterResources(root) {
  writeJson(
    root,
    "cluster-resources/namespaces.json",
    list("NamespaceList", [
      namespace("acme-shop", "ns-acme-shop-0000-4000-8000-000000000001"),
      namespace("kube-system", "ns-kube-system-0000-4000-8000-000000000002"),
      namespace("default", "ns-default-0000-4000-8000-000000000003"),
    ])
  );
}

// ----------------------------------------------------------------------------
// Events for the broken acme-shop namespace
// ----------------------------------------------------------------------------
function brokenAcmeEvents() {
  return [
    // Scenario 1: payments-api OOM / CrashLoop
    event({
      ns: "acme-shop",
      type: "Warning",
      reason: "BackOff",
      count: 47,
      message: "Back-off restarting failed container payments-api in pod payments-api-7c9d8f6b5-2k4lq_acme-shop(aaaa0001-0000-4000-8000-000000000001)",
      involvedObject: { kind: "Pod", name: "payments-api-7c9d8f6b5-2k4lq", uid: "aaaa0001-0000-4000-8000-000000000001", fieldPath: "spec.containers{payments-api}" },
    }),
    event({
      ns: "acme-shop",
      type: "Warning",
      reason: "Unhealthy",
      count: 14,
      message: "Liveness probe failed: HTTP probe failed with statuscode: 500",
      involvedObject: { kind: "Pod", name: "payments-api-7c9d8f6b5-2k4lq", uid: "aaaa0001-0000-4000-8000-000000000001", fieldPath: "spec.containers{payments-api}" },
    }),
    event({
      ns: "acme-shop",
      type: "Normal",
      reason: "Killing",
      count: 14,
      message: "Container payments-api failed liveness probe, will be restarted",
      involvedObject: { kind: "Pod", name: "payments-api-7c9d8f6b5-2k4lq", uid: "aaaa0001-0000-4000-8000-000000000001", fieldPath: "spec.containers{payments-api}" },
    }),
    event({
      ns: "acme-shop",
      type: "Warning",
      reason: "BackOff",
      count: 41,
      message: "Back-off restarting failed container payments-api in pod payments-api-7c9d8f6b5-9xv7m_acme-shop(aaaa0001-0000-4000-8000-000000000002)",
      involvedObject: { kind: "Pod", name: "payments-api-7c9d8f6b5-9xv7m", uid: "aaaa0001-0000-4000-8000-000000000002", fieldPath: "spec.containers{payments-api}" },
    }),

    // Scenario 2: web-frontend ImagePullBackOff
    event({
      ns: "acme-shop",
      type: "Warning",
      reason: "Failed",
      count: 6,
      message:
        'Failed to pull image "registry.acme.internal/web-frontend:v2.4.0": rpc error: code = Unknown desc = failed to resolve reference "registry.acme.internal/web-frontend:v2.4.0": registry.acme.internal/web-frontend:v2.4.0: not found: manifest unknown',
      involvedObject: { kind: "Pod", name: "web-frontend-5b8c7d9f4-yq2wn", uid: "bbbb0001-0000-4000-8000-000000000001", fieldPath: "spec.containers{web}" },
    }),
    event({
      ns: "acme-shop",
      type: "Warning",
      reason: "Failed",
      count: 6,
      message: "Error: ErrImagePull",
      involvedObject: { kind: "Pod", name: "web-frontend-5b8c7d9f4-yq2wn", uid: "bbbb0001-0000-4000-8000-000000000001", fieldPath: "spec.containers{web}" },
    }),
    event({
      ns: "acme-shop",
      type: "Warning",
      reason: "BackOff",
      count: 22,
      message: 'Back-off pulling image "registry.acme.internal/web-frontend:v2.4.0"',
      involvedObject: { kind: "Pod", name: "web-frontend-5b8c7d9f4-yq2wn", uid: "bbbb0001-0000-4000-8000-000000000001", fieldPath: "spec.containers{web}" },
    }),

    // Scenario 3: postgres unbound PVC -> FailedScheduling + ProvisioningFailed
    event({
      ns: "acme-shop",
      type: "Warning",
      reason: "FailedScheduling",
      count: 31,
      message: "0/3 nodes are available: pod has unbound immediate PersistentVolumeClaims. preemption: 0/3 nodes are available: 3 Preemption is not helpful for scheduling.",
      source: "default-scheduler",
      involvedObject: { kind: "Pod", name: "postgres-0", uid: "cccc0001-0000-4000-8000-000000000001" },
    }),
    event({
      ns: "acme-shop",
      type: "Warning",
      reason: "ProvisioningFailed",
      count: 31,
      message: 'storageclass.storage.k8s.io "fast-ssd" not found',
      source: "persistentvolume-controller",
      involvedObject: { kind: "PersistentVolumeClaim", name: "data-postgres-0", uid: "pvc-data-postgres-0" },
    }),

    // Scenario 4: order-worker CreateContainerConfigError
    event({
      ns: "acme-shop",
      type: "Warning",
      reason: "Failed",
      count: 19,
      message: "Error: couldn't find key DATABASE_URL in ConfigMap acme-shop/order-config",
      involvedObject: { kind: "Pod", name: "order-worker-6d4b9c8f7-mn3lk", uid: "dddd0001-0000-4000-8000-000000000001", fieldPath: "spec.containers{order-worker}" },
    }),

    // checkout-api healthy normal event
    event({
      ns: "acme-shop",
      type: "Normal",
      reason: "Started",
      count: 1,
      message: "Started container checkout-api",
      firstTimestamp: "2026-06-10T09:14:00Z",
      lastTimestamp: "2026-06-10T09:14:00Z",
      involvedObject: { kind: "Pod", name: "checkout-api-849f7b6c5-aa11b", uid: "eeee0001-0000-4000-8000-000000000001", fieldPath: "spec.containers{checkout-api}" },
    }),
  ];
}

// ----------------------------------------------------------------------------
// Log bodies
// ----------------------------------------------------------------------------
function paymentsApiLog() {
  const L = [];
  L.push(`${ts(0)} INFO  [main] c.a.payments.PaymentsApplication - Starting PaymentsApplication v1.8.2 using Java 17.0.9 on payments-api-7c9d8f6b5-2k4lq with PID 1`);
  L.push(`${ts(1)} INFO  [main] c.a.payments.PaymentsApplication - The following 1 profile is active: "prod"`);
  L.push(`${ts(2)} INFO  [main] o.s.b.w.embedded.tomcat.TomcatWebServer - Tomcat initialized with port(s): 8080 (http)`);
  L.push(`${ts(3)} INFO  [main] o.s.b.w.embedded.tomcat.TomcatWebServer - Tomcat started on port(s): 8080 (http) with context path ''`);
  L.push(`${ts(4)} INFO  [main] c.a.payments.config.DataSourceConfig - Initializing connection pool to ${PG_HOST}:5432`);
  // DB connectivity failures (cascade from scenario 3)
  for (let i = 0; i < 5; i++) {
    L.push(`${ts(5 + i * 4)} WARN  [hikari-pool-1] com.zaxxer.hikari.pool.HikariPool - HikariPool-1 - Failed to validate connection org.postgresql.util.PSQLException: Connection to ${PG_HOST}:5432 refused.`);
    L.push(`${ts(6 + i * 4)} ERROR [hikari-pool-1] c.a.payments.repo.PaymentRepository - could not connect to database: dial tcp 10.244.3.17:5432: connect: connection refused`);
  }
  L.push(`${ts(30)} INFO  [main] c.a.payments.PaymentsApplication - Started PaymentsApplication in 11.482 seconds (process running for 12.9)`);
  // OOM build-up
  L.push(`${ts(34)} WARN  [Service Thread] o.s.boot.actuate.metrics - GC overhead: spent 12.4s in last 60s on garbage collection`);
  L.push(`${ts(40)} WARN  [Service Thread] java.lang.management - [Full GC (Allocation Failure)] 124M->121M(128M), 1.83 secs`);
  L.push(`${ts(46)} WARN  [Service Thread] java.lang.management - [Full GC (Allocation Failure)] 126M->125M(128M), 2.41 secs`);
  L.push(`${ts(52)} WARN  [http-nio-8080-exec-7] o.a.c.c.C.[.[.[/] - GC overhead limit exceeded approaching; throttling new requests`);
  // The OOM stacktrace
  L.push(`${ts(58)} ERROR [http-nio-8080-exec-7] o.a.c.c.C.[.[.[.[dispatcherServlet] - Servlet.service() for servlet [dispatcherServlet] threw exception`);
  L.push(`java.lang.OutOfMemoryError: Java heap space`);
  L.push(`\tat java.base/java.util.Arrays.copyOf(Arrays.java:3537) ~[na:na]`);
  L.push(`\tat java.base/java.lang.AbstractStringBuilder.ensureCapacityInternal(AbstractStringBuilder.java:237) ~[na:na]`);
  L.push(`\tat com.acme.payments.service.LedgerService.buildReport(LedgerService.java:188) ~[app.jar:1.8.2]`);
  L.push(`\tat com.acme.payments.web.PaymentController.report(PaymentController.java:96) ~[app.jar:1.8.2]`);
  L.push(`\tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103) ~[na:na]`);
  L.push(`\tat org.springframework.web.method.support.InvocableHandlerMethod.doInvoke(InvocableHandlerMethod.java:205) ~[spring-web-6.0.13.jar:6.0.13]`);
  L.push(`${ts(62)} ERROR [Service Thread] java.lang.Thread - Exception in thread "Service Thread" java.lang.OutOfMemoryError: Java heap space`);
  L.push(`${ts(64)} ERROR [http-nio-8080-exec-3] o.a.c.c.C.[.[.[.[dispatcherServlet] - java.lang.OutOfMemoryError: Java heap space`);
  L.push(`Terminating due to java.lang.OutOfMemoryError: Java heap space`);
  L.push(`#`);
  L.push(`# java.lang.OutOfMemoryError: Java heap space`);
  L.push(`# -XX:OnOutOfMemoryError="kill -9 %p"`);
  L.push(`#   Executing /bin/sh -c "kill -9 1"...`);
  return L.join("\n") + "\n";
}

function checkoutApiLog() {
  const L = [];
  L.push(`${ts(0)} INFO  [main] c.a.checkout.CheckoutApplication - Starting CheckoutApplication v4.0.1 (PID 1)`);
  L.push(`${ts(2)} INFO  [main] o.s.b.w.embedded.tomcat.TomcatWebServer - Tomcat started on port(s): 8080 (http)`);
  L.push(`${ts(3)} INFO  [main] c.a.checkout.config.DataSourceConfig - Connecting to ${PG_HOST}:5432`);
  // cascade: checkout can't reach DB either
  for (let i = 0; i < 4; i++) {
    L.push(`${ts(5 + i * 6)} ERROR [scheduler-1] c.a.checkout.job.SettlementJob - could not connect to database: dial tcp 10.244.3.17:5432: connect: connection refused`);
    L.push(`${ts(7 + i * 6)} WARN  [scheduler-1] c.a.checkout.job.SettlementJob - retrying settlement batch in 30s (attempt ${i + 1}/10)`);
  }
  L.push(`${ts(40)} INFO  [http-nio-8080-exec-2] c.a.checkout.web.HealthController - GET /healthz 200 (cache served, db degraded)`);
  L.push(`${ts(46)} INFO  [http-nio-8080-exec-5] c.a.checkout.web.CheckoutController - POST /api/checkout 200 (12ms) order=ord_88213`);
  return L.join("\n") + "\n";
}

function healthyPaymentsLog() {
  const L = [];
  L.push(`${ts(0)} INFO  [main] c.a.payments.PaymentsApplication - Starting PaymentsApplication v1.9.0 (PID 1)`);
  L.push(`${ts(2)} INFO  [main] o.s.b.w.embedded.tomcat.TomcatWebServer - Tomcat started on port(s): 8080 (http)`);
  L.push(`${ts(3)} INFO  [main] c.a.payments.config.DataSourceConfig - HikariPool-1 - Start completed. Connected to ${PG_HOST}:5432`);
  L.push(`${ts(5)} INFO  [main] c.a.payments.PaymentsApplication - Started PaymentsApplication in 4.812 seconds`);
  L.push(`${ts(12)} INFO  [http-nio-8080-exec-1] c.a.payments.web.PaymentController - POST /api/payments 201 (18ms) txn=txn_55021`);
  L.push(`${ts(20)} INFO  [http-nio-8080-exec-4] c.a.payments.web.PaymentController - POST /api/payments 201 (15ms) txn=txn_55022`);
  L.push(`${ts(28)} INFO  [http-nio-8080-exec-2] c.a.payments.web.HealthController - GET /healthz 200 (2ms)`);
  return L.join("\n") + "\n";
}

function healthyCheckoutLog() {
  const L = [];
  L.push(`${ts(0)} INFO  [main] c.a.checkout.CheckoutApplication - Starting CheckoutApplication v4.0.1 (PID 1)`);
  L.push(`${ts(2)} INFO  [main] o.s.b.w.embedded.tomcat.TomcatWebServer - Tomcat started on port(s): 8080 (http)`);
  L.push(`${ts(3)} INFO  [main] c.a.checkout.config.DataSourceConfig - Connected to ${PG_HOST}:5432`);
  L.push(`${ts(10)} INFO  [scheduler-1] c.a.checkout.job.SettlementJob - settlement batch complete: 142 orders in 1.2s`);
  L.push(`${ts(22)} INFO  [http-nio-8080-exec-5] c.a.checkout.web.CheckoutController - POST /api/checkout 200 (11ms) order=ord_88240`);
  return L.join("\n") + "\n";
}

function corednsLog() {
  const L = [];
  L.push(`.:53`);
  L.push(`[INFO] plugin/reload: Running configuration SHA512 = 591cf328cccc12bc490481273e738df59329c62c0b729d94e8b61db9961c2fa5`);
  L.push(`CoreDNS-1.10.1`);
  L.push(`linux/amd64, go1.20, 055b2c3`);
  L.push(`[INFO] 10.244.0.5:41122 - 31892 "A IN ${PG_HOST}. udp 56 false 512" NXDOMAIN qr,aa,rd 149 0.000189s`);
  L.push(`[INFO] 10.244.0.6:55310 - 11203 "A IN kubernetes.default.svc.cluster.local. udp 41 false 512" NOERROR qr,aa,rd 106 0.000132s`);
  return L.join("\n") + "\n";
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
function main() {
  const healthy = process.argv.includes("--healthy");
  const bundleName = healthy ? "healthy-support-bundle" : "sample-support-bundle";
  const dirName = healthy ? "healthy-support-bundle" : "sample-support-bundle";
  const root = join(SAMPLES_DIR, dirName);

  // clean previous output for determinism
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  if (healthy) generateHealthyBundle(root);
  else generateBrokenBundle(root);

  // tar it with the system tar
  const tarball = `${bundleName}.tar.gz`;
  execFileSync("tar", ["-czf", join(SAMPLES_DIR, tarball), "-C", SAMPLES_DIR, dirName], { stdio: "inherit" });

  console.log(`Wrote samples/${dirName}/ and samples/${tarball}`);
}

main();
