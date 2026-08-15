import {
  canonicalKeys,
  stableIdFromCanonicalKey,
  type DeploymentManifest,
  type NormalizedSnapshot,
  type StableId,
} from "@hydratrace/domain";
import { graphRelationshipId } from "./normalized-snapshot.js";
import type { GraphNodeRecord, GraphRecords, GraphRelationshipRecord } from "./records.js";

export function deploymentManifestToGraphRecords(
  manifest: DeploymentManifest,
  snapshot: Pick<
    NormalizedSnapshot["snapshot"],
    "id" | "repositoryId" | "commitSha" | "contentHash" | "sourceRef"
  >,
): GraphRecords {
  assertManifestMatchesSnapshot(manifest, snapshot);
  const organizationId = stableIdFromCanonicalKey(
    canonicalKeys.organization(manifest.organizationId),
  );
  const repositoryId = stableIdFromCanonicalKey(
    canonicalKeys.repository(manifest.repositoryId),
  );
  const serviceId = stableIdFromCanonicalKey(
    canonicalKeys.service(manifest.repositoryId, manifest.serviceId),
  );
  const commitId = stableIdFromCanonicalKey(
    canonicalKeys.commit(manifest.repositoryId, manifest.commitSha),
  );
  const environmentId = stableIdFromCanonicalKey(
    canonicalKeys.environment(manifest.organizationId, manifest.environment),
  );

  const nodes: GraphNodeRecord[] = [
    {
      id: organizationId,
      label: "Organization",
      properties: { name: manifest.organizationId },
    },
    {
      id: repositoryId,
      label: "Repository",
      properties: { url: `urn:hydratrace:repository:${manifest.repositoryId}` },
    },
    {
      id: serviceId,
      label: "Service",
      properties: { name: manifest.serviceId, repositoryId: manifest.repositoryId },
    },
    {
      id: commitId,
      label: "Commit",
      properties: { sha: manifest.commitSha },
    },
    {
      id: environmentId,
      label: "Environment",
      properties: { name: manifest.environment, criticality: manifest.criticality },
    },
    {
      id: manifest.deploymentId,
      label: "Deployment",
      properties: {
        startedAt: manifest.startedAt,
        ...(manifest.endedAt === null ? {} : { endedAt: manifest.endedAt }),
        status: manifest.endedAt === null ? "active" : "completed",
      },
    },
  ];

  const relationships: GraphRelationshipRecord[] = [
    relationship("OWNS", organizationId, "Organization", repositoryId, "Repository"),
    relationship("CONTAINS_SERVICE", repositoryId, "Repository", serviceId, "Service"),
    relationship("HAS_COMMIT", repositoryId, "Repository", commitId, "Commit"),
    relationship("HAS_DEPLOYMENT", serviceId, "Service", manifest.deploymentId, "Deployment"),
    relationship("RUNS_COMMIT", manifest.deploymentId, "Deployment", commitId, "Commit"),
    relationship(
      "IN_ENVIRONMENT",
      manifest.deploymentId,
      "Deployment",
      environmentId,
      "Environment",
    ),
    relationship(
      "USES_SNAPSHOT",
      manifest.deploymentId,
      "Deployment",
      snapshot.id,
      "LockfileSnapshot",
    ),
  ];

  return { nodes, relationships };
}

function assertManifestMatchesSnapshot(
  manifest: DeploymentManifest,
  snapshot: Pick<
    NormalizedSnapshot["snapshot"],
    "repositoryId" | "commitSha" | "contentHash" | "sourceRef"
  >,
): void {
  if (manifest.repositoryId !== snapshot.repositoryId) {
    throw new Error("Deployment repositoryId does not match the lockfile snapshot");
  }
  if (manifest.commitSha !== snapshot.commitSha) {
    throw new Error("Deployment commitSha does not match the lockfile snapshot");
  }
  if (manifest.lockfileSha256 !== snapshot.contentHash) {
    throw new Error("Deployment lockfile hash does not match the lockfile snapshot");
  }
  const manifestFile = manifest.lockfile.replaceAll("\\", "/").split("/").at(-1);
  const snapshotFile = snapshot.sourceRef.replaceAll("\\", "/").split("/").at(-1);
  if (manifestFile !== snapshotFile) {
    throw new Error("Deployment lockfile does not match the parsed lockfile source");
  }
}

function relationship<T extends GraphRelationshipRecord["type"]>(
  type: T,
  from: StableId,
  fromLabel: Extract<GraphRelationshipRecord, { type: T }>["from"]["label"],
  to: StableId,
  toLabel: Extract<GraphRelationshipRecord, { type: T }>["to"]["label"],
): Extract<GraphRelationshipRecord, { type: T }> {
  return {
    id: graphRelationshipId({ type, from, to }),
    type,
    from: { id: from, label: fromLabel },
    to: { id: to, label: toLabel },
    properties: {},
  } as Extract<GraphRelationshipRecord, { type: T }>;
}
