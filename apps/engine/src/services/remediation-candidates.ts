import {
  normalizeNpmPackageName,
  sha256Hex,
  stableIdFromCanonicalKey,
  type StableId,
} from "@hydratrace/domain";
import type {
  NpmAvailableVersion,
  NpmRegistryClient,
  OsvClient,
  OsvExactQueryResult,
} from "@hydratrace/ecosystem-enrichment";
import type {
  BlastRadiusResult,
  IncidentRecord,
} from "@hydratrace/incident-analysis";
import { parsePackageLock } from "@hydratrace/lockfile-parsers";
import {
  remediationCandidate,
  type LockfileSimulationResult,
  type RemediationCandidate,
  type SemverImpact,
  type simulateNpmLockfile,
} from "@hydratrace/remediation";
import {
  builtInDemoRemediationArtifacts,
  DEMO_INCIDENT_END,
  DEMO_INCIDENT_START,
} from "../demo-data.js";

export interface RemediationSourceArtifact {
  snapshotId: StableId;
  packageJson: string;
  packageLock: string;
  repositoryId: string;
  commitSha: string;
}

export interface RemediationCandidateDiscoveryDependencies {
  npmRegistryClient: Pick<NpmRegistryClient, "listVersions">;
  osvClient: Pick<OsvClient, "queryExactPackages">;
  simulateLockfile: typeof simulateNpmLockfile;
  allowRootSimulation?: boolean;
}

export type CandidateRejectionReason =
  | "NO_DIRECT_DEPENDENCY"
  | "SOURCE_ARTIFACT_UNAVAILABLE"
  | "SOURCE_ARTIFACT_MISMATCH"
  | "UNSUPPORTED_LOCKFILE"
  | "UNSUPPORTED_VERSION"
  | "NONEXISTENT_VERSION"
  | "DEPRECATED_VERSION"
  | "KNOWN_VULNERABLE_VERSION"
  | "SIMULATION_LIMIT_REACHED"
  | "SIMULATION_FAILED"
  | "AFFECTED_PATHS_REMAIN";

export interface CandidateRejection {
  dependencyName?: string;
  fromVersion?: string;
  toVersion?: string;
  snapshotId?: StableId;
  reason: CandidateRejectionReason;
  message: string;
}

export interface CandidateProviderError {
  provider: "npm-registry" | "osv" | "lockfile-simulation";
  dependencyName?: string;
  snapshotId?: StableId;
  message: string;
}

export interface RemediationCandidateEvidence {
  candidateId: StableId;
  registry: {
    packageUrl: string;
    exactVersion: string;
    deprecated: false;
  };
  osv: {
    queryUrl: string;
    exactVersion: string;
    advisoryIds: readonly [];
  };
  simulation: {
    snapshotId: StableId;
    command: readonly string[];
    exitCode: number;
    timedOut: boolean;
    affectedPathCount: 0;
    resolvedDependencyVersions: readonly string[];
    lockfileChurn: number;
    cached?: boolean;
  };
  fictionalFixture?: {
    provider: "built-in-fictional-fixture";
    sourceArtifactSha256: string;
    resultingArtifactSha256: string;
  };
}

/**
 * The public demo uses intentionally nonexistent package names. This strict,
 * hash-pinned cache proves only those fictional fixtures and is never consulted
 * for an arbitrary repository or incident.
 */
