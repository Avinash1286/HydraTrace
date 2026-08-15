import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDeploymentManifest } from "@hydratrace/domain";
import {
  deploymentManifestToGraphRecords,
  normalizedSnapshotToGraphRecords,
} from "@hydratrace/graph-schema";
import { InMemoryGraphStore } from "@hydratrace/hydradb-client";
import { parseLockfile } from "@hydratrace/lockfile-parsers";

interface ExpectedResults {
  globalCounts: {
    snapshotCount: number;
    packageCount: number;
    packageVersionCount: number;
    resolutionCount: number;
    dependencyEdgeCount: number;
    containsEdgeCount: number;
    instanceOfEdgeCount: number;
    versionOfEdgeCount: number;
  };
  repositories: Array<{
    repositoryId: string;
    lockfile: string;
  }>;
}

const fixtureRoot = resolve("fixtures");
const expected = JSON.parse(
  await readFile(resolve(fixtureRoot, "expected-results/acme-commerce.normalized.json"), "utf8"),
) as ExpectedResults;
const store = new InMemoryGraphStore();
let createdNodes = 0;
let createdRelationships = 0;
const normalizedSnapshots = [];

for (const repository of expected.repositories) {
  const repositoryDirectory = resolve(fixtureRoot, repository.repositoryId);
  const lockfileName = repository.lockfile.split("/").at(-1);
  if (lockfileName === undefined) throw new Error("Fixture lockfile name is missing");
  const [rawLockfile, rawPackage, rawDeployment] = await Promise.all([
    readFile(resolve(repositoryDirectory, lockfileName), "utf8"),
    readFile(resolve(repositoryDirectory, "package.json"), "utf8"),
    readFile(resolve(repositoryDirectory, "hydratrace-deployment.json"), "utf8"),
  ]);
  const rootPackage = JSON.parse(rawPackage) as { name: string; version: string };
  const deploymentInput = JSON.parse(rawDeployment) as {
    commitSha: string;
    startedAt: string;
  };
  const normalized = parseLockfile(rawLockfile, {
    repositoryId: repository.repositoryId,
    commitSha: deploymentInput.commitSha,
    sourceRef: lockfileName,
    observedAt: Date.parse(deploymentInput.startedAt),
    rootPackage,
  });
  const deployment = parseDeploymentManifest(rawDeployment, normalized.snapshot.contentHash);
  if (deployment.commitSha !== normalized.snapshot.commitSha) {
    throw new Error(`Deployment/lockfile commit mismatch for ${repository.repositoryId}`);
  }
  if (deployment.repositoryId !== normalized.snapshot.repositoryId) {
    throw new Error(`Deployment/lockfile repository mismatch for ${repository.repositoryId}`);
  }
  const normalizedRecords = normalizedSnapshotToGraphRecords(normalized);
  const deploymentRecords = deploymentManifestToGraphRecords(
    deployment,
    normalized.snapshot,
  );
  const write = await store.write({
    nodes: [...normalizedRecords.nodes, ...deploymentRecords.nodes],
    relationships: [
      ...normalizedRecords.relationships,
      ...deploymentRecords.relationships,
    ],
  });
  createdNodes += write.nodes.created;
  createdRelationships += write.relationships.created;
  normalizedSnapshots.push(normalized);
}

const expectedSnapshotNodes =
  expected.globalCounts.snapshotCount +
  expected.globalCounts.packageCount +
  expected.globalCounts.packageVersionCount +
  expected.globalCounts.resolutionCount;
const expectedSnapshotRelationships =
  expected.globalCounts.dependencyEdgeCount +
  expected.globalCounts.containsEdgeCount +
  expected.globalCounts.instanceOfEdgeCount +
  expected.globalCounts.versionOfEdgeCount;
// Organization and production Environment are shared; repository/service/commit/deployment are per fixture.
const expectedDeploymentNodes = 2 + expected.repositories.length * 4;
const expectedDeploymentRelationships = expected.repositories.length * 7;
const expectedNodes = expectedSnapshotNodes + expectedDeploymentNodes;
const expectedRelationships = expectedSnapshotRelationships + expectedDeploymentRelationships;
if (createdNodes !== expectedNodes || createdRelationships !== expectedRelationships) {
  throw new Error(
    `Known-answer import counts differed: nodes ${createdNodes}/${expectedNodes}, relationships ${createdRelationships}/${expectedRelationships}`,
  );
}

for (const normalized of normalizedSnapshots) {
  const repositoryDirectory = resolve(fixtureRoot, normalized.snapshot.repositoryId);
  const rawDeployment = await readFile(
    resolve(repositoryDirectory, "hydratrace-deployment.json"),
    "utf8",
  );
  const deployment = parseDeploymentManifest(
    rawDeployment,
    normalized.snapshot.contentHash,
  );
  const normalizedRecords = normalizedSnapshotToGraphRecords(normalized);
  const deploymentRecords = deploymentManifestToGraphRecords(
    deployment,
    normalized.snapshot,
  );
  const repeated = await store.write({
    nodes: [...normalizedRecords.nodes, ...deploymentRecords.nodes],
    relationships: [
      ...normalizedRecords.relationships,
      ...deploymentRecords.relationships,
    ],
  });
  if (repeated.nodes.created !== 0 || repeated.relationships.created !== 0) {
    throw new Error(`Repeated import created duplicates for ${normalized.snapshot.repositoryId}`);
  }
}

await store.close();
process.stdout.write(
  `${JSON.stringify(
    {
      status: "passed",
      snapshots: normalizedSnapshots.length,
      graph: {
        nodes: createdNodes,
        relationships: createdRelationships,
      },
      repeatedImportCreated: { nodes: 0, relationships: 0 },
    },
    null,
    2,
  )}\n`,
);
