import {
  ReachabilityLevel,
  normalizeNpmPackageName,
  sha256Hex,
  type StableId,
} from "@hydratrace/domain";
import { IncidentCatalog } from "./catalog.js";
import type {
  BlastRadiusFinding,
  BlastRadiusResult,
  EvidencePath,
  IncidentRecord,
} from "./models.js";

export type IncidentComparisonStatus = "PASS" | "BLOCK" | "INCONCLUSIVE";

export interface IncidentComparisonReason {
  code: string;
  message: string;
}

export interface CanonicalBlockingPath {
  signature: string;
  repositoryId: string;
  serviceId: string;
  environment: string;
  affectedPackageName: string;
  affectedVersion: string;
  reachability: ReachabilityLevel;
  risk: BlastRadiusFinding["risk"]["label"];
  path: Array<{ packageName: string; version: string }>;
}

export interface IncidentComparisonResult {
  status: IncidentComparisonStatus;
  incidentId: StableId;
  baseline: {
    evidenceFingerprint: string;
    totalFindings: number;
    totalPaths: number;
    blockingPaths: number;
  };
  current: {
    evidenceFingerprint: string;
    totalFindings: number;
    totalPaths: number;
    blockingPaths: number;
  };
  newBlockingPaths: CanonicalBlockingPath[];
  reasons: IncidentComparisonReason[];
}

/**
 * Compares two already-pinned, complete blast-radius results. Snapshot,
 * deployment, resolution, and path IDs intentionally do not participate in
 * the cross-snapshot signature: those IDs change with lockfile content. The
 * signature instead describes the logical service/environment and exact
 * dependency chain below the application root.
 */
export function compareImmutableBlastRadius(
  baseline: BlastRadiusResult,
  current: BlastRadiusResult,
): IncidentComparisonResult {
  const reasons = [
    ...validateCompleteEvidence("baseline", baseline),
    ...validateCompleteEvidence("current", current),
  ];
  if (baseline.incidentId !== current.incidentId) {
    reasons.push({
      code: "INCIDENT_MISMATCH",
      message: "Baseline and current evidence were not evaluated against the same incident.",
    });
  }

  const baselineEvidence = canonicalEvidence(baseline, reasons, "baseline");
  const currentEvidence = canonicalEvidence(current, reasons, "current");
  const baselineBlocking = new Map(
    baselineEvidence.filter(({ blocking }) => blocking).map(({ path }) => [path.signature, path]),
  );
  const currentBlocking = new Map(
    currentEvidence.filter(({ blocking }) => blocking).map(({ path }) => [path.signature, path]),
  );
  const newBlockingPaths = [...currentBlocking]
    .filter(([signature]) => !baselineBlocking.has(signature))
    .map(([, path]) => path)
    .sort((left, right) => left.signature.localeCompare(right.signature));

  return {
    status: reasons.length > 0 ? "INCONCLUSIVE" : newBlockingPaths.length > 0 ? "BLOCK" : "PASS",
    incidentId: current.incidentId,
    baseline: evidenceSummary(baseline, baselineEvidence),
    current: evidenceSummary(current, currentEvidence),
    newBlockingPaths: reasons.length > 0 ? [] : newBlockingPaths,
    reasons: uniqueReasons(reasons),
  };
}

/** Creates an isolated catalog so both sides are evaluated from pinned copies. */
export function incidentCatalogForSnapshots(
  source: IncidentCatalog,
  incidentId: StableId,
  snapshotIds: readonly StableId[],
): IncidentCatalog {
  const incident = source.getIncident(incidentId);
  if (incident === undefined) throw new Error(`Incident ${incidentId} was not found`);
  const target = new IncidentCatalog();
  const clonedIncident = target.createIncident(incidentInput(incident), incident.createdAt);
  if (clonedIncident.id !== incident.id) {
    throw new Error("The incident could not be reproduced canonically");
  }

  for (const snapshotId of [...new Set(snapshotIds)].sort()) {
    const entry = source.entry(snapshotId);
    if (entry === undefined) throw new Error(`Snapshot ${snapshotId} was not found`);
    if (entry.deployments.length === 0) target.registerSnapshot(entry.normalized);
    for (const deployment of entry.deployments) {
      target.registerSnapshot(entry.normalized, deployment);
    }
    const versions = new Map(
      entry.normalized.packages.map(({ name, version }) => [`${normalizeNpmPackageName(name)}\0${version}`, { name, version }]),
    );
    for (const { name, version } of versions.values()) {
      for (const evidence of source.reachabilityFor(snapshotId, name, version)) {
        target.registerReachabilityEvidence(evidence);
      }
    }
  }
  return target;
}