export function discoverBuiltInDemoRemediationCandidates(
  blast: BlastRadiusResult,
  incident: IncidentRecord,
): RemediationCandidateDiscoveryResult | undefined {
  if (
    incident.normalizedPackageName !== "compromised-helper" ||
    incident.affectedVersions.length !== 1 ||
    incident.affectedVersions[0] !== "1.4.2" ||
    incident.startsAt !== DEMO_INCIDENT_START ||
    incident.endsAt !== DEMO_INCIDENT_END
  ) return undefined;
  const artifacts = builtInDemoRemediationArtifacts();
  if (artifacts.some((artifact) =>
    sha256Hex(artifact.affectedPackageLock) !== artifact.expectedAffectedSha256 ||
    sha256Hex(artifact.fixedPackageLock) !== artifact.expectedFixedSha256)) {
    return undefined;
  }
  const artifactByAffectedIdentity = new Map(artifacts.map((artifact) => [
    `${artifact.repositoryId}\0${artifact.affectedCommitSha}\0${sha256Hex(artifact.affectedPackageLock)}`,
    artifact,
  ]));
  const groups = new Map<string, {
    artifact: (typeof artifacts)[number];
    dependencyName: string;
    fromVersion: string;
    toVersion: string;
    pathIds: Set<StableId>;
    services: Set<string>;
    evidenceRefs: Set<string>;
  }>();
  let totalPaths = 0;
  for (const finding of blast.findings) {
    const artifact = artifactByAffectedIdentity.get(
      `${finding.repositoryId}\0${finding.commitSha}\0${finding.lockfileSha256}`,
    );
    if (artifact === undefined) return undefined;
    for (const path of finding.displayedPaths) {
      totalPaths += 1;
      const direct = path.nodes.find((node, index) => index > 0 && node.direct);
      if (direct === undefined) return undefined;
      const change = artifact.changes.find((candidate) =>
        normalizeNpmPackageName(candidate.dependencyName) === normalizeNpmPackageName(direct.packageName) &&
        candidate.fromVersion === direct.version);
      if (change === undefined) return undefined;
      const key = `${finding.snapshotId}\0${change.dependencyName}\0${change.fromVersion}\0${change.toVersion}`;
      const group = groups.get(key) ?? {
        artifact,
        dependencyName: normalizeNpmPackageName(change.dependencyName),
        fromVersion: change.fromVersion,
        toVersion: change.toVersion,
        pathIds: new Set<StableId>(),
        services: new Set<string>(),
        evidenceRefs: new Set<string>(),
      };
      group.pathIds.add(path.pathId);
      group.services.add(finding.serviceId);
      for (const reference of path.evidenceRefs) group.evidenceRefs.add(reference);
      groups.set(key, group);
    }
  }
  if (totalPaths === 0 || blast.pathsTruncated) return undefined;

  const candidates: RemediationCandidate[] = [];
  const evidence: RemediationCandidateEvidence[] = [];
  for (const group of groups.values()) {
    const normalized = parsePackageLock(group.artifact.fixedPackageLock, {
      repositoryId: group.artifact.repositoryId,
      commitSha: group.artifact.fixedCommitSha,
      sourceRef: "package-lock.json",
      observedAt: DEMO_INCIDENT_END,
    });
    const affectedRemains = normalized.resolutions.some(({ packageName, version }) =>
      normalizeNpmPackageName(packageName) === incident.normalizedPackageName &&
      incident.affectedVersions.includes(version));
    const directUpgradeExists = normalized.resolutions.some(({ packageName, version, direct }) =>
      direct &&
      normalizeNpmPackageName(packageName) === group.dependencyName &&
      version === group.toVersion);
    if (affectedRemains || !directUpgradeExists) return undefined;
    const sourceHash = group.artifact.expectedAffectedSha256;
    const resultHash = group.artifact.expectedFixedSha256;
    const candidate = remediationCandidate({
      dependencyName: group.dependencyName,
      fromVersion: group.fromVersion,
      toVersion: group.toVersion,
      semverImpact: "patch",
      eliminatedPathIds: [...group.pathIds].sort(),
      affectedServices: [...group.services].sort(),
      lockfileChurn: lockfileChurn(group.artifact.affectedPackageLock, group.artifact.fixedPackageLock),
      deprecated: false,
      knownVulnerable: false,
      verification: "LOCKFILE_VERIFIED",
      evidenceRefs: [
        ...group.evidenceRefs,
        evidenceId("fictional-fixture-source", sourceHash),
        evidenceId("fictional-fixture-result", resultHash),
      ].sort(),
    });
    candidates.push(candidate);
    evidence.push({
      candidateId: candidate.candidateId,
      registry: {
        packageUrl: `fixture://hydratrace/${group.dependencyName}`,
        exactVersion: group.toVersion,
        deprecated: false,
      },
      osv: {
        queryUrl: "fixture://hydratrace/no-known-advisory",
        exactVersion: group.toVersion,
        advisoryIds: [],
      },
      simulation: {
        snapshotId: [...blast.findings
          .filter(({ repositoryId }) => repositoryId === group.artifact.repositoryId)
          .map(({ snapshotId }) => snapshotId)][0]!,
        command: ["npm", "install", "--package-lock-only", "--ignore-scripts", "--audit=false", "--fund=false", "--no-update-notifier"],
        exitCode: 0,
        timedOut: false,
        affectedPathCount: 0,
        resolvedDependencyVersions: [group.toVersion],
        lockfileChurn: candidate.lockfileChurn,
        cached: true,
      },
      fictionalFixture: {
        provider: "built-in-fictional-fixture",
        sourceArtifactSha256: sourceHash,
        resultingArtifactSha256: resultHash,
      },
    });
  }
  const covered = new Set(candidates.flatMap(({ eliminatedPathIds }) => eliminatedPathIds));
  if (covered.size !== totalPaths) return undefined;
  return {
    state: "READY",
    candidates: candidates.sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
    evidence: evidence.sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
    rejections: [],
    providerErrors: [],
    simulationsAttempted: 0,
    complete: true,
  };
}

