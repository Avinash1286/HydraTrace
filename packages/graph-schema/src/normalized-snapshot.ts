import {
  stableIdFromCanonicalKey,
  type FactProvenance,
  type NormalizedPackageVersion,
  type NormalizedSnapshot,
  type StableId,
} from "@hydratrace/domain";
import type { GraphNodeRecord, GraphRecords, GraphRelationshipRecord } from "./records.js";
import type { ProvenanceProperties, RelationshipType } from "./schema.js";

export function provenanceProperties(
  provenance: FactProvenance,
): ProvenanceProperties {
  return {
    sourceType: provenance.sourceType,
    sourceRef: provenance.sourceRef,
    sourceSha256: provenance.sourceSha256,
    repositoryId: provenance.repositoryId,
    commitSha: provenance.commitSha,
    importRunId: provenance.importRunId,
    observedAt: provenance.observedAt,
    parserVersion: provenance.parserVersion,
    confidence: provenance.confidence,
  };
}

export function graphRelationshipId(input: {
  type: RelationshipType;
  from: StableId;
  to: StableId;
  discriminator?: string;
}): StableId {
  const discriminator = input.discriminator === undefined ? "" : `:${input.discriminator}`;
  return stableIdFromCanonicalKey(
    `graph-relationship:${input.type}:${input.from}:${input.to}${discriminator}`,
  );
}

function packageNode(version: NormalizedPackageVersion): GraphNodeRecord<"Package"> {
  return {
    id: version.packageId,
    label: "Package",
    properties: {
      ecosystem: version.ecosystem,
      name: version.name,
      normalizedName: version.normalizedName,
    },
  };
}

function packageVersionNode(
  version: NormalizedPackageVersion,
): GraphNodeRecord<"PackageVersion"> {
  return {
    id: version.id,
    label: "PackageVersion",
    properties: {
      packageId: version.packageId,
      ecosystem: version.ecosystem,
      name: version.name,
      normalizedName: version.normalizedName,
      version: version.version,
      ...(version.deprecated === undefined ? {} : { deprecated: version.deprecated }),
    },
  };
}

/**
 * Converts parser output into immutable, database-neutral graph records.
 * Global package nodes are deduplicated by canonical ID; every relationship ID
 * is deterministic so a repeated import is a no-op in an idempotent store.
 */
