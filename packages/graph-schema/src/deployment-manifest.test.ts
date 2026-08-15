import {
  parseDeploymentManifest,
  stableIdFromCanonicalKey,
} from "@hydratrace/domain";
import { describe, expect, it } from "vitest";
import { deploymentManifestToGraphRecords } from "./deployment-manifest.js";

describe("deployment graph conversion", () => {
  it("connects organization, service, deployment, commit, environment, and snapshot", () => {
    const manifest = parseDeploymentManifest(
      JSON.stringify({
        schemaVersion: 1,
        organizationId: "acme",
        repositoryId: "acme/checkout",
        serviceId: "checkout",
        environment: "production",
        commitSha: "abc123",
        startedAt: "2026-08-15T09:00:00.000Z",
        endedAt: null,
        lockfile: "package-lock.json",
      }),
      "a".repeat(64),
    );
    const records = deploymentManifestToGraphRecords(manifest, {
      id: stableIdFromCanonicalKey("snapshot:test"),
      repositoryId: "acme/checkout",
      commitSha: "abc123",
      contentHash: "a".repeat(64),
      sourceRef: "package-lock.json",
    });

    expect(records.nodes).toHaveLength(6);
    expect(records.relationships.map(({ type }) => type).sort()).toEqual(
      [
        "CONTAINS_SERVICE",
        "HAS_COMMIT",
        "HAS_DEPLOYMENT",
        "IN_ENVIRONMENT",
        "OWNS",
        "RUNS_COMMIT",
        "USES_SNAPSHOT",
      ].sort(),
    );
  });

  it("refuses to link a deployment to a snapshot from another repository", () => {
    const manifest = parseDeploymentManifest(
      JSON.stringify({
        schemaVersion: 1,
        organizationId: "acme",
        repositoryId: "acme/checkout",
        serviceId: "checkout",
        environment: "production",
        commitSha: "abc123",
        startedAt: "2026-08-15T09:00:00.000Z",
        endedAt: null,
        lockfile: "package-lock.json",
      }),
      "a".repeat(64),
    );
    expect(() =>
      deploymentManifestToGraphRecords(manifest, {
        id: stableIdFromCanonicalKey("snapshot:other"),
        repositoryId: "acme/other",
        commitSha: "abc123",
        contentHash: "a".repeat(64),
        sourceRef: "package-lock.json",
      }),
    ).toThrow(/repositoryId/);
  });
});