export interface RemediationCandidateDiscoveryResult {
  state: "READY" | "NO_SAFE_CANDIDATE" | "INCONCLUSIVE";
  candidates: readonly RemediationCandidate[];
  evidence: readonly RemediationCandidateEvidence[];
  rejections: readonly CandidateRejection[];
  providerErrors: readonly CandidateProviderError[];
  simulationsAttempted: number;
  complete: boolean;
}

export interface RemediationCandidateDiscoveryOptions {
  requestedVersions?: Readonly<Record<string, readonly string[]>>;
  maxVersionsPerDependency?: number;
  maxSimulations?: number;
  simulationTimeoutMs?: number;
}

interface CandidateGroup {
  dependencyName: string;
  fromVersion: string;
  snapshotId: StableId;
  repositoryId: string;
  commitSha: string;
  lockfileSha256: string;
  lockfileSourceRef: string;
  eliminatedPathIds: Set<StableId>;
  affectedServices: Set<string>;
  evidenceRefs: Set<string>;
}

interface ProposedCandidate {
  group: CandidateGroup;
  release: NpmAvailableVersion;
  semverImpact: SemverImpact;
}

const INCONCLUSIVE_REASONS = new Set<CandidateRejectionReason>([
  "SOURCE_ARTIFACT_UNAVAILABLE",
  "SOURCE_ARTIFACT_MISMATCH",
  "UNSUPPORTED_LOCKFILE",
  "UNSUPPORTED_VERSION",
  "SIMULATION_LIMIT_REACHED",
]);

/**
 * Discovers only mechanically supportable remediation candidates. A version is
 * solver-eligible only after registry existence/deprecation, exact OSV, and a
 * bounded lockfile-only simulation all succeed.
 */
