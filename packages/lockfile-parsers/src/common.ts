import {
  canonicalKeys,
  createLockfileProvenance,
  lockfileParserOptionsSchema,
  normalizeNpmPackageName,
  sha256Hex,
  stableIdFromCanonicalKey,
  type FactProvenance,
  type LockfileParserOptions,
  type LockfileType,
  type NormalizedPackageVersion,
  type NormalizedResolution,
  type StableId,
} from "@hydratrace/domain";

export interface ParserContext {
  contentHash: string;
  snapshotId: StableId;
  provenance: FactProvenance;
  options: LockfileParserOptions;
  lockfileType: LockfileType;
}

export function createParserContext(
  rawContent: string,
  lockfileType: LockfileType,
  uncheckedOptions: LockfileParserOptions,
): ParserContext {
  const parsedOptions = lockfileParserOptionsSchema.parse(uncheckedOptions);
  const options: LockfileParserOptions = {
    repositoryId: parsedOptions.repositoryId,
    commitSha: parsedOptions.commitSha,
    sourceRef: parsedOptions.sourceRef,
    observedAt: parsedOptions.observedAt,
    ...(parsedOptions.parserVersion === undefined
      ? {}
      : { parserVersion: parsedOptions.parserVersion }),
    ...(uncheckedOptions.importRunId === undefined
      ? {}
      : { importRunId: uncheckedOptions.importRunId }),
    ...(parsedOptions.rootPackage === undefined
      ? {}
      : { rootPackage: parsedOptions.rootPackage }),
  };
  const contentHash = sha256Hex(rawContent);
  const snapshotId = stableIdFromCanonicalKey(
    canonicalKeys.snapshot(options.repositoryId, options.commitSha, contentHash),
  );
  const provenance = createLockfileProvenance({
    lockfileType,
    sourceSha256: contentHash,
    snapshotId,
    options,
  });

  return { contentHash, snapshotId, provenance, options, lockfileType };
}

export function createPackageVersion(input: {
  name: string;
  version: string;
  provenance: FactProvenance;
  integrity?: string;
  resolved?: string;
}): NormalizedPackageVersion {
  const normalizedName = normalizeNpmPackageName(input.name);
  const packageId = stableIdFromCanonicalKey(canonicalKeys.package("npm", normalizedName));
  const id = stableIdFromCanonicalKey(
    canonicalKeys.packageVersion("npm", normalizedName, input.version),
  );

  return {
    id,
    packageId,
    name: input.name,
    normalizedName,
    ecosystem: "npm",
    version: input.version,
    ...(input.integrity === undefined ? {} : { integrity: input.integrity }),
    ...(input.resolved === undefined ? {} : { resolved: input.resolved }),
    provenance: input.provenance,
  };
}

export function createResolution(input: {
  snapshotId: StableId;
  packageVersionId: StableId;
  packageName: string;
  version: string;
  sourceKey: string;
  installPath: string;
  root?: boolean;
  direct: boolean;
  dev: boolean;
  optional: boolean;
  peer: boolean;
  provenance: FactProvenance;
  integrity?: string;
  resolved?: string;
}): NormalizedResolution {
  return {
    id: stableIdFromCanonicalKey(
      canonicalKeys.resolution(input.snapshotId, input.sourceKey),
    ),
    snapshotId: input.snapshotId,
    packageVersionId: input.packageVersionId,
    packageName: input.packageName,
    version: input.version,
    sourceKey: input.sourceKey,
    installPath: input.installPath,
    root: input.root ?? false,
    direct: input.direct,
    dev: input.dev,
    optional: input.optional,
    peer: input.peer,
    ...(input.integrity === undefined ? {} : { integrity: input.integrity }),
    ...(input.resolved === undefined ? {} : { resolved: input.resolved }),
    provenance: input.provenance,
  };
}

export function sortByStableId<T extends { id: StableId }>(values: T[]): T[] {
  return values.sort((left, right) => {
    const leftId = BigInt(left.id);
    const rightId = BigInt(right.id);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function booleanValue(value: unknown): boolean {
  return value === true;
}
