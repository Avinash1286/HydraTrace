import { type OsvPackageQuery } from "@hydratrace/domain";
import type { NpmAvailableVersion } from "@hydratrace/ecosystem-enrichment";
import { InMemoryGraphStore } from "@hydratrace/hydradb-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEngine } from "./engine.js";

const startedAt = Date.parse("2026-08-15T09:04:00.000Z");
const repositoryId = "fixture/remediation-safety";
const initialCommit = "affected123";
const packageJson = JSON.stringify({
  name: "fixture",
  version: "1.0.0",
  dependencies: { gateway: "1.0.0" },
});
const affectedLock = lockfile("1.0.0", true);

describe("remediation safety API", () => {
  const applications: ReturnType<typeof buildEngine>[] = [];
  afterEach(async () => {
    await Promise.all(applications.splice(0).map(async (application) => application.close()));
  });

  it("runs safe discovery through set cover and passes only a strong zero-path graph verification", async () => {
    const graphStore = new InMemoryGraphStore();
    const relationshipSpy = vi.spyOn(graphStore, "matchRelationships");
    const application = engine(graphStore, {
      versions: [release("1.0.1")],
    });
    applications.push(application);
    const fixture = await seedAffected(application);

    const discovery = await discover(application, fixture, affectedLock);
    expect(discovery.statusCode, discovery.body).toBe(200);
    expect(discovery.json()).toMatchObject({
      state: "READY",
      complete: true,
      candidates: [expect.objectContaining({
        toVersion: "1.0.1",
        verification: "LOCKFILE_VERIFIED",
      })],
    });

    const plan = await application.inject({
      method: "POST",
      url: `/v1/incidents/${fixture.incidentId}/remediations`,
      body: { candidates: discovery.json().candidates },
    });
    expect(plan.statusCode, plan.body).toBe(201);
    expect(plan.json().solution).toMatchObject({ uncoveredPathIds: [] });

    const staleSafe = await scan(application, {
      content: lockfile("1.0.1", false),
      commitSha: "stale-safe",
      startedAt: startedAt - 120_000,
      endedAt: startedAt - 60_000,
    });
    const staleVerification = await application.inject({
      method: "POST",
      url: `/v1/remediations/${plan.json().runId}/verify`,
      body: { snapshotId: staleSafe.snapshotId },
    });
    expect(staleVerification.json()).toMatchObject({
      status: "INCONCLUSIVE",
      verification: {
        remainingPathCount: 0,
        passed: false,
        message: expect.stringContaining("missing active fixed snapshots"),
      },
    });

    const fixed = await scan(application, {
      content: lockfile("1.0.1", false),
      commitSha: "fixed456",
      startedAt: startedAt + 60_000,
    });
    relationshipSpy.mockClear();
    const verified = await application.inject({
      method: "POST",
      url: `/v1/remediations/${plan.json().runId}/verify`,
      body: { snapshotId: fixed.snapshotId },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json()).toMatchObject({
      status: "VERIFIED",
      verification: {
        level: "STRONG_GRAPH",
        remainingPathCount: 0,
        passed: true,
      },
    });
    expect(relationshipSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: "CONTAINS",
      from: { id: fixed.snapshotId, label: "LockfileSnapshot" },
    }));
  });

  it("rejects an exact candidate that OSV still marks vulnerable", async () => {
    const application = engine(new InMemoryGraphStore(), {
      versions: [release("1.0.1")],
      advisoryIds: ["GHSA-still-vulnerable"],
    });
    applications.push(application);
    const fixture = await seedAffected(application);
    const response = await discover(application, fixture, affectedLock);

    expect(response.json()).toMatchObject({ state: "NO_SAFE_CANDIDATE", candidates: [] });
    expect(response.json().rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "KNOWN_VULNERABLE_VERSION", toVersion: "1.0.1" }),
    ]));
  });

  it("rejects a deprecated exact registry release", async () => {
    const application = engine(new InMemoryGraphStore(), {
      versions: [release("1.0.1", "superseded")],
    });
    applications.push(application);
    const fixture = await seedAffected(application);
    const response = await discover(application, fixture, affectedLock);

    expect(response.json()).toMatchObject({ state: "NO_SAFE_CANDIDATE", candidates: [] });
    expect(response.json().rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "DEPRECATED_VERSION", toVersion: "1.0.1" }),
    ]));
  });

  it("returns INCONCLUSIVE instead of a safe negative during a provider outage", async () => {
    const application = engine(new InMemoryGraphStore(), {
      versions: [release("1.0.1")],
      registryError: new Error("registry unavailable"),
    });
    applications.push(application);
    const fixture = await seedAffected(application);
    const response = await discover(application, fixture, affectedLock);

    expect(response.json()).toMatchObject({ state: "INCONCLUSIVE", complete: false, candidates: [] });
    expect(response.json().providerErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "npm-registry", message: "registry unavailable" }),
    ]));
  });
});

