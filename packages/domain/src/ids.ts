import { createHash } from "node:crypto";

declare const stableIdBrand: unique symbol;

/** Decimal representation of a deterministic nonnegative signed 63-bit integer. */
export type StableId = string & { readonly [stableIdBrand]: "StableId" };

const MAX_SIGNED_63_BIT = (1n << 63n) - 1n;

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableIdFromCanonicalKey(canonicalKey: string): StableId {
  if (canonicalKey.length === 0) {
    throw new Error("A canonical key must not be empty");
  }

  const digest = createHash("sha256").update(canonicalKey, "utf8").digest();
  const unsignedPrefix = digest.readBigUInt64BE(0);
  return (unsignedPrefix & MAX_SIGNED_63_BIT).toString(10) as StableId;
}

export function normalizeNpmPackageName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("An npm package name must not be empty");
  }
  return normalized;
}

export const canonicalKeys = {
  organization(organizationId: string): string {
    return `organization:${organizationId.trim().toLowerCase()}`;
  },

  repository(repositoryId: string): string {
    return `repository:${repositoryId.trim().toLowerCase()}`;
  },

  service(repositoryId: string, serviceId: string): string {
    return `service:${repositoryId.trim().toLowerCase()}:${serviceId.trim().toLowerCase()}`;
  },

  commit(repositoryId: string, commitSha: string): string {
    return `commit:${repositoryId.trim().toLowerCase()}:${commitSha.trim().toLowerCase()}`;
  },

  environment(organizationId: string, environment: string): string {
    return `environment:${organizationId.trim().toLowerCase()}:${environment.trim().toLowerCase()}`;
  },

  package(ecosystem: "npm", name: string): string {
    return `${ecosystem}:package:${normalizeNpmPackageName(name)}`;
  },

  packageVersion(ecosystem: "npm", name: string, version: string): string {
    return `${ecosystem}:version:${normalizeNpmPackageName(name)}:${version.trim()}`;
  },

  snapshot(repositoryId: string, commitSha: string, lockfileSha256: string): string {
    return `snapshot:${repositoryId.trim()}:${commitSha.trim()}:${lockfileSha256.toLowerCase()}`;
  },

  resolution(snapshotId: StableId | string, sourceKey: string): string {
    return `resolution:${snapshotId}:${sourceKey.replaceAll("\\", "/")}`;
  },

  resolutionEdge(
    snapshotId: StableId | string,
    fromResolutionId: StableId | string,
    toResolutionId: StableId | string,
    dependencyName: string,
  ): string {
    return `resolution-edge:${snapshotId}:${fromResolutionId}:${toResolutionId}:${normalizeNpmPackageName(dependencyName)}`;
  },

  deployment(
    serviceId: string,
    environment: string,
    commitSha: string,
    startedAt: number,
  ): string {
    return `deployment:${serviceId.trim()}:${environment.trim().toLowerCase()}:${commitSha.trim()}:${startedAt}`;
  },

  evidence(sourceSha256: string, factKey: string): string {
    return `evidence:${sourceSha256.toLowerCase()}:${factKey}`;
  },

  importRun(snapshotId: StableId | string, parserVersion: string): string {
    return `import:${snapshotId}:${parserVersion}`;
  },
} as const;