export async function discoverRemediationCandidates(
  blast: BlastRadiusResult,
  incident: IncidentRecord,
  artifacts: readonly RemediationSourceArtifact[],
  dependencies: RemediationCandidateDiscoveryDependencies,
  options: RemediationCandidateDiscoveryOptions = {},
): Promise<RemediationCandidateDiscoveryResult> {
  const rejections: CandidateRejection[] = [];
  const providerErrors: CandidateProviderError[] = [];
  const groups = candidateGroups(blast, rejections);
  const artifactBySnapshot = new Map(artifacts.map((artifact) => [artifact.snapshotId, artifact]));
  const usableGroups = groups.filter((group) => {
    const artifact = artifactBySnapshot.get(group.snapshotId);
    if (artifact === undefined) {
      rejections.push(rejection(group, "SOURCE_ARTIFACT_UNAVAILABLE", "The exact package.json and package-lock.json for this snapshot are required."));
      return false;
    }
    if (!/(^|\/)package-lock\.json$/u.test(group.lockfileSourceRef.replaceAll("\\", "/"))) {
      rejections.push(rejection(group, "UNSUPPORTED_LOCKFILE", "Automatic lockfile simulation currently supports npm package-lock.json snapshots."));
      return false;
    }
    if (
      artifact.repositoryId !== group.repositoryId ||
      artifact.commitSha !== group.commitSha ||
      sha256Hex(artifact.packageLock) !== group.lockfileSha256 ||
      !manifestMatchesLockRoot(artifact.packageJson, artifact.packageLock)
    ) {
      rejections.push(rejection(group, "SOURCE_ARTIFACT_MISMATCH", "The supplied source artifact does not match the immutable incident snapshot."));
      return false;
    }
    return true;
  });

  const releasesByDependency = new Map<string, NpmAvailableVersion[]>();
  for (const dependencyName of [...new Set(usableGroups.map(({ dependencyName }) => dependencyName))].sort()) {
    try {
      releasesByDependency.set(
        dependencyName,
        await dependencies.npmRegistryClient.listVersions(dependencyName),
      );
    } catch (error) {
      providerErrors.push({
        provider: "npm-registry",
        dependencyName,
        message: errorMessage(error),
      });
    }
  }

  const proposed: ProposedCandidate[] = [];
  const maxVersionsPerDependency = clamp(options.maxVersionsPerDependency ?? 5, 1, 10);
  for (const group of usableGroups) {
    const releases = releasesByDependency.get(group.dependencyName);
    if (releases === undefined) continue;
    const current = parseStableSemver(group.fromVersion);
    if (current === undefined) {
      rejections.push(rejection(group, "UNSUPPORTED_VERSION", `Cannot safely order non-stable semver ${group.fromVersion}.`));
      continue;
    }
    const requested = requestedVersions(options.requestedVersions, group.dependencyName);
    const availableByVersion = new Map(releases.map((release) => [release.version, release]));
    if (requested !== undefined) {
      for (const version of requested) {
        if (!availableByVersion.has(version)) {
          rejections.push(rejection(group, "NONEXISTENT_VERSION", `${group.dependencyName}@${version} is not present in npm registry metadata.`, version));
        }
      }
    }
    const selected = (requested === undefined
      ? releases
      : requested.flatMap((version) => {
          const release = availableByVersion.get(version);
          return release === undefined ? [] : [release];
        }))
      .flatMap((release) => {
        const next = parseStableSemver(release.version);
        return next === undefined || compareSemver(next, current) <= 0
          ? []
          : [{ release, parsed: next, impact: semverImpact(current, next) }];
      })
      .sort((left, right) =>
        impactRank(left.impact) - impactRank(right.impact) || compareSemver(left.parsed, right.parsed))
      .slice(0, maxVersionsPerDependency);
    for (const selection of selected) {
      if (selection.release.deprecated !== undefined) {
        rejections.push(rejection(group, "DEPRECATED_VERSION", `${group.dependencyName}@${selection.release.version} is deprecated: ${selection.release.deprecated}`, selection.release.version));
        continue;
      }
      proposed.push({ group, release: selection.release, semverImpact: selection.impact });
    }
  }

  const uniqueQueries = [...new Map(proposed.map(({ group, release }) => {
    const query = { ecosystem: "npm" as const, name: group.dependencyName, version: release.version };
    return [`${normalizeNpmPackageName(query.name)}\0${query.version}`, query] as const;
  })).values()];
  let osvByPackageVersion = new Map<string, OsvExactQueryResult>();
  if (uniqueQueries.length > 0) {
    try {
      const results = await dependencies.osvClient.queryExactPackages(uniqueQueries);
      if (results.length !== uniqueQueries.length) {
        throw new Error("OSV result count did not match exact remediation queries");
      }
      osvByPackageVersion = new Map(results.map((result, index) => {
        const expected = uniqueQueries[index]!;
        if (
          normalizeNpmPackageName(result.query.name) !== normalizeNpmPackageName(expected.name) ||
          result.query.version !== expected.version
        ) {
          throw new Error("OSV result identity/order did not match exact remediation queries");
        }
        return [`${normalizeNpmPackageName(result.query.name)}\0${result.query.version}`, result];
      }));
    } catch (error) {
      providerErrors.push({ provider: "osv", message: errorMessage(error) });
    }
  }

  const candidates: RemediationCandidate[] = [];
  const evidence: RemediationCandidateEvidence[] = [];
  let simulationsAttempted = 0;
  const maxSimulations = clamp(options.maxSimulations ?? 25, 1, 25);
  const timeoutMs = clamp(options.simulationTimeoutMs ?? 30_000, 1_000, 60_000);
  if (providerErrors.every(({ provider }) => provider !== "osv")) {
    for (const proposal of proposed) {
      const { group, release } = proposal;
      const osv = osvByPackageVersion.get(`${normalizeNpmPackageName(group.dependencyName)}\0${release.version}`);
      if (osv === undefined) continue;
      if (osv.advisoryIds.length > 0) {
        rejections.push(rejection(group, "KNOWN_VULNERABLE_VERSION", `${group.dependencyName}@${release.version} has exact OSV matches: ${osv.advisoryIds.join(", ")}.`, release.version));
        continue;
      }
      if (simulationsAttempted >= maxSimulations) {
        rejections.push(rejection(group, "SIMULATION_LIMIT_REACHED", `The bounded ${maxSimulations}-simulation limit was reached.`, release.version));
        continue;
      }
      simulationsAttempted += 1;
      const artifact = artifactBySnapshot.get(group.snapshotId)!;
      let simulation: LockfileSimulationResult;
      try {
        simulation = await dependencies.simulateLockfile({
          packageJson: artifact.packageJson,
          packageLock: artifact.packageLock,
          dependencyName: group.dependencyName,
          toVersion: release.version,
          affectedPackageName: incident.normalizedPackageName,
          affectedVersions: incident.affectedVersions,
          repositoryId: artifact.repositoryId,
          commitSha: artifact.commitSha,
          timeoutMs,
        });
      } catch (error) {
        providerErrors.push({
          provider: "lockfile-simulation",
          dependencyName: group.dependencyName,
          snapshotId: group.snapshotId,
          message: errorMessage(error),
        });
        continue;
      }
      if (
        simulation.exitCode !== 0 ||
        simulation.timedOut ||
        !simulation.resolvedDependencyVersions.includes(release.version)
      ) {
        rejections.push(rejection(group, "SIMULATION_FAILED", `The bounded lockfile-only simulation did not resolve ${group.dependencyName}@${release.version} safely.`, release.version));
        continue;
      }
      if (simulation.affectedPathCount !== 0) {
        rejections.push(rejection(group, "AFFECTED_PATHS_REMAIN", `The regenerated lockfile still contains ${simulation.affectedPathCount} affected path(s).`, release.version));
        continue;
      }
      if (simulation.verification !== "LOCKFILE_VERIFIED") {
        rejections.push(rejection(group, "SIMULATION_FAILED", "The lockfile simulation did not meet the LOCKFILE_VERIFIED contract.", release.version));
        continue;
      }
      const candidate = remediationCandidate({
        dependencyName: group.dependencyName,
        fromVersion: group.fromVersion,
        toVersion: release.version,
        semverImpact: proposal.semverImpact,
        eliminatedPathIds: [...group.eliminatedPathIds].sort(),
        affectedServices: [...group.affectedServices].sort(),
        lockfileChurn: simulation.lockfileChurn,
        deprecated: false,
        knownVulnerable: false,
        verification: "LOCKFILE_VERIFIED",
        evidenceRefs: [
          ...group.evidenceRefs,
          evidenceId("npm-registry", `${release.provenance.packageUrl}:${release.version}`),
          evidenceId("osv", `${osv.provenance.queryUrl}:${release.version}`),
          evidenceId("lockfile-simulation", `${group.snapshotId}:${group.dependencyName}:${release.version}`),
        ].sort(),
      });
      candidates.push(candidate);
      evidence.push({
        candidateId: candidate.candidateId,
        registry: {
          packageUrl: release.provenance.packageUrl,
          exactVersion: release.version,
          deprecated: false,
        },
        osv: {
          queryUrl: osv.provenance.queryUrl,
          exactVersion: release.version,
          advisoryIds: [],
        },
        simulation: {
          snapshotId: group.snapshotId,
          command: simulation.command,
          exitCode: simulation.exitCode,
          timedOut: simulation.timedOut,
          affectedPathCount: 0,
          resolvedDependencyVersions: simulation.resolvedDependencyVersions,
          lockfileChurn: simulation.lockfileChurn,
        },
      });
    }
  }

  const complete = providerErrors.length === 0 &&
    !rejections.some(({ reason }) => INCONCLUSIVE_REASONS.has(reason));
  return {
    state: complete ? (candidates.length > 0 ? "READY" : "NO_SAFE_CANDIDATE") : "INCONCLUSIVE",
    candidates: candidates.sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
    evidence: evidence.sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
    rejections,
    providerErrors,
    simulationsAttempted,
    complete,
  };
}

