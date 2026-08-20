import { InMemoryGraphStore } from "@hydratrace/hydradb-client";
import { describe, expect, it } from "vitest";
import { buildEngine } from "./engine.js";

const repositoryId = "fixture/baseline-comparison";
const baselineCommit = "a".repeat(40);
const currentCommit = "b".repeat(40);
const nextCommit = "c".repeat(40);

describe("atomic immutable incident comparison", () => {
  it("blocks only a new proven high-risk path and passes an identical exact snapshot", async () => {
    const application = buildEngine({
      graphStore: new InMemoryGraphStore(),
      scanEnrichmentEnabled: false,
    });
    const baseline = await ingest(application, baselineCommit, "safe-package");
    const current = await ingest(application, currentCommit, "affected-package");
    expect(baseline.statusCode, baseline.body).toBe(201);
    expect(current.statusCode, current.body).toBe(201);

    const reachability = await addStaticReachability(
      application,
      current.json().snapshot.id as string,
      currentCommit,
    );
    expect(reachability.statusCode, reachability.body).toBe(201);

    const incident = await application.inject({
      method: "POST",
      url: "/v1/incidents",
      body: {
        ecosystem: "npm",
        packageName: "affected-package",
        affectedVersions: ["1.0.0"],
        startsAt: 0,
        severityScore: 1,
        trustContextScore: 1,
      },
    });
    expect(incident.statusCode, incident.body).toBe(201);
    const incidentId = incident.json().incident.id as string;

    const blocked = await application.inject({
      method: "POST",
      url: `/v1/incidents/${incidentId}/comparison`,
      body: {
        baseline: { kind: "commit", repositoryId, commitSha: baselineCommit },
        current: { kind: "commit", repositoryId, commitSha: currentCommit },
      },
    });
    expect(blocked.statusCode, blocked.body).toBe(200);
    expect(blocked.json()).toMatchObject({
      comparison: {
        status: "BLOCK",
        baseline: { blockingPaths: 0 },
        current: { blockingPaths: 1 },
        newBlockingPaths: [{
          repositoryId,
          serviceId: "comparison-service",
          affectedPackageName: "affected-package",
          affectedVersion: "1.0.0",
          reachability: 2,
          risk: "High",
        }],
        reasons: [],
      },
      baseline: { snapshotIds: [baseline.json().snapshot.id] },
      current: { snapshotIds: [current.json().snapshot.id] },
    });

    const passed = await application.inject({
      method: "POST",
      url: `/v1/incidents/${incidentId}/comparison`,
      body: {
        baseline: { kind: "snapshot", snapshotId: current.json().snapshot.id },
        current: { kind: "snapshot", snapshotId: current.json().snapshot.id },
      },
    });
    expect(passed.statusCode, passed.body).toBe(200);
    expect(passed.json()).toMatchObject({
      comparison: {
        status: "PASS",
        baseline: { blockingPaths: 1 },
        current: { blockingPaths: 1 },
        newBlockingPaths: [],
        reasons: [],
      },
    });

    const next = await ingest(application, nextCommit, "affected-package", "2.0.0");
    expect(next.statusCode, next.body).toBe(201);
    expect((await addStaticReachability(
      application,
      next.json().snapshot.id as string,
      nextCommit,
    )).statusCode).toBe(201);
    const unchangedAcrossSnapshots = await application.inject({
      method: "POST",
      url: `/v1/incidents/${incidentId}/comparison`,
      body: {
        baseline: { kind: "commit", repositoryId, commitSha: currentCommit },
        current: { kind: "commit", repositoryId, commitSha: nextCommit },
      },
    });
    expect(unchangedAcrossSnapshots.statusCode, unchangedAcrossSnapshots.body).toBe(200);
    expect(unchangedAcrossSnapshots.json()).toMatchObject({
      comparison: {
        status: "PASS",
        baseline: { blockingPaths: 1 },
        current: { blockingPaths: 1 },
        newBlockingPaths: [],
      },
    });
    await application.close();
  });

  it("returns INCONCLUSIVE for a scan ID that has no durable graph link", async () => {
    const application = buildEngine({ graphStore: new InMemoryGraphStore() });
    const snapshot = await ingest(application, currentCommit, "affected-package");
    const incident = await application.inject({
      method: "POST",
      url: "/v1/incidents",
      body: {
        ecosystem: "npm",
        packageName: "affected-package",
        affectedVersions: ["1.0.0"],
      },
    });
    const response = await application.inject({
      method: "POST",
      url: `/v1/incidents/${incident.json().incident.id}/comparison`,
      body: {
        baseline: { kind: "scan", scanId: "123" },
        current: { kind: "snapshot", snapshotId: snapshot.json().snapshot.id },
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      comparison: {
        status: "INCONCLUSIVE",
        newBlockingPaths: [],
        reasons: [{ code: "SCAN_SELECTOR_UNAVAILABLE" }],
      },
    });
    await application.close();
  });
});

function ingest(
  application: ReturnType<typeof buildEngine>,
  commitSha: string,
  dependencyName: string,
  rootVersion = "1.0.0",
) {
  const startedAt = "2026-08-15T09:00:00.000Z";
  return application.inject({
    method: "POST",
    url: "/v1/scans/lockfile",
    body: {
      content: JSON.stringify({
        name: "comparison-app",
        version: rootVersion,
        lockfileVersion: 3,
        packages: {
          "": {
            name: "comparison-app",
            version: rootVersion,
            dependencies: { [dependencyName]: "1.0.0" },
          },
          [`node_modules/${dependencyName}`]: { version: "1.0.0" },
        },
      }),
      sourceRef: "package-lock.json",
      repositoryId,
      commitSha,
      observedAt: Date.parse(startedAt),
      deploymentManifest: JSON.stringify({
        schemaVersion: 1,
        organizationId: "fixture",
        repositoryId,
        serviceId: "comparison-service",
        environment: "production",
        commitSha,
        startedAt,
        endedAt: null,
        lockfile: "package-lock.json",
      }),
    },
  });
}

function addStaticReachability(
  application: ReturnType<typeof buildEngine>,
  snapshotId: string,
  commitSha: string,
) {
  return application.inject({
    method: "POST",
    url: "/v1/reachability/static",
    body: {
      snapshotId,
      repositoryId,
      commitSha,
      observedAt: 3,
      entrypoints: ["src/index.ts"],
      files: [{ path: "src/index.ts", source: 'import "affected-package";' }],
    },
  });
}
