import {
  canonicalKeys,
  stableIdFromCanonicalKey,
  type StableId,
} from "./ids.js";
import type {
  FactProvenance,
  LockfileParserOptions,
  LockfileType,
} from "./models.js";

export function createLockfileProvenance(input: {
  lockfileType: LockfileType;
  sourceSha256: string;
  snapshotId: StableId;
  options: LockfileParserOptions;
}): FactProvenance {
  const parserVersion = input.options.parserVersion ?? "0.1.0";
  const importRunId =
    input.options.importRunId ??
    stableIdFromCanonicalKey(canonicalKeys.importRun(input.snapshotId, parserVersion));

  return {
    sourceType: input.lockfileType,
    sourceRef: input.options.sourceRef,
    sourceSha256: input.sourceSha256,
    repositoryId: input.options.repositoryId,
    commitSha: input.options.commitSha,
    importRunId,
    observedAt: input.options.observedAt,
    parserVersion,
    confidence: 1,
  };
}