function validateCompleteEvidence(
  side: "baseline" | "current",
  result: BlastRadiusResult,
): IncidentComparisonReason[] {
  const reasons: IncidentComparisonReason[] = [];
  if (result.offset !== 0 || result.findings.length !== result.totalFindings) {
    reasons.push({
      code: "FINDINGS_INCOMPLETE",
      message: `The ${side} result does not contain every finding in one immutable response.`,
    });
  }
  if (result.query.pathOffset !== 0) {
    reasons.push({
      code: "PATH_WINDOW_INCOMPLETE",
      message: `The ${side} result starts after the first canonical path.`,
    });
  }
  if (result.pathsTruncated) {
    reasons.push({
      code: "PATHS_TRUNCATED",
      message: `The ${side} result reached a path display or traversal limit.`,
    });
  }
  const countedPaths = result.findings.reduce((total, finding) => total + finding.pathCount, 0);
  if (countedPaths !== result.totalPaths) {
    reasons.push({
      code: "PATH_TOTAL_CHANGED",
      message: `The ${side} path total does not match its findings.`,
    });
  }
  if (new Set(result.findings.map(({ serviceId }) => serviceId)).size !== result.totalAffectedServices) {
    reasons.push({
      code: "SERVICE_TOTAL_CHANGED",
      message: `The ${side} affected-service total does not match its findings.`,
    });
  }
  if (new Set(result.findings.map(({ deploymentId }) => deploymentId)).size !== result.totalAffectedDeployments) {
    reasons.push({
      code: "DEPLOYMENT_TOTAL_CHANGED",
      message: `The ${side} affected-deployment total does not match its findings.`,
    });
  }
  for (const finding of result.findings) {
    if (
      finding.pathCountTruncated ||
      finding.pathsTruncated ||
      finding.pathCount < 1 ||
      finding.displayedPaths.length !== finding.pathCount
    ) {
      reasons.push({
        code: "FINDING_PATHS_INCOMPLETE",
        message: `Finding ${finding.findingId} in ${side} lacks its complete path set.`,
      });
    }
    const riskProblem = validateRisk(finding);
    if (riskProblem !== undefined) {
      reasons.push({
        code: "RISK_EVIDENCE_MISSING",
        message: `Finding ${finding.findingId} in ${side}: ${riskProblem}`,
      });
    }
    if (isProvenReachability(finding.reachability)) {
      const matchingEvidence = finding.reachabilityEvidence.filter(
        ({ level }) => level === finding.reachability,
      );
      if (
        matchingEvidence.length === 0 ||
        matchingEvidence.some(({ evidenceRefs }) => evidenceRefs.length === 0)
      ) {
        reasons.push({
          code: "REACHABILITY_EVIDENCE_MISSING",
          message: `Finding ${finding.findingId} claims proven reachability without complete evidence.`,
        });
      }
    }
  }
  return reasons;
}

function validateRisk(finding: BlastRadiusFinding): string | undefined {
  const expectedNames = [
    "severity",
    "environment",
    "reachability",
    "exposureBreadth",
    "incidentTiming",
    "trustContext",
  ];
  const components = finding.risk.components;
  if (
    components.length !== expectedNames.length ||
    [...components].map(({ name }) => name).sort().join("\0") !== [...expectedNames].sort().join("\0")
  ) return "the deterministic risk breakdown is incomplete";
  if (components.some(({ raw, weight, contribution }) =>
    !Number.isFinite(raw) || raw < 0 || raw > 1 ||
    !Number.isFinite(weight) || weight < 0 || weight > 1 ||
    !Number.isFinite(contribution))) {
    return "the deterministic risk breakdown contains invalid numbers";
  }
  const calculated = Math.round(
    components.reduce((total, { contribution }) => total + contribution, 0) * 100,
  ) / 100;
  if (calculated !== finding.risk.score) return "the risk score does not equal its component sum";
  const expectedLabel = calculated >= 90 ? "Critical" : calculated >= 70 ? "High" : calculated >= 40 ? "Medium" : "Low";
  if (finding.risk.label !== expectedLabel) return "the risk label does not match its deterministic score";
  return undefined;
}

function canonicalEvidence(
  result: BlastRadiusResult,
  reasons: IncidentComparisonReason[],
  side: "baseline" | "current",
): Array<{ path: CanonicalBlockingPath; blocking: boolean }> {
  const evidence: Array<{ path: CanonicalBlockingPath; blocking: boolean }> = [];
  const occurrences = new Map<string, number>();
  const blockingByBaseSignature = new Map<string, boolean>();
  for (const finding of result.findings) {
    for (const path of finding.displayedPaths) {
      const invalid = validatePath(finding, path);
      if (invalid !== undefined) {
        reasons.push({
          code: "MALFORMED_PATH_EVIDENCE",
          message: `${side} finding ${finding.findingId}: ${invalid}`,
        });
        continue;
      }
      const baseSignature = canonicalPathSignature(finding, path);
      const occurrence = occurrences.get(baseSignature) ?? 0;
      occurrences.set(baseSignature, occurrence + 1);
      const signature = sha256Hex(`${baseSignature}\0${occurrence}`);
      const record = {
        path: {
          signature,
          repositoryId: finding.repositoryId,
          serviceId: finding.serviceId,
          environment: finding.environment,
          affectedPackageName: finding.affectedPackageName,
          affectedVersion: finding.affectedVersion,
          reachability: finding.reachability,
          risk: finding.risk.label,
          path: path.nodes.map(({ packageName, version }) => ({ packageName, version })),
        },
        blocking: isBlockingFinding(finding),
      };
      const previousBlocking = blockingByBaseSignature.get(baseSignature);
      if (previousBlocking !== undefined && previousBlocking !== record.blocking) {
        reasons.push({
          code: "EVIDENCE_CHANGED_DURING_COMPARISON",
          message: `${side} contains conflicting risk or reachability evidence for canonical path ${baseSignature}.`,
        });
      }
      blockingByBaseSignature.set(baseSignature, previousBlocking ?? record.blocking);
      evidence.push(record);
    }
  }
  return evidence.sort((left, right) =>
    left.path.signature.localeCompare(right.path.signature));
}

