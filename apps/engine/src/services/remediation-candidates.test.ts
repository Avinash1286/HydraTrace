import { sha256Hex, type OsvPackageQuery, type StableId } from "@hydratrace/domain";
import type { NpmAvailableVersion, OsvExactQueryResult } from "@hydratrace/ecosystem-enrichment";
import type { BlastRadiusResult, IncidentRecord } from "@hydratrace/incident-analysis";
import type { LockfileSimulationResult } from "@hydratrace/remediation";
import { describe, expect, it, vi } from "vitest";
import {
  discoverRemediationCandidates,
  type RemediationCandidateDiscoveryDependencies,
  type RemediationSourceArtifact,
} from "./remediation-candidates.js";

const snapshotId = "100" as StableId;
const pathId = "200" as StableId;
const packageLock = JSON.stringify({
  name: "fixture",
  version: "1.0.0",
  lockfileVersion: 3,
  packages: {
    "": { name: "fixture", version: "1.0.0", dependencies: { gateway: "1.0.0" } },
    "node_modules/gateway": { version: "1.0.0", dependencies: { vulnerable: "2.0.0" } },
    "node_modules/vulnerable": { version: "2.0.0" },
  },
});

const artifact: RemediationSourceArtifact = {
  snapshotId,
  packageJson: JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { gateway: "1.0.0" } }),
  packageLock,
  repositoryId: "fixture/repository",
  commitSha: "abc123",
};

const incident = {
  id: "300" as StableId,
  ecosystem: "npm",
  packageName: "vulnerable",
  normalizedPackageName: "vulnerable",
  affectedVersions: ["2.0.0"],
} as unknown as IncidentRecord;

const blast = {
  incidentId: incident.id,
  pathsTruncated: false,
  findings: [{
    snapshotId,
    repositoryId: artifact.repositoryId,
    commitSha: artifact.commitSha,
    lockfileSourceRef: "package-lock.json",
    lockfileSha256: sha256Hex(packageLock),
    serviceId: "api",
    displayedPaths: [{
      pathId,
      evidenceRefs: ["E-PATH-200"],
      nodes: [
        { packageName: "fixture", version: "1.0.0", direct: false },
        { packageName: "gateway", version: "1.0.0", direct: true },
        { packageName: "vulnerable", version: "2.0.0", direct: false },
      ],
    }],
  }],
} as unknown as BlastRadiusResult;

