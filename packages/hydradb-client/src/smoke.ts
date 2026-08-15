import {
  stableIdFromCanonicalKey,
  type FactProvenance,
  type StableId,
} from "@hydratrace/domain";
import {
  graphRelationshipId,
  provenanceProperties,
  type GraphNodeRecord,
  type GraphRecords,
  type GraphRelationshipRecord,
} from "@hydratrace/graph-schema";
import type { GraphStore, GraphWriteSummary } from "./graph-store.js";

const SMOKE_NAMES = [
  "root-resolution",
  "checkout-framework",
  "telemetry-core",
  "compromised-helper@1.4.2",
] as const;

export interface HydraDbSmokeFixture {
  records: GraphRecords;
  expectedNodeIds: readonly StableId[];
  expectedRelationshipIds: readonly StableId[];
  expectedPath: readonly StableId[];
}

export interface HydraDbSmokeResult {
  write: GraphWriteSummary;
  readNodeCount: number;
  readRelationshipCount: number;
  pathCount: number;
  orderedPath: readonly StableId[];
}

export function createHydraDbSmokeFixture(): HydraDbSmokeFixture {
  const ids = SMOKE_NAMES.map((name) =>
    stableIdFromCanonicalKey(`hydratrace-smoke:resolution:${name}`),
  );
  const importRunId = stableIdFromCanonicalKey("hydratrace-smoke:import");
  const snapshotId = stableIdFromCanonicalKey("hydratrace-smoke:snapshot");
  const packageVersionId = stableIdFromCanonicalKey(
    "hydratrace-smoke:package-version",
  );
  const provenance: FactProvenance = {
    sourceType: "manual",
    sourceRef: "hydratrace-hydradb-smoke",
    sourceSha256: "0".repeat(64),
    repositoryId: "hydratrace-smoke",
    commitSha: "smoke",
    importRunId,
    observedAt: 0,
    parserVersion: "0.1.0",
    confidence: 1,
  };

  const nodes = ids.map(
    (id, index): GraphNodeRecord<"Resolution"> => ({
      id,
      label: "Resolution",
      properties: {
        snapshotId,
        packageVersionId,
        packageName: SMOKE_NAMES[index] ?? "unknown",
        version: index === ids.length - 1 ? "1.4.2" : "1.0.0",
        sourceKey: SMOKE_NAMES[index] ?? "unknown",
        installPath: `node_modules/${SMOKE_NAMES[index] ?? "unknown"}`,
        root: index === 0,
        direct: index === 1,
        dev: false,
        optional: false,
        peer: false,
        ...provenanceProperties(provenance),
      },
    }),
  );

  const relationships: GraphRelationshipRecord<"DEPENDS_ON_INSTANCE">[] = [];
  for (let index = 0; index < ids.length - 1; index += 1) {
    const from = ids[index];
    const to = ids[index + 1];
    if (from === undefined || to === undefined) continue;
    relationships.push({
      id: graphRelationshipId({
        type: "DEPENDS_ON_INSTANCE",
        from,
        to,
        discriminator: "smoke",
      }),
      type: "DEPENDS_ON_INSTANCE",
      from: { id: from, label: "Resolution" },
      to: { id: to, label: "Resolution" },
      properties: {
        dependencyName: SMOKE_NAMES[index + 1] ?? "unknown",
        kind: "production",
        ...provenanceProperties(provenance),
      },
    });
  }

  return {
    records: { nodes, relationships },
    expectedNodeIds: ids,
    expectedRelationshipIds: relationships.map(({ id }) => id),
    expectedPath: ids,
  };
}

/** Runs a repeatable write/read/three-hop path probe without clearing data. */
export async function runHydraDbSmokeProbe(
  store: GraphStore,
): Promise<HydraDbSmokeResult> {
  const fixture = createHydraDbSmokeFixture();
  const write = await store.write(fixture.records);
  const nodes = await store.getNodes(fixture.expectedNodeIds);
  if (nodes.length !== fixture.expectedNodeIds.length) {
    throw new Error(
      `HydraDB smoke read returned ${nodes.length} nodes; expected ${fixture.expectedNodeIds.length}`,
    );
  }
  const relationships = await store.getRelationships(
    fixture.expectedRelationshipIds,
  );
  if (relationships.length !== fixture.expectedRelationshipIds.length) {
    throw new Error(
      `HydraDB smoke read returned ${relationships.length} relationships; expected ${fixture.expectedRelationshipIds.length}`,
    );
  }
  const from = fixture.expectedPath[0];
  const to = fixture.expectedPath.at(-1);
  if (from === undefined || to === undefined) {
    throw new Error("HydraDB smoke fixture is empty");
  }
  const paths = await store.findPaths({
    from: { id: from, label: "Resolution" },
    to: { id: to, label: "Resolution" },
    relationshipType: "DEPENDS_ON_INSTANCE",
    minDepth: 3,
    maxDepth: 3,
    limit: 2,
  });
  if (
    paths.length !== 1 ||
    !sameIds(paths[0]?.nodeIds, fixture.expectedPath) ||
    !sameIds(
      paths[0]?.relationshipIds,
      fixture.expectedRelationshipIds,
    )
  ) {
    throw new Error("HydraDB smoke path did not match the exact expected three-hop path");
  }

  return {
    write,
    readNodeCount: nodes.length,
    readRelationshipCount: relationships.length,
    pathCount: paths.length,
    orderedPath: paths[0]?.nodeIds ?? [],
  };
}

function sameIds(
  actual: readonly StableId[] | undefined,
  expected: readonly StableId[],
): boolean {
  return (
    actual !== undefined &&
    actual.length === expected.length &&
    actual.every((id, index) => id === expected[index])
  );
}