function candidateGroups(
  blast: BlastRadiusResult,
  rejections: CandidateRejection[],
): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>();
  for (const finding of blast.findings) {
    for (const path of finding.displayedPaths) {
      const direct = path.nodes.find((node, index) => index > 0 && node.direct);
      if (direct === undefined) {
        rejections.push({
          snapshotId: finding.snapshotId,
          reason: "NO_DIRECT_DEPENDENCY",
          message: `Path ${path.pathId} has no application-controlled direct dependency.`,
        });
        continue;
      }
      const key = `${finding.snapshotId}\0${normalizeNpmPackageName(direct.packageName)}\0${direct.version}`;
      const group = groups.get(key) ?? {
        dependencyName: normalizeNpmPackageName(direct.packageName),
        fromVersion: direct.version,
        snapshotId: finding.snapshotId,
        repositoryId: finding.repositoryId,
        commitSha: finding.commitSha,
        lockfileSha256: finding.lockfileSha256,
        lockfileSourceRef: finding.lockfileSourceRef,
        eliminatedPathIds: new Set<StableId>(),
        affectedServices: new Set<string>(),
        evidenceRefs: new Set<string>(),
      };
      group.eliminatedPathIds.add(path.pathId);
      group.affectedServices.add(finding.serviceId);
      for (const reference of path.evidenceRefs) group.evidenceRefs.add(reference);
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort((left, right) =>
    left.snapshotId.localeCompare(right.snapshotId) ||
    left.dependencyName.localeCompare(right.dependencyName) ||
    left.fromVersion.localeCompare(right.fromVersion));
}

function requestedVersions(
  requested: Readonly<Record<string, readonly string[]>> | undefined,
  dependencyName: string,
): readonly string[] | undefined {
  if (requested === undefined) return undefined;
  const match = Object.entries(requested).find(
    ([name]) => normalizeNpmPackageName(name) === normalizeNpmPackageName(dependencyName),
  );
  return match?.[1];
}

interface ParsedSemver { major: number; minor: number; patch: number }

function parseStableSemver(version: string): ParsedSemver | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[^\s]+)?$/u.exec(version.trim());
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function semverImpact(from: ParsedSemver, to: ParsedSemver): SemverImpact {
  return from.major !== to.major ? "major" : from.minor !== to.minor ? "minor" : "patch";
}