function engine(
  graphStore: InMemoryGraphStore,
  options: {
    versions: NpmAvailableVersion[];
    advisoryIds?: string[];
    registryError?: Error;
  },
) {
  return buildEngine({
    graphStore,
    strongGraphReads: true,
    allowRootRemediationSimulation: true,
    scanEnrichmentEnabled: false,
    npmRegistryClient: {
      getVersion: vi.fn(async () => { throw new Error("not used"); }),
      listVersions: vi.fn(async () => {
        if (options.registryError !== undefined) throw options.registryError;
        return options.versions;
      }),
    },
    osvClient: {
      queryExactPackages: vi.fn(async (queries: readonly OsvPackageQuery[]) => queries.map((query) => ({
        query,
        advisoryIds: options.advisoryIds ?? [],
        advisories: [],
        provenance: {
          source: "osv" as const,
          matchType: "exact-package-version" as const,
          queryUrl: "https://api.osv.dev/v1/querybatch",
          advisoryUrls: (options.advisoryIds ?? []).map((id) => `https://api.osv.dev/v1/vulns/${id}`),
        },
      }))),
    },
    remediationSimulation: vi.fn(async (input) => ({
      command: ["npm", "install", "--package-lock-only", "--ignore-scripts", "--audit=false", "--fund=false", "--no-update-notifier"],
      exitCode: 0,
      timedOut: false,
      affectedPathCount: 0,
      resolvedDependencyVersions: [input.toVersion],
      lockfileChurn: 2,
      verification: "LOCKFILE_VERIFIED" as const,
      stdout: "",
      stderr: "",
      resultingPackageLock: lockfile(input.toVersion, false),
    })),
  });
}

async function seedAffected(application: ReturnType<typeof buildEngine>) {
  const scanned = await scan(application, {
    content: affectedLock,
    commitSha: initialCommit,
    startedAt,
  });
  const incident = await application.inject({
    method: "POST",
    url: "/v1/incidents",
    body: {
      ecosystem: "npm",
      packageName: "vulnerable",
      affectedVersions: ["2.0.0"],
      startsAt: startedAt - 1,
    },
  });
  expect(incident.statusCode, incident.body).toBe(201);
  return { snapshotId: scanned.snapshotId, incidentId: incident.json().incident.id as string };
}

async function discover(
  application: ReturnType<typeof buildEngine>,
  fixture: { snapshotId: string; incidentId: string },
  packageLock: string,
) {
  return application.inject({
    method: "POST",
    url: `/v1/incidents/${fixture.incidentId}/remediations/candidates`,
    body: {
      artifacts: [{
        snapshotId: fixture.snapshotId,
        packageJson,
        packageLock,
        repositoryId,
        commitSha: initialCommit,
      }],
      requestedVersions: { gateway: ["1.0.1"] },
    },
  });
}

async function scan(
  application: ReturnType<typeof buildEngine>,
  input: { content: string; commitSha: string; startedAt: number; endedAt?: number | null },
): Promise<{ snapshotId: string }> {
  const response = await application.inject({
    method: "POST",
    url: "/v1/scans/lockfile",
    body: {
      content: input.content,
      sourceRef: "package-lock.json",
      repositoryId,
      commitSha: input.commitSha,
      observedAt: input.startedAt,
      deploymentManifest: JSON.stringify({
        schemaVersion: 1,
        organizationId: "fixture",
        repositoryId,
        serviceId: "api",
        environment: "production",
        criticality: "production",
        commitSha: input.commitSha,
        startedAt: new Date(input.startedAt).toISOString(),
        endedAt: input.endedAt === undefined || input.endedAt === null
          ? null
          : new Date(input.endedAt).toISOString(),
        lockfile: "package-lock.json",
      }),
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return { snapshotId: response.json().snapshot.id as string };
}

function release(version: string, deprecated?: string): NpmAvailableVersion {
  return {
    name: "gateway",
    version,
    ...(deprecated === undefined ? {} : { deprecated }),
    provenance: {
      source: "npm-registry",
      matchType: "exact-package-version",
      packageUrl: "https://registry.npmjs.org/gateway",
    },
  };
}

function lockfile(gatewayVersion: string, affected: boolean): string {
  return JSON.stringify({
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture", version: "1.0.0", dependencies: { gateway: gatewayVersion } },
      "node_modules/gateway": {
        version: gatewayVersion,
        ...(affected ? { dependencies: { vulnerable: "2.0.0" } } : {}),
      },
      ...(affected ? { "node_modules/vulnerable": { version: "2.0.0" } } : {}),
    },
  });
}
