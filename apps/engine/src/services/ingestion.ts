import type {
  DeploymentManifest,
  LockfileParserOptions,
  NormalizedSnapshot,
  StableId,
} from "@hydratrace/domain";
import { parseDeploymentManifest, stableIdFromCanonicalKey } from "@hydratrace/domain";
import {
  deploymentManifestToGraphRecords,
  normalizedSnapshotToGraphRecords,
  type GraphRelationshipRecord,
} from "@hydratrace/graph-schema";
import type { GraphStore, GraphWriteSummary } from "@hydratrace/hydradb-client";
import { parseLockfile } from "@hydratrace/lockfile-parsers";

export interface IngestLockfileInput {
  content: string;
  options: LockfileParserOptions;
  deploymentManifest?: string;
}

export interface IngestLockfileResult {
  normalized: NormalizedSnapshot;
  deployment?: DeploymentManifest;
  graphWrite: GraphWriteSummary;
}

export async function ingestLockfile(
  store: GraphStore,
  input: IngestLockfileInput,
): Promise<IngestLockfileResult> {
  const normalized = parseLockfile(input.content, input.options);
  const normalizedRecords = normalizedSnapshotToGraphRecords(normalized);
  const deployment =
    input.deploymentManifest === undefined
      ? undefined
      : parseDeploymentManifest(input.deploymentManifest, normalized.snapshot.contentHash);
  if (deployment !== undefined) {
    assertDeploymentMatchesSnapshot(deployment, normalized);
  }
  const deploymentRecords =
    deployment === undefined
      ? { nodes: [], relationships: [] }
      : deploymentManifestToGraphRecords(deployment, normalized.snapshot);
  const supersedes = await supersedesRelationship(store, normalized);
  const records = {
    nodes: [...normalizedRecords.nodes, ...deploymentRecords.nodes],
    relationships: [
      ...normalizedRecords.relationships,
      ...deploymentRecords.relationships,
      ...(supersedes === undefined ? [] : [supersedes]),
    ],
  };
  const graphWrite = await store.write(records);
  return {
    normalized,
    ...(deployment === undefined ? {} : { deployment }),
    graphWrite,
  };
}

async function supersedesRelationship(
  store: GraphStore,
  normalized: NormalizedSnapshot,
): Promise<GraphRelationshipRecord<"SUPERSEDES"> | undefined> {
  const existing = await store.matchNodes({
    label: "LockfileSnapshot",
    equals: { repositoryId: normalized.snapshot.repositoryId },
    limit: 10_000,
  });
  const previous = existing
    .filter((node) =>
      node.label === "LockfileSnapshot" &&
      node.id !== normalized.snapshot.id &&
      node.properties.createdAt <= normalized.snapshot.createdAt)
    .sort((left, right) =>
      (right.properties as { createdAt: number }).createdAt -
        (left.properties as { createdAt: number }).createdAt ||
      right.id.localeCompare(left.id))[0];
  if (previous === undefined) return undefined;
  const id = stableIdFromCanonicalKey(
    `supersedes:${normalized.snapshot.id}:${previous.id}`,
  ) as StableId;
  return {
    id,
    type: "SUPERSEDES",
    from: { id: normalized.snapshot.id, label: "LockfileSnapshot" },
    to: { id: previous.id, label: "LockfileSnapshot" },
    properties: {},
  };
}

function assertDeploymentMatchesSnapshot(
  deployment: DeploymentManifest,
  normalized: NormalizedSnapshot,
): void {
  if (deployment.repositoryId !== normalized.snapshot.repositoryId) {
    throw new Error("Deployment repositoryId does not match the lockfile snapshot");
  }
  if (deployment.commitSha !== normalized.snapshot.commitSha) {
    throw new Error("Deployment commitSha does not match the lockfile snapshot");
  }
  const normalizedLockfile = deployment.lockfile.replaceAll("\\", "/").split("/").at(-1);
  const normalizedSource = normalized.snapshot.sourceRef
    .replaceAll("\\", "/")
    .split("/")
    .at(-1);
  if (normalizedLockfile !== normalizedSource) {
    throw new Error("Deployment lockfile does not match the parsed lockfile source");
  }
  if (deployment.lockfileSha256 !== normalized.snapshot.contentHash) {
    throw new Error("Deployment lockfile hash does not match the parsed snapshot");
  }
}