function validatePath(finding: BlastRadiusFinding, path: EvidencePath): string | undefined {
  if (path.snapshotId !== finding.snapshotId) return "path snapshot does not match its finding";
  if (path.nodes.length === 0 || !path.nodes[0]?.root) return "path does not begin at a root resolution";
  if (
    path.resolutionIds.length !== path.nodes.length ||
    path.relationshipIds.length !== path.nodes.length - 1 ||
    path.dependencyKinds.length !== path.relationshipIds.length
  ) return "node and relationship cardinalities are inconsistent";
  if (path.nodes.some((node, index) => node.resolutionId !== path.resolutionIds[index])) {
    return "resolution IDs are inconsistent";
  }
  const affected = path.nodes.at(-1);
  if (
    affected === undefined ||
    normalizeNpmPackageName(affected.packageName) !== normalizeNpmPackageName(finding.affectedPackageName) ||
    affected.version !== finding.affectedVersion
  ) return "path does not end at the exact affected package version";
  if (path.evidenceRefs.length === 0) return "path has no evidence references";
  return undefined;
}

function canonicalPathSignature(finding: BlastRadiusFinding, path: EvidencePath): string {
  // The application root is represented canonically by repository/service;
  // excluding its package version prevents every ordinary application release
  // from looking like a new transitive dependency path.
  const dependencyNodes = path.nodes.slice(1).map((node) => ({
    packageName: normalizeNpmPackageName(node.packageName),
    version: node.version,
    sourceKey: node.sourceKey.replaceAll("\\", "/"),
    dev: node.dev,
    optional: node.optional,
    peer: node.peer,
  }));
  return sha256Hex(canonicalJson({
    repositoryId: finding.repositoryId,
    serviceId: finding.serviceId,
    lockfileSourceRef: finding.lockfileSourceRef.replaceAll("\\", "/"),
    environment: finding.environment.toLowerCase(),
    criticality: finding.criticality,
    affectedPackageName: normalizeNpmPackageName(finding.affectedPackageName),
    affectedVersion: finding.affectedVersion,
    dependencyNodes,
    dependencyKinds: path.dependencyKinds,
  }));
}

function evidenceSummary(
  result: BlastRadiusResult,
  evidence: Array<{ path: CanonicalBlockingPath; blocking: boolean }>,
): IncidentComparisonResult["baseline"] {
  return {
    evidenceFingerprint: sha256Hex(canonicalJson(evidence)),
    totalFindings: result.totalFindings,
    totalPaths: result.totalPaths,
    blockingPaths: evidence.filter(({ blocking }) => blocking).length,
  };
}

function isBlockingFinding(finding: BlastRadiusFinding): boolean {
  return (
    (finding.risk.label === "Critical" || finding.risk.label === "High") &&
    isProvenReachability(finding.reachability)
  );
}

function isProvenReachability(level: ReachabilityLevel): boolean {
  return level === ReachabilityLevel.StaticReachable ||
    level === ReachabilityLevel.TestObserved ||
    level === ReachabilityLevel.RuntimeObserved;
}

function incidentInput(incident: IncidentRecord): Parameters<IncidentCatalog["createIncident"]>[0] {
  return {
    ecosystem: incident.ecosystem,
    packageName: incident.packageName,
    affectedVersions: incident.affectedVersions,
    environments: incident.environments,
    source: incident.source,
    windowSource: incident.windowSource,
    windowConfidence: incident.windowConfidence,
    severityScore: incident.severityScore,
    trustContextScore: incident.trustContextScore,
    ...(incident.advisoryId === undefined ? {} : { advisoryId: incident.advisoryId }),
    ...(incident.advisoryPublishedAt === undefined ? {} : { advisoryPublishedAt: incident.advisoryPublishedAt }),
    ...(incident.advisoryWithdrawnAt === undefined ? {} : { advisoryWithdrawnAt: incident.advisoryWithdrawnAt }),
    ...(incident.packagePublishedAt === undefined ? {} : { packagePublishedAt: incident.packagePublishedAt }),
    ...(incident.startsAt === undefined ? {} : { startsAt: incident.startsAt }),
    ...(incident.endsAt === undefined ? {} : { endsAt: incident.endsAt }),
  };
}

function uniqueReasons(reasons: readonly IncidentComparisonReason[]): IncidentComparisonReason[] {
  const unique = new Map(reasons.map((reason) => [`${reason.code}\0${reason.message}`, reason]));
  return [...unique.values()].sort((left, right) =>
    left.code.localeCompare(right.code) || left.message.localeCompare(right.message));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
