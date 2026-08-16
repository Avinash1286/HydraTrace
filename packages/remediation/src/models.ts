import type { StableId } from "@hydratrace/domain";

export type SemverImpact = "patch" | "minor" | "major" | "unknown";
export type CandidateVerification = "PROPOSED" | "LOCKFILE_VERIFIED" | "BUILD_VERIFIED" | "TEST_VERIFIED";

export interface RemediationCandidate {
  candidateId: StableId;
  dependencyName: string;
  fromVersion: string;
  toVersion: string;
  semverImpact: SemverImpact;
  eliminatedPathIds: readonly StableId[];
  affectedServices: readonly string[];
  lockfileChurn: number;
  deprecated: boolean;
  knownVulnerable: boolean;
  verification: CandidateVerification;
  evidenceRefs: readonly string[];
}

export interface CandidateCost {
  total: number;
  semverPenalty: number;
  changedDirectDependencies: number;
  lockfileChurnPenalty: number;
  affectedServiceCount: number;
  verificationFailurePenalty: number;
}

export interface RemediationSolution {
  candidates: readonly { candidate: RemediationCandidate; cost: CandidateCost }[];
  coveredPathIds: readonly StableId[];
  uncoveredPathIds: readonly StableId[];
  exact: boolean;
  totalCost: number;
}

export interface LockfileSimulationInput {
  packageJson: string;
  packageLock: string;
  dependencyName: string;
  toVersion: string;
  affectedPackageName: string;
  affectedVersions: readonly string[];
  repositoryId: string;
  commitSha: string;
  timeoutMs?: number;
}

export interface LockfileSimulationResult {
  command: readonly string[];
  exitCode: number;
  affectedPathCount: number;
  lockfileChurn: number;
  verification: "LOCKFILE_VERIFIED" | "FAILED";
  stdout: string;
  stderr: string;
  resultingPackageLock: string;
}
