import { ReachabilityLevel, stableIdFromCanonicalKey, type StableId } from "@hydratrace/domain";
import { describe, expect, it } from "vitest";
import { compareImmutableBlastRadius } from "./comparison.js";
import type { BlastRadiusFinding, BlastRadiusResult, EvidencePath } from "./models.js";

describe("immutable blast-radius comparison", () => {
  it("uses semantic cross-snapshot signatures instead of snapshot/root IDs", () => {
    const baseline = result("baseline", [path("baseline", ["affected-package"], "1.0.0")]);
    const current = result("current", [path("current", ["affected-package"], "2.0.0")]);

    expect(compareImmutableBlastRadius(baseline, current)).toMatchObject({
      status: "PASS",
      baseline: { blockingPaths: 1 },
      current: { blockingPaths: 1 },
      newBlockingPaths: [],
      reasons: [],
    });

    const introduced = result("introduced", [
      path("introduced", ["new-wrapper", "affected-package"], "3.0.0"),
    ]);
    expect(compareImmutableBlastRadius(baseline, introduced)).toMatchObject({
      status: "BLOCK",
      newBlockingPaths: [{
        serviceId: "service",
        path: [
          { packageName: "application", version: "3.0.0" },
          { packageName: "new-wrapper", version: "1.0.0" },
          { packageName: "affected-package", version: "1.0.0" },
        ],
      }],
      reasons: [],
    });
  });

  it("fails closed for truncated, missing, or conflicting evidence", () => {
    const complete = result("complete", [path("complete", ["affected-package"], "1.0.0")]);
    const truncated = structuredClone(complete);
    truncated.pathsTruncated = true;
    truncated.findings[0]!.pathsTruncated = true;
    expect(compareImmutableBlastRadius(complete, truncated)).toMatchObject({
      status: "INCONCLUSIVE",
      newBlockingPaths: [],
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: "PATHS_TRUNCATED" }),
        expect.objectContaining({ code: "FINDING_PATHS_INCOMPLETE" }),
      ]),
    });

    const missing = structuredClone(complete);
    missing.findings[0]!.reachabilityEvidence = [];
    expect(compareImmutableBlastRadius(complete, missing)).toMatchObject({
      status: "INCONCLUSIVE",
      reasons: [expect.objectContaining({ code: "REACHABILITY_EVIDENCE_MISSING" })],
    });

    const conflicting = structuredClone(complete);
    const duplicate = structuredClone(conflicting.findings[0]!);
    duplicate.findingId = id("conflicting-finding");
    duplicate.deploymentId = id("conflicting-deployment");
    duplicate.risk = lowRisk();
    duplicate.displayedPaths[0]!.pathId = id("conflicting-path");
    const conflictingResult: BlastRadiusResult = {
      ...conflicting,
      findings: [...conflicting.findings, duplicate],
      totalFindings: 2,
      totalPaths: 2,
    };
    expect(compareImmutableBlastRadius(complete, conflictingResult)).toMatchObject({
      status: "INCONCLUSIVE",
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: "EVIDENCE_CHANGED_DURING_COMPARISON" }),
      ]),
    });
  });
});