describe("evidence-backed remediation candidate discovery", () => {
  it("recommends an existing safe release only after a bounded no-script lockfile simulation", async () => {
    const simulateLockfile = vi.fn(async () => simulation("1.0.1"));
    const result = await discoverRemediationCandidates(
      blast,
      incident,
      [artifact],
      dependencies({ versions: [release("1.0.1")], simulateLockfile }),
      { requestedVersions: { gateway: ["1.0.1"] }, simulationTimeoutMs: 2_000 },
    );

    expect(result).toMatchObject({ state: "READY", complete: true, simulationsAttempted: 1 });
    expect(result.candidates).toEqual([
      expect.objectContaining({
        dependencyName: "gateway",
        fromVersion: "1.0.0",
        toVersion: "1.0.1",
        deprecated: false,
        knownVulnerable: false,
        verification: "LOCKFILE_VERIFIED",
        eliminatedPathIds: [pathId],
      }),
    ]);
    expect(result.evidence[0]).toMatchObject({
      registry: { exactVersion: "1.0.1", deprecated: false },
      osv: { exactVersion: "1.0.1", advisoryIds: [] },
      simulation: {
        command: ["npm", "install", "--package-lock-only", "--ignore-scripts", "--audit=false", "--fund=false"],
        affectedPathCount: 0,
        resolvedDependencyVersions: ["1.0.1"],
      },
    });
    expect(simulateLockfile).toHaveBeenCalledWith(expect.objectContaining({
      dependencyName: "gateway",
      toVersion: "1.0.1",
      timeoutMs: 2_000,
    }));
  });

  it("rejects an exact version with an OSV match without running npm", async () => {
    const simulateLockfile = vi.fn(async () => simulation("1.0.1"));
    const result = await discoverRemediationCandidates(
      blast,
      incident,
      [artifact],
      dependencies({
        versions: [release("1.0.1")],
        advisoryIds: ["GHSA-known-vulnerable"],
        simulateLockfile,
      }),
      { requestedVersions: { gateway: ["1.0.1"] } },
    );

    expect(result.state).toBe("NO_SAFE_CANDIDATE");
    expect(result.candidates).toEqual([]);
    expect(result.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "KNOWN_VULNERABLE_VERSION", toVersion: "1.0.1" }),
    ]));
    expect(simulateLockfile).not.toHaveBeenCalled();
  });

  it("rejects a candidate when the regenerated lockfile retains an affected path", async () => {
    const simulateLockfile = vi.fn(async () => ({
      ...simulation("1.0.1"),
      affectedPathCount: 1,
      verification: "FAILED" as const,
    }));
    const result = await discoverRemediationCandidates(
      blast,
      incident,
      [artifact],
      dependencies({ versions: [release("1.0.1")], simulateLockfile }),
      { requestedVersions: { gateway: ["1.0.1"] } },
    );

    expect(result.candidates).toEqual([]);
    expect(result.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "AFFECTED_PATHS_REMAIN", toVersion: "1.0.1" }),
    ]));
  });

  it("rejects deprecated and nonexistent versions from exact registry metadata", async () => {
    const result = await discoverRemediationCandidates(
      blast,
      incident,
      [artifact],
      dependencies({ versions: [release("1.0.1", "superseded")] }),
      { requestedVersions: { gateway: ["1.0.1", "1.0.9"] } },
    );

    expect(result.state).toBe("NO_SAFE_CANDIDATE");
    expect(result.candidates).toEqual([]);
    expect(result.rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "DEPRECATED_VERSION", toVersion: "1.0.1" }),
      expect.objectContaining({ reason: "NONEXISTENT_VERSION", toVersion: "1.0.9" }),
    ]));
  });

  it.each(["npm-registry", "osv"] as const)("preserves an explicit inconclusive result during a %s outage", async (provider) => {
    const base = dependencies({ versions: [release("1.0.1")] });
    const failing = provider === "npm-registry"
      ? { ...base, npmRegistryClient: { listVersions: vi.fn(async () => { throw new Error("registry unavailable"); }) } }
      : { ...base, osvClient: { queryExactPackages: vi.fn(async () => { throw new Error("OSV unavailable"); }) } };
    const result = await discoverRemediationCandidates(
      blast,
      incident,
      [artifact],
      failing,
      { requestedVersions: { gateway: ["1.0.1"] } },
    );

    expect(result).toMatchObject({ state: "INCONCLUSIVE", complete: false, candidates: [] });
    expect(result.providerErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider }),
    ]));
  });
});

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

function dependencies(options: {
  versions: NpmAvailableVersion[];
  advisoryIds?: string[];
  simulateLockfile?: RemediationCandidateDiscoveryDependencies["simulateLockfile"];
}): RemediationCandidateDiscoveryDependencies {
  return {
    npmRegistryClient: { listVersions: vi.fn(async () => options.versions) },
    osvClient: {
      queryExactPackages: vi.fn(async (queries: readonly OsvPackageQuery[]): Promise<OsvExactQueryResult[]> => queries.map((query) => ({
        query,
        advisoryIds: options.advisoryIds ?? [],
        advisories: [],
        provenance: {
          source: "osv",
          matchType: "exact-package-version",
          queryUrl: "https://api.osv.dev/v1/querybatch",
          advisoryUrls: (options.advisoryIds ?? []).map((id) => `https://api.osv.dev/v1/vulns/${id}`),
        },
      }))),
    },
    simulateLockfile: options.simulateLockfile ?? vi.fn(async (input) => simulation(input.toVersion)),
  };
}

function simulation(version: string): LockfileSimulationResult {
  return {
    command: ["npm", "install", "--package-lock-only", "--ignore-scripts", "--audit=false", "--fund=false"],
    exitCode: 0,
    timedOut: false,
    affectedPathCount: 0,
    resolvedDependencyVersions: [version],
    lockfileChurn: 4,
    verification: "LOCKFILE_VERIFIED",
    stdout: "",
    stderr: "",
    resultingPackageLock: "{}",
  };
}
