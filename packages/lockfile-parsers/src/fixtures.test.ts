import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  DependencyKind,
  NormalizedSnapshot,
} from "@hydratrace/domain";
import { describe, expect, it } from "vitest";
import { parseLockfile } from "./index.js";

interface ExpectedRepository {
  repositoryId: string;
  lockfile: string;
  counts: {
    packageCount: number;
    packageVersionCount: number;
    resolutionCount: number;
    dependencyEdgeCount: number;
    warningCount: number;
  };
  resolutions: Array<{ locator: string }>;
  edges: Array<{ from: string; to: string; kind: string }>;
  expectedPaths: {
    affectedAll: string[][];
    affectedProduction: string[][];
    safeControl: string[][];
  };
}

interface ExpectedResults {
  repositories: ExpectedRepository[];
}

const fixtureRoot = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

describe("Acme Commerce known-answer fixtures", () => {
  it("matches exact resolution, edge, warning, and path expectations", async () => {
    const expected = JSON.parse(
      await readFile(`${fixtureRoot}/expected-results/acme-commerce.normalized.json`, "utf8"),
    ) as ExpectedResults;

    for (const repository of expected.repositories) {
      const repositoryDirectory = `${fixtureRoot}/${repository.repositoryId}`;
      const deployment = JSON.parse(
        await readFile(`${repositoryDirectory}/hydratrace-deployment.json`, "utf8"),
      ) as { commitSha: string; startedAt: string };
      const rootPackage = JSON.parse(
        await readFile(`${repositoryDirectory}/package.json`, "utf8"),
      ) as { name: string; version: string };
      const lockfileName = repository.lockfile.split("/").at(-1);
      if (lockfileName === undefined) throw new Error("Expected fixture lockfile name");
      const rawLockfile = await readFile(`${repositoryDirectory}/${lockfileName}`, "utf8");
      const snapshot = parseLockfile(rawLockfile, {
        repositoryId: repository.repositoryId,
        commitSha: deployment.commitSha,
        sourceRef: lockfileName,
        observedAt: Date.parse(deployment.startedAt),
        rootPackage,
      });

      expectSnapshotCounts(snapshot, repository);
      expect(snapshot.resolutions.map(({ sourceKey }) => sourceKey).sort()).toEqual(
        repository.resolutions.map(({ locator }) => locator).sort(),
      );

      const resolutionById = new Map(
        snapshot.resolutions.map((resolution) => [resolution.id, resolution]),
      );
      const actualEdges = snapshot.edges
        .map((edge) => ({
          from: resolutionById.get(edge.fromResolutionId)?.sourceKey,
          to: resolutionById.get(edge.toResolutionId)?.sourceKey,
          kind: expectedKind(edge.kind),
        }))
        .sort(compareEdges);
      expect(actualEdges).toEqual([...repository.edges].sort(compareEdges));

      const affectedAll = findPaths(snapshot, "compromised-helper", "1.4.2", false);
      const affectedProduction = findPaths(snapshot, "compromised-helper", "1.4.2", true);
      const safeControl = findPaths(snapshot, "compromised-helper", "1.4.3", true);
      expect(sortPaths(affectedAll)).toEqual(sortPaths(repository.expectedPaths.affectedAll));
      expect(sortPaths(affectedProduction)).toEqual(
        sortPaths(repository.expectedPaths.affectedProduction),
      );
      expect(sortPaths(safeControl)).toEqual(sortPaths(repository.expectedPaths.safeControl));
    }
  });
});

function expectSnapshotCounts(
  snapshot: NormalizedSnapshot,
  expected: ExpectedRepository,
): void {
  expect(new Set(snapshot.packages.map(({ packageId }) => packageId)).size).toBe(
    expected.counts.packageCount,
  );
  expect(snapshot.packages).toHaveLength(expected.counts.packageVersionCount);
  expect(snapshot.resolutions).toHaveLength(expected.counts.resolutionCount);
  expect(snapshot.edges).toHaveLength(expected.counts.dependencyEdgeCount);
  expect(snapshot.warnings).toHaveLength(expected.counts.warningCount);
}

function expectedKind(kind: DependencyKind): string {
  switch (kind) {
    case "production":
      return "dependency";
    case "development":
      return "devDependency";
    case "optional":
      return "optionalDependency";
    case "peer":
      return "peerDependency";
  }
}

function compareEdges(
  left: { from: string | undefined; to: string | undefined; kind: string },
  right: { from: string | undefined; to: string | undefined; kind: string },
): number {
  return `${left.from}:${left.to}:${left.kind}`.localeCompare(
    `${right.from}:${right.to}:${right.kind}`,
  );
}

function findPaths(
  snapshot: NormalizedSnapshot,
  packageName: string,
  version: string,
  productionOnly: boolean,
): string[][] {
  const resolutionById = new Map(
    snapshot.resolutions.map((resolution) => [resolution.id, resolution]),
  );
  const roots = snapshot.resolutions.filter(({ root }) => root);
  const targets = new Set(
    snapshot.resolutions
      .filter(
        (resolution) =>
          resolution.packageName === packageName && resolution.version === version,
      )
      .map(({ id }) => id),
  );
  const adjacency = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    const values = adjacency.get(edge.fromResolutionId) ?? [];
    values.push(edge.toResolutionId);
    adjacency.set(edge.fromResolutionId, values);
  }
  const paths: string[][] = [];

  const visit = (currentId: string, path: string[], seen: Set<string>): void => {
    const resolution = resolutionById.get(currentId as NormalizedSnapshot["snapshot"]["id"]);
    if (resolution === undefined) return;
    if (productionOnly && resolution.dev) return;
    const nextPath = [...path, resolution.sourceKey];
    if (targets.has(resolution.id)) {
      paths.push(nextPath);
      return;
    }
    if (nextPath.length > 20) return;
    for (const targetId of adjacency.get(currentId) ?? []) {
      if (seen.has(targetId)) continue;
      visit(targetId, nextPath, new Set([...seen, targetId]));
    }
  };

  for (const root of roots) visit(root.id, [], new Set([root.id]));
  return paths;
}

function sortPaths(paths: string[][]): string[][] {
  return paths.map((path) => [...path]).sort((left, right) => left.join("→").localeCompare(right.join("→")));
}
