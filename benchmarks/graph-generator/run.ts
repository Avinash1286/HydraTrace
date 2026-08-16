import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  HydraDbGraphStore,
  InMemoryGraphStore,
  hydraDbConnectionOptionsFromEnv,
} from "@hydratrace/hydradb-client";
import { normalizedSnapshotToGraphRecords } from "@hydratrace/graph-schema";
import {
  stableIdFromCanonicalKey,
  type FactProvenance,
  type NormalizedResolutionEdge,
  type NormalizedSnapshot,
} from "@hydratrace/domain";

const profiles = {
  small: { nodes: 10_000, edges: 40_000 },
  medium: { nodes: 100_000, edges: 400_000 },
  large: { nodes: 250_000, edges: 1_000_000 },
} as const;

const useHydraDb = process.argv.includes("--hydradb");
const profileName = process.argv.find((value) => value.startsWith("--profile="))?.split("=")[1] as keyof typeof profiles | undefined;
const legacySize = process.argv.slice(2).find((value) => /^\d+$/u.test(value));
const requested = profileName === undefined ? undefined : profiles[profileName];
if (profileName !== undefined && requested === undefined) {
  throw new Error("profile must be small, medium, or large");
}
const resolutionCount = requested === undefined
  ? Number(legacySize ?? 10_000)
  : Math.floor((requested.nodes - 1) / 3);
if (!Number.isInteger(resolutionCount) || resolutionCount < 10 || resolutionCount > 100_000) {
  throw new Error("resolution count must be between 10 and 100000");
}
const targetDependencyEdges = requested === undefined
  ? resolutionCount - 1
  : requested.edges - (resolutionCount * 3);
const datasetKey = `${resolutionCount}:${targetDependencyEdges}`;

const snapshotId = stableIdFromCanonicalKey(`benchmark-snapshot:${datasetKey}`);
const provenance: FactProvenance = {
  sourceType: "package-lock",
  sourceRef: "benchmark-lock.json",
  sourceSha256: "b".repeat(64),
  repositoryId: "benchmark/generated",
  commitSha: `benchmark-${resolutionCount}`,
  importRunId: stableIdFromCanonicalKey(`benchmark-run:${resolutionCount}:${targetDependencyEdges}`),
  observedAt: 1,
  parserVersion: "benchmark",
  confidence: 1,
};
const packages = Array.from({ length: resolutionCount }, (_, index) => ({
  id: stableIdFromCanonicalKey(`benchmark-version:${datasetKey}:${index}`),
  packageId: stableIdFromCanonicalKey(`benchmark-package:${datasetKey}:${index}`),
  name: `benchmark-${resolutionCount}-package-${index}`,
  normalizedName: `benchmark-${resolutionCount}-package-${index}`,
  ecosystem: "npm" as const,
  version: "1.0.0",
  provenance,
}));
const resolutions = packages.map((version, index) => ({
  id: stableIdFromCanonicalKey(`benchmark-resolution:${datasetKey}:${index}`),
  snapshotId,
  packageVersionId: version.id,
  packageName: version.name,
  version: version.version,
  sourceKey: index === 0 ? "" : `node_modules/${version.name}`,
  installPath: index === 0 ? "." : `node_modules/${version.name}`,
  root: index === 0,
  direct: index > 0 && index < 10,
  dev: false,
  optional: false,
  peer: false,
  provenance,
}));
const edges: NormalizedResolutionEdge[] = Array.from(
  { length: targetDependencyEdges },
  (_, index) => {
    const fromIndex = index < resolutionCount - 1
      ? index
      : (index * 48271) % resolutionCount;
    let toIndex = index < resolutionCount - 1
      ? index + 1
      : (fromIndex + 1 + ((index * 69621) % (resolutionCount - 1))) % resolutionCount;
    if (toIndex === fromIndex) toIndex = (toIndex + 1) % resolutionCount;
    return {
      id: stableIdFromCanonicalKey(`benchmark-edge:${datasetKey}:${index}:${fromIndex}:${toIndex}`),
      snapshotId,
      fromResolutionId: resolutions[fromIndex]!.id,
      toResolutionId: resolutions[toIndex]!.id,
      dependencyName: resolutions[toIndex]!.packageName,
      kind: "production",
      provenance,
    };
  },
);
const normalized: NormalizedSnapshot = {
  snapshot: {
    id: snapshotId,
    ecosystem: "npm",
    lockfileType: "package-lock",
    contentHash: "b".repeat(64),
    repositoryId: "benchmark/generated",
    commitSha: `benchmark-${resolutionCount}`,
    sourceRef: "benchmark-lock.json",
    parserVersion: "benchmark",
    createdAt: 1,
  },
  packages,
  resolutions,
  edges,
  warnings: [],
};

const store = useHydraDb
  ? HydraDbGraphStore.connect(hydraDbConnectionOptionsFromEnv())
  : new InMemoryGraphStore();
const records = normalizedSnapshotToGraphRecords(normalized);
const started = performance.now();
const write = await store.write(records);
const writeMs = performance.now() - started;
const latencies: number[] = [];
let pathCount = 0;
for (let iteration = 0; iteration < 20; iteration += 1) {
  const queryStart = performance.now();
  const paths = await store.findPaths({
    from: { label: "Resolution", id: resolutions[0]!.id },
    to: { label: "Resolution", id: resolutions[1]!.id },
    relationshipType: "DEPENDS_ON_INSTANCE",
    maxDepth: 1,
    limit: 10,
  });
  latencies.push(performance.now() - queryStart);
  pathCount = paths.length;
}
const coldLatency = latencies[0]!;
const sortedLatencies = [...latencies].sort((left, right) => left - right);
const percentile = (fraction: number): number =>
  sortedLatencies[Math.min(sortedLatencies.length - 1, Math.ceil(sortedLatencies.length * fraction) - 1)]!;
const report = {
  generatedAt: new Date().toISOString(),
  dataset: {
    seed: 42,
    profile: profileName ?? "custom",
    nodes: records.nodes.length,
    edges: records.relationships.length,
    resolutionInstances: resolutionCount,
  },
  environment: {
    platform: process.platform,
    implementation: useHydraDb ? "HydraDB v0.1.1 strong local MinIO" : "InMemoryGraphStore reference",
    nodeVersion: process.version,
  },
  import: {
    milliseconds: Math.round(writeMs * 100) / 100,
    recordsPerSecond: Math.round(((records.nodes.length + records.relationships.length) / writeMs) * 1000),
    nodesCreated: write.nodes.created,
    relationshipsCreated: write.relationships.created,
  },
  boundedPathQuery: {
    depth: 1,
    runs: latencies.length,
    coldMilliseconds: Math.round(coldLatency * 100) / 100,
    p50Milliseconds: Math.round(percentile(0.5) * 100) / 100,
    p95Milliseconds: Math.round(percentile(0.95) * 100) / 100,
    paths: pathCount,
  },
  memory: { engineRssBytes: process.memoryUsage().rss },
  notMeasured: useHydraDb
    ? []
    : ["HydraDB node/indexer memory", "index build time", "storage size", "strong-versus-causal latency"],
};
const output = `${JSON.stringify(report, null, 2)}\n`;
process.stdout.write(output);
const reportArgument = process.argv.find((value) => value.startsWith("--report="))?.slice("--report=".length);
if (reportArgument !== undefined) await writeFile(reportArgument, output, "utf8");
await store.close();
