import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stableIdFromCanonicalKey, type StableId } from "@hydratrace/domain";
import type { GraphNodeRecord, GraphRecords, GraphRelationshipRecord } from "@hydratrace/graph-schema";
import { HydraDbGraphStore, hydraDbConnectionOptionsFromEnv } from "@hydratrace/hydradb-client";

const secretPath = resolve(import.meta.dirname, "../../../../infra/local/secrets/auth-token");
const token = process.env.HYDRADB_AUTH_TOKEN ?? (await readFile(secretPath, "utf8")).trim();
const environment = {
  ...process.env,
  HYDRADB_BOLT_URI: process.env.HYDRADB_BOLT_URI ?? "bolt://127.0.0.1:7687",
  HYDRADB_HTTP_URL: process.env.HYDRADB_HTTP_URL,
  HYDRADB_AUTH_TOKEN: token,
  HYDRADB_GRAPH_ID: process.env.HYDRADB_GRAPH_ID ?? "default",
  HYDRADB_CELL_ID: process.env.HYDRADB_CELL_ID ?? "cell-0",
  HYDRADB_NAMESPACE: process.env.HYDRADB_NAMESPACE ?? "development",
  // The property gate validates path semantics immediately after each write.
  // Strong/indexed visibility is proved separately by the persistence gate
  // after an index cycle; causal Bolt reads are the correct boundary here.
  HYDRADB_CONSISTENCY: process.env.HYDRADB_CONSISTENCY ?? "causal",
};
const store = HydraDbGraphStore.connect(hydraDbConnectionOptionsFromEnv(environment));

const cases = propertyCases();
try {
  for (const graphCase of cases) {
    const records = graphRecords(graphCase.name, graphCase.adjacency);
    await store.write(records);
    const nodeIds = records.nodes.map(({ id }) => id);
    const expected = enumerateSimplePaths(graphCase.adjacency, graphCase.target, 16)
      .map((path) => path.map((index) => nodeIds[index]!).join("/"))
      .sort();
    const actual = (await store.findPaths({
      from: { label: "Resolution", id: nodeIds[0]! },
      to: { label: "Resolution", id: nodeIds[graphCase.target]! },
      relationshipType: "DEPENDS_ON_INSTANCE",
      minDepth: 1,
      maxDepth: Math.min(16, graphCase.adjacency.length - 1),
      limit: 1_000,
    })).map(({ nodeIds: path }) => path.join("/")).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${graphCase.name}: HydraDB paths ${JSON.stringify(actual)} did not match reference ${JSON.stringify(expected)}`);
    }
    process.stdout.write(`${graphCase.name}: ${actual.length} complete path(s) matched\n`);
  }
  process.stdout.write(`HydraDB fixed-seed property gate passed ${cases.length} graph shapes.\n`);
} finally {
  await store.close();
}

function graphRecords(name: string, adjacency: readonly (readonly number[])[]): GraphRecords {
  const observedAt = Date.parse("2026-08-17T00:00:00.000Z");
  const snapshotId = id(`hydradb-property:${name}:snapshot`);
  const provenance = {
    sourceType: "package-lock" as const,
    sourceRef: `${name}.json`,
    sourceSha256: "c".repeat(64),
    repositoryId: `property/${name}`,
    commitSha: `property-${name}`,
    importRunId: id(`hydradb-property:${name}:run`),
    observedAt,
    parserVersion: "property-gate",
    confidence: 1,
  };
  const nodes: GraphNodeRecord<"Resolution">[] = adjacency.map((_, index) => ({
    id: id(`hydradb-property:${name}:node:${index}`),
    label: "Resolution",
    properties: {
      ...provenance,
      snapshotId,
      packageVersionId: id(`hydradb-property:${name}:version:${index}`),
      packageName: `${name}-${index}`,
      version: "1.0.0",
      sourceKey: index === 0 ? "" : `node_modules/${name}-${index}`,
      installPath: index === 0 ? "." : `node_modules/${name}-${index}`,
      root: index === 0,
      direct: adjacency[0]?.includes(index) ?? false,
      dev: false,
      optional: false,
      peer: false,
    },
  }));
  const relationships: GraphRelationshipRecord<"DEPENDS_ON_INSTANCE">[] = adjacency.flatMap((targets, from) =>
    targets.map((to) => ({
      id: id(`hydradb-property:${name}:edge:${from}:${to}`),
      type: "DEPENDS_ON_INSTANCE",
      from: { label: "Resolution", id: nodes[from]!.id },
      to: { label: "Resolution", id: nodes[to]!.id },
      properties: { ...provenance, dependencyName: `${name}-${to}`, kind: "production" },
    })),
  );
  return { nodes, relationships };
}

function propertyCases(): Array<{ name: string; adjacency: number[][]; target: number }> {
  return [
    { name: "chain", adjacency: [[1], [2], [3], []], target: 3 },
    { name: "branches", adjacency: [[1, 2], [3], [3], []], target: 3 },
    { name: "shared-transitive", adjacency: [[1, 2], [3, 4], [4], [5], [5], []], target: 5 },
    { name: "multiple-versions", adjacency: [[1, 2], [3], [4], [5], [5], []], target: 5 },
    { name: "cycle", adjacency: [[1, 2], [2, 3], [1, 3], []], target: 3 },
    { name: "depth-limit", adjacency: [[1], [2], [3], [4], [5], [6], [7], [8], [9], []], target: 9 },
    { name: "isolated", adjacency: [[1], [2], [], []], target: 3 },
    { name: "fan-out", adjacency: [[1, 2, 3, 4], [5], [5], [5], [5], []], target: 5 },
  ];
}

function enumerateSimplePaths(adjacency: readonly (readonly number[])[], target: number, maxDepth: number): number[][] {
  const complete: number[][] = [];
  const pending: number[][] = [[0]];
  while (pending.length > 0) {
    const path = pending.pop()!;
    const current = path.at(-1)!;
    if (current === target && path.length > 1) complete.push(path);
    if (path.length - 1 === maxDepth) continue;
    for (const next of adjacency[current] ?? []) if (!path.includes(next)) pending.push([...path, next]);
  }
  return complete;
}

function id(value: string): StableId {
  return stableIdFromCanonicalKey(value);
}