function impactRank(impact: SemverImpact): number {
  return impact === "patch" ? 0 : impact === "minor" ? 1 : impact === "major" ? 2 : 3;
}

function rejection(
  group: CandidateGroup,
  reason: CandidateRejectionReason,
  message: string,
  toVersion?: string,
): CandidateRejection {
  return {
    dependencyName: group.dependencyName,
    fromVersion: group.fromVersion,
    ...(toVersion === undefined ? {} : { toVersion }),
    snapshotId: group.snapshotId,
    reason,
    message,
  };
}

function evidenceId(kind: string, value: string): string {
  return `E-${kind.toUpperCase()}-${stableIdFromCanonicalKey(`${kind}:${value}`)}`;
}

function manifestMatchesLockRoot(packageJson: string, packageLock: string): boolean {
  try {
    const manifest = JSON.parse(packageJson) as Record<string, unknown>;
    const lock = JSON.parse(packageLock) as { packages?: Record<string, Record<string, unknown>> };
    const root = lock.packages?.[""];
    if (root === undefined) return false;
    for (const key of ["name", "version", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
      if (canonicalJson(manifest[key]) !== canonicalJson(root[key])) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function lockfileChurn(before: string, after: string): number {
  const left = before.split(/\r?\n/u);
  const right = after.split(/\r?\n/u);
  let changed = 0;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) changed += 1;
  }
  return changed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown provider error";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