function result(snapshot: string, paths: EvidencePath[]): BlastRadiusResult {
  const snapshotId = id(`snapshot:${snapshot}`);
  const finding: BlastRadiusFinding = {
    findingId: id(`finding:${snapshot}`),
    serviceId: "service",
    deploymentId: id(`deployment:${snapshot}`),
    repositoryId: "fixture/repository",
    commitSha: snapshot.padEnd(40, "0").slice(0, 40),
    lockfileSourceRef: "package-lock.json",
    lockfileSha256: snapshot.padEnd(64, "0").slice(0, 64),
    environment: "production",
    criticality: "production",
    snapshotId,
    affectedPackageVersionId: id("affected-package-version"),
    affectedPackageName: "affected-package",
    affectedVersion: "1.0.0",
    incidentSource: "manual",
    windowSource: "manual",
    firstExposedAt: 1,
    lastExposedAt: null,
    direct: paths.some(({ direct }) => direct),
    developmentOnly: false,
    pathCount: paths.length,
    pathCountTruncated: false,
    displayedPaths: paths.map((value) => ({ ...value, snapshotId })),
    pathsTruncated: false,
    reachability: ReachabilityLevel.StaticReachable,
    reachabilityEvidence: [{
      id: id(`reachability:${snapshot}`),
      snapshotId,
      packageName: "affected-package",
      version: "1.0.0",
      level: ReachabilityLevel.StaticReachable,
      source: "static",
      observedAt: 1,
      evidenceRefs: ["E-STATIC-import"],
      details: {},
    }],
    evidenceRefs: ["E-STATIC-import"],
    confidence: 1,
    unknowns: [],
    risk: highRisk(),
  };
  return {
    incidentId: id("incident"),
    generatedAt: 1,
    query: {
      environments: [],
      includeDevelopment: false,
      pathOffset: 0,
      pathDisplayLimit: 100,
      pathCountLimit: 100,
      maxDepth: 16,
    },
    totalFindings: 1,
    totalAffectedServices: 1,
    totalAffectedDeployments: 1,
    totalPaths: paths.length,
    pathsTruncated: false,
    offset: 0,
    limit: 100,
    findings: [finding],
  };
}

function path(snapshot: string, dependencyNames: string[], rootVersion: string): EvidencePath {
  const snapshotId = id(`snapshot:${snapshot}`);
  const names = ["application", ...dependencyNames];
  const nodes = names.map((packageName, index) => ({
    resolutionId: id(`resolution:${snapshot}:${index}`),
    packageVersionId: id(`package-version:${packageName}:${index === 0 ? rootVersion : "1.0.0"}`),
    packageName,
    version: index === 0 ? rootVersion : "1.0.0",
    sourceKey: index === 0 ? "" : `node_modules/${packageName}`,
    root: index === 0,
    direct: index === 1,
    dev: false,
    optional: false,
    peer: false,
  }));
  return {
    pathId: id(`path:${snapshot}:${dependencyNames.join(":")}`),
    snapshotId,
    resolutionIds: nodes.map(({ resolutionId }) => resolutionId),
    relationshipIds: nodes.slice(1).map((_, index) => id(`edge:${snapshot}:${index}`)),
    dependencyKinds: nodes.slice(1).map(() => "production"),
    nodes,
    direct: nodes.length === 2,
    developmentOnly: false,
    evidenceRefs: ["E-PATH-complete"],
  };
}

function id(value: string): StableId {
  return stableIdFromCanonicalKey(value);
}

function highRisk(): BlastRadiusFinding["risk"] {
  return {
    score: 80.5,
    label: "High",
    components: [
      { name: "severity", raw: 1, weight: 0.25, contribution: 25 },
      { name: "environment", raw: 1, weight: 0.2, contribution: 20 },
      { name: "reachability", raw: 0.7, weight: 0.25, contribution: 17.5 },
      { name: "exposureBreadth", raw: 0.2, weight: 0.15, contribution: 3 },
      { name: "incidentTiming", raw: 1, weight: 0.1, contribution: 10 },
      { name: "trustContext", raw: 1, weight: 0.05, contribution: 5 },
    ],
  };
}

function lowRisk(): BlastRadiusFinding["risk"] {
  return {
    score: 10,
    label: "Low",
    components: [
      { name: "severity", raw: 0.4, weight: 0.25, contribution: 10 },
      { name: "environment", raw: 0, weight: 0.2, contribution: 0 },
      { name: "reachability", raw: 0, weight: 0.25, contribution: 0 },
      { name: "exposureBreadth", raw: 0, weight: 0.15, contribution: 0 },
      { name: "incidentTiming", raw: 0, weight: 0.1, contribution: 0 },
      { name: "trustContext", raw: 0, weight: 0.05, contribution: 0 },
    ],
  };
}