export function normalizedSnapshotToGraphRecords(
  normalized: NormalizedSnapshot,
): GraphRecords {
  assertNormalizedSnapshotReferences(normalized);
  const nodes: GraphNodeRecord[] = [
    {
      id: normalized.snapshot.id,
      label: "LockfileSnapshot",
      properties: {
        ecosystem: normalized.snapshot.ecosystem,
        lockfileType: normalized.snapshot.lockfileType,
        contentHash: normalized.snapshot.contentHash,
        sha256: normalized.snapshot.contentHash,
        repositoryId: normalized.snapshot.repositoryId,
        commitSha: normalized.snapshot.commitSha,
        sourceRef: normalized.snapshot.sourceRef,
        parserVersion: normalized.snapshot.parserVersion,
        createdAt: normalized.snapshot.createdAt,
      },
    },
  ];

  const packagesById = new Map<StableId, GraphNodeRecord<"Package">>();
  for (const version of normalized.packages) {
    const candidate = packageNode(version);
    const existing = packagesById.get(candidate.id);
    if (
      existing !== undefined &&
      (existing.properties.ecosystem !== candidate.properties.ecosystem ||
        existing.properties.normalizedName !== candidate.properties.normalizedName)
    ) {
      throw new Error(`Conflicting package records for canonical ID ${candidate.id}`);
    }
    packagesById.set(candidate.id, candidate);
  }

  nodes.push(...packagesById.values());
  nodes.push(...normalized.packages.map(packageVersionNode));
  nodes.push(
    ...normalized.resolutions.map(
      (resolution): GraphNodeRecord<"Resolution"> => ({
        id: resolution.id,
        label: "Resolution",
        properties: {
          snapshotId: resolution.snapshotId,
          packageVersionId: resolution.packageVersionId,
          packageName: resolution.packageName,
          version: resolution.version,
          sourceKey: resolution.sourceKey,
          installPath: resolution.installPath,
          root: resolution.root,
          direct: resolution.direct,
          dev: resolution.dev,
          optional: resolution.optional,
          peer: resolution.peer,
          ...provenanceProperties(resolution.provenance),
          ...(resolution.integrity === undefined
            ? {}
            : { integrity: resolution.integrity }),
          ...(resolution.resolved === undefined
            ? {}
            : { resolved: resolution.resolved }),
        },
      }),
    ),
  );

  const relationships: GraphRelationshipRecord[] = [];
  for (const version of normalized.packages) {
    relationships.push({
      id: graphRelationshipId({
        type: "VERSION_OF",
        from: version.id,
        to: version.packageId,
      }),
      type: "VERSION_OF",
      from: { id: version.id, label: "PackageVersion" },
      to: { id: version.packageId, label: "Package" },
      properties: provenanceProperties(version.provenance),
    });
  }

  for (const resolution of normalized.resolutions) {
    const provenance = provenanceProperties(resolution.provenance);
    relationships.push(
      {
        id: graphRelationshipId({
          type: "CONTAINS",
          from: normalized.snapshot.id,
          to: resolution.id,
        }),
        type: "CONTAINS",
        from: { id: normalized.snapshot.id, label: "LockfileSnapshot" },
        to: { id: resolution.id, label: "Resolution" },
        properties: provenance,
      },
      {
        id: graphRelationshipId({
          type: "INSTANCE_OF",
          from: resolution.id,
          to: resolution.packageVersionId,
        }),
        type: "INSTANCE_OF",
        from: { id: resolution.id, label: "Resolution" },
        to: { id: resolution.packageVersionId, label: "PackageVersion" },
        properties: provenance,
      },
    );
  }

  relationships.push(
    ...normalized.edges.map(
      (edge): GraphRelationshipRecord<"DEPENDS_ON_INSTANCE"> => ({
        id: edge.id,
        type: "DEPENDS_ON_INSTANCE",
        from: { id: edge.fromResolutionId, label: "Resolution" },
        to: { id: edge.toResolutionId, label: "Resolution" },
        properties: {
          dependencyName: edge.dependencyName,
          kind: edge.kind,
          ...provenanceProperties(edge.provenance),
          ...(edge.specifier === undefined ? {} : { specifier: edge.specifier }),
        },
      }),
    ),
  );

  return { nodes, relationships };
}

function assertNormalizedSnapshotReferences(normalized: NormalizedSnapshot): void {
  const packageVersionsById = new Map(
    normalized.packages.map((version) => [version.id, version]),
  );
  const resolutionIds = new Set(normalized.resolutions.map(({ id }) => id));
  for (const resolution of normalized.resolutions) {
    if (resolution.snapshotId !== normalized.snapshot.id) {
      throw new Error(
        `Resolution ${resolution.id} belongs to a different lockfile snapshot`,
      );
    }
    const packageVersion = packageVersionsById.get(resolution.packageVersionId);
    if (packageVersion === undefined) {
      throw new Error(
        `Resolution ${resolution.id} references missing package version ${resolution.packageVersionId}`,
      );
    }
    if (
      resolution.packageName !== packageVersion.name ||
      resolution.version !== packageVersion.version
    ) {
      throw new Error(
        `Resolution ${resolution.id} identity does not match package version ${packageVersion.id}`,
      );
    }
  }
  for (const edge of normalized.edges) {
    if (edge.snapshotId !== normalized.snapshot.id) {
      throw new Error(`Dependency edge ${edge.id} belongs to a different snapshot`);
    }
    if (!resolutionIds.has(edge.fromResolutionId)) {
      throw new Error(
        `Dependency edge ${edge.id} references missing source resolution ${edge.fromResolutionId}`,
      );
    }
    if (!resolutionIds.has(edge.toResolutionId)) {
      throw new Error(
        `Dependency edge ${edge.id} references missing target resolution ${edge.toResolutionId}`,
      );
    }
  }
}
