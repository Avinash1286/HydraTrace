import {
  stableIdFromCanonicalKey,
  type FactProvenance,
  type NormalizedSnapshot,
} from "@hydratrace/domain";
import { describe, expect, it } from "vitest";
import { normalizedSnapshotToGraphRecords } from "./normalized-snapshot.js";

const id = (value: string) => stableIdFromCanonicalKey(value);

function fixture(): NormalizedSnapshot {
  const snapshotId = id("snapshot:test");
  const packageId = id("package:helper");
  const versionId = id("version:helper:1.4.2");
  const rootPackageId = id("package:root");
  const rootVersionId = id("version:root:1.0.0");
  const rootId = id("resolution:root");
  const helperId = id("resolution:helper");
  const provenance: FactProvenance = {
    sourceType: "package-lock",
    sourceRef: "package-lock.json",
    sourceSha256: "a".repeat(64),
    repositoryId: "repo:test",
    commitSha: "abc123",
    importRunId: id("import:test"),
    observedAt: 1_786_703_000_000,
    parserVersion: "0.1.0",
    confidence: 1,
  };

  return {
    snapshot: {
      id: snapshotId,
      ecosystem: "npm",
      lockfileType: "package-lock",
      contentHash: "a".repeat(64),
      repositoryId: "repo:test",
      commitSha: "abc123",
      sourceRef: "package-lock.json",
      parserVersion: "0.1.0",
      createdAt: 1_786_703_000_000,
    },
    packages: [
      {
        id: rootVersionId,
        packageId: rootPackageId,
        name: "root",
        normalizedName: "root",
        ecosystem: "npm",
        version: "1.0.0",
        provenance,
      },
      {
        id: versionId,
        packageId,
        name: "compromised-helper",
        normalizedName: "compromised-helper",
        ecosystem: "npm",
        version: "1.4.2",
        provenance,
      },
    ],
    resolutions: [
      {
        id: rootId,
        snapshotId,
        packageVersionId: rootVersionId,
        packageName: "root",
        version: "1.0.0",
        sourceKey: "",
        installPath: "",
        root: true,
        direct: true,
        dev: false,
        optional: false,
        peer: false,
        provenance,
      },
      {
        id: helperId,
        snapshotId,
        packageVersionId: versionId,
        packageName: "compromised-helper",
        version: "1.4.2",
        sourceKey: "node_modules/compromised-helper",
        installPath: "node_modules/compromised-helper",
        root: false,
        direct: false,
        dev: false,
        optional: false,
        peer: false,
        provenance,
      },
    ],
    edges: [
      {
        id: id("edge:root:helper"),
        snapshotId,
        fromResolutionId: rootId,
        toResolutionId: helperId,
        dependencyName: "compromised-helper",
        kind: "production",
        provenance,
      },
    ],
    warnings: [],
  };
}

describe("normalizedSnapshotToGraphRecords", () => {
  it("creates the exact immutable dependency spine with deterministic IDs", () => {
    const first = normalizedSnapshotToGraphRecords(fixture());
    const second = normalizedSnapshotToGraphRecords(fixture());

    expect(first).toEqual(second);
    expect(first.nodes).toHaveLength(7);
    expect(first.relationships).toHaveLength(7);
    expect(first.nodes.map((node) => node.label)).toEqual([
      "LockfileSnapshot",
      "Package",
      "Package",
      "PackageVersion",
      "PackageVersion",
      "Resolution",
      "Resolution",
    ]);
    expect(
      first.relationships.filter(({ type }) => type === "DEPENDS_ON_INSTANCE"),
    ).toHaveLength(1);
  });

  it("flattens provenance onto imported facts", () => {
    const graph = normalizedSnapshotToGraphRecords(fixture());
    const dependency = graph.relationships.find(
      ({ type }) => type === "DEPENDS_ON_INSTANCE",
    );

    expect(dependency?.properties).toMatchObject({
      sourceType: "package-lock",
      sourceRef: "package-lock.json",
      confidence: 1,
    });
  });

  it("rejects dangling normalized references before writing", () => {
    const normalized = fixture();
    const missingVersionId = id("missing-version");
    const firstResolution = normalized.resolutions[0];
    if (firstResolution === undefined) throw new Error("invalid fixture");
    normalized.resolutions[0] = {
      ...firstResolution,
      packageVersionId: missingVersionId,
    };

    expect(() => normalizedSnapshotToGraphRecords(normalized)).toThrow(
      /references missing package version/,
    );
  });
});
