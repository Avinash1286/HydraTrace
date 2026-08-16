import {
  ReachabilityLevel,
  stableIdFromCanonicalKey,
  type DeploymentManifest,
  type NormalizedResolution,
  type NormalizedResolutionEdge,
  type NormalizedSnapshot,
  type StableId,
} from "@hydratrace/domain";
import type { IncidentCatalog } from "./catalog.js";
import type {
  BlastRadiusFinding,
  BlastRadiusQuery,
  BlastRadiusResult,
  EvidencePath,
  IncidentRecord,
  RiskScore,
} from "./models.js";

const DEFAULT_PATH_DISPLAY_LIMIT = 20;
const DEFAULT_PATH_COUNT_LIMIT = 10_000;
const DEFAULT_FINDING_LIMIT = 100;

interface InternalPath {
  nodes: NormalizedResolution[];
  edges: NormalizedResolutionEdge[];
}

export function analyzeBlastRadius(
  catalog: IncidentCatalog,
  incidentId: StableId,
  query: BlastRadiusQuery = {},
  generatedAt = Date.now(),
): BlastRadiusResult {
  const incident = catalog.getIncident(incidentId);
  if (incident === undefined) throw new Error(`Incident ${incidentId} was not found`);
  const options = normalizeQuery(incident, query);
  const findings: BlastRadiusFinding[] = [];

  for (const entry of catalog.entries()) {
    const affectedVersions = entry.normalized.packages.filter(
      (version) =>
        version.normalizedName === incident.normalizedPackageName &&
        incident.affectedVersions.includes(version.version),
    );
    if (affectedVersions.length === 0) continue;

    for (const deployment of entry.deployments) {
      if (!deploymentMatches(deployment, entry.normalized, incident, options)) continue;
      for (const affectedVersion of affectedVersions) {
        const targets = entry.normalized.resolutions.filter(
          (resolution) => resolution.packageVersionId === affectedVersion.id,
        );
        if (targets.length === 0) continue;

        const enumerated = enumerateSnapshotPaths(
          entry.normalized,
          new Set(targets.map(({ id }) => id)),
          options.maxDepth,
          options.pathCountLimit,
        );
        const includedPaths = enumerated.paths.filter(
          (path) =>
            options.includeDevelopment ||
            deployment.criticality !== "production" ||
            !isDevelopmentOnly(path),
        );
        if (includedPaths.length === 0) continue;

        findings.push(
          buildFinding(
            catalog,
            incident,
            entry.normalized,
            deployment,
            affectedVersion.id,
            affectedVersion.name,
            affectedVersion.version,
            includedPaths,
            options.pathDisplayLimit,
            enumerated.truncated,
          ),
        );
      }
    }
  }

  findings.sort(compareFindings);
  const affectedServiceCount = new Set(findings.map(({ serviceId }) => serviceId)).size;
  for (const finding of findings) {
    finding.risk = riskScoreForFinding(incident, finding, affectedServiceCount);
  }
  const totalFindings = findings.length;
  const totalPaths = findings.reduce((total, finding) => total + finding.pathCount, 0);
  const paginated = findings.slice(options.offset, options.offset + options.limit);
  return {
    incidentId,
    generatedAt,
    query: {
      environments: options.environments,
      includeDevelopment: options.includeDevelopment,
      pathDisplayLimit: options.pathDisplayLimit,
      pathCountLimit: options.pathCountLimit,
      maxDepth: options.maxDepth,
      ...(options.at === undefined ? {} : { at: options.at }),
    },
    totalFindings,
    totalAffectedServices: affectedServiceCount,
    totalAffectedDeployments: new Set(findings.map(({ deploymentId }) => deploymentId)).size,
    totalPaths,
    pathsTruncated: findings.some(({ pathsTruncated }) => pathsTruncated),
    offset: options.offset,
    limit: options.limit,
    findings: paginated,
  };
}

interface NormalizedQuery {
  at?: number;
  environments: string[];
  includeDevelopment: boolean;
  pathDisplayLimit: number;
  pathCountLimit: number;
  maxDepth: number;
  offset: number;
  limit: number;
}

function normalizeQuery(
  incident: IncidentRecord,
  query: BlastRadiusQuery,
): NormalizedQuery {
  const at = query.at;
  if (at !== undefined && (!Number.isInteger(at) || at < 0)) {
    throw new Error("Blast-radius timestamp must be a nonnegative integer");
  }
  const pathDisplayLimit = boundedInteger(
    query.pathDisplayLimit ?? DEFAULT_PATH_DISPLAY_LIMIT,
    1,
    100,
    "pathDisplayLimit",
  );
  const pathCountLimit = boundedInteger(
    query.pathCountLimit ?? DEFAULT_PATH_COUNT_LIMIT,
    pathDisplayLimit,
    10_000,
    "pathCountLimit",
  );
  const maxDepth = boundedInteger(query.maxDepth ?? 16, 0, 16, "maxDepth");
  const offset = boundedInteger(query.offset ?? 0, 0, 100_000, "offset");
  const limit = boundedInteger(query.limit ?? DEFAULT_FINDING_LIMIT, 1, 100, "limit");
  const environments = [
    ...new Set((query.environments ?? incident.environments).map((value) => value.toLowerCase())),
  ].sort();
  return {
    environments,
    includeDevelopment: query.includeDevelopment ?? false,
    pathDisplayLimit,
    pathCountLimit,
    maxDepth,
    offset,
    limit,
    ...(at === undefined ? {} : { at }),
  };
}

function deploymentMatches(
  deployment: DeploymentManifest,
  normalized: NormalizedSnapshot,
  incident: IncidentRecord,
  query: NormalizedQuery,
): boolean {
  if (
    query.environments.length > 0 &&
    !query.environments.includes(deployment.environment.toLowerCase())
  ) {
    return false;
  }
  if (query.at !== undefined) {
    if (query.at < normalized.snapshot.createdAt) return false;
    if (query.at < deployment.startedAt) return false;
    if (deployment.endedAt !== null && query.at >= deployment.endedAt) return false;
    if (incident.startsAt !== undefined && query.at < incident.startsAt) return false;
    if (incident.endsAt !== undefined && query.at > incident.endsAt) return false;
    return true;
  }

  const exposureStart = Math.max(
    normalized.snapshot.createdAt,
    deployment.startedAt,
    incident.startsAt ?? Number.NEGATIVE_INFINITY,
  );
  const exposureEndExclusive = Math.min(
    deployment.endedAt ?? Number.POSITIVE_INFINITY,
    incident.endsAt === undefined
      ? Number.POSITIVE_INFINITY
      : incident.endsAt === Number.MAX_SAFE_INTEGER
        ? Number.POSITIVE_INFINITY
        : incident.endsAt + 1,
  );
  return exposureStart < exposureEndExclusive;
}

function enumerateSnapshotPaths(
  normalized: NormalizedSnapshot,
  targetIds: ReadonlySet<StableId>,
  maxDepth: number,
  countLimit: number,
): { paths: InternalPath[]; truncated: boolean } {
  const resolutions = new Map(
    normalized.resolutions.map((resolution) => [resolution.id, resolution]),
  );
  const adjacency = new Map<StableId, NormalizedResolutionEdge[]>();
  for (const edge of normalized.edges) {
    const list = adjacency.get(edge.fromResolutionId) ?? [];
    list.push(edge);
    adjacency.set(edge.fromResolutionId, list);
  }
  for (const edges of adjacency.values()) {
    edges.sort((left, right) => left.id.localeCompare(right.id));
  }
  const roots = normalized.resolutions
    .filter(({ root }) => root)
    .sort((left, right) => left.id.localeCompare(right.id));
  const pending: InternalPath[] = roots.map((root) => ({ nodes: [root], edges: [] }));
  const unique = new Map<string, InternalPath>();

  while (pending.length > 0 && unique.size <= countLimit) {
    const path = pending.shift();
    if (path === undefined) break;
    const current = path.nodes.at(-1);
    if (current === undefined) continue;
    if (targetIds.has(current.id)) {
      unique.set(path.nodes.map(({ id }) => id).join("/"), path);
      if (unique.size > countLimit) break;
    }
    if (path.edges.length >= maxDepth) continue;
    for (const edge of adjacency.get(current.id) ?? []) {
      if (path.nodes.some(({ id }) => id === edge.toResolutionId)) continue;
      const next = resolutions.get(edge.toResolutionId);
      if (next === undefined) continue;
      pending.push({ nodes: [...path.nodes, next], edges: [...path.edges, edge] });
    }
  }

  const paths = [...unique.values()]
    .sort((left, right) =>
      left.nodes
        .map(({ id }) => id)
        .join("/")
        .localeCompare(right.nodes.map(({ id }) => id).join("/")),
    )
    .slice(0, countLimit);
  return { paths, truncated: unique.size > countLimit };
}

function buildFinding(
  catalog: IncidentCatalog,
  incident: IncidentRecord,
  normalized: NormalizedSnapshot,
  deployment: DeploymentManifest,
  packageVersionId: StableId,
  packageName: string,
  version: string,
  paths: readonly InternalPath[],
  pathDisplayLimit: number,
  pathsTruncated: boolean,
): BlastRadiusFinding {
  const findingId = stableIdFromCanonicalKey(
    `finding:${incident.id}:${deployment.deploymentId}:${packageVersionId}`,
  );
  const evidencePaths = paths.map((path) =>
    publicEvidencePath(normalized.snapshot.id, deployment.deploymentId, path),
  );
  const firstExposedAt = Math.max(
    normalized.snapshot.createdAt,
    deployment.startedAt,
    incident.startsAt ?? Number.NEGATIVE_INFINITY,
  );
  const finiteEnds = [deployment.endedAt, incident.endsAt].filter(
    (value): value is number => value !== null && value !== undefined,
  );
  const lastExposedAt = finiteEnds.length === 0 ? null : Math.min(...finiteEnds);
  const evidenceRefs = [
    evidenceRef("snapshot", normalized.snapshot.id),
    evidenceRef("deployment", deployment.deploymentId),
    evidenceRef("package-version", packageVersionId),
    ...evidencePaths.map(({ pathId }) => evidenceRef("path", pathId)),
  ];
  const reachabilityEvidence = catalog.reachabilityFor(
    normalized.snapshot.id,
    packageName,
    version,
  );
  const reachability = reachabilityEvidence[0]?.level ?? ReachabilityLevel.Installed;
  return {
    findingId,
    serviceId: deployment.serviceId,
    deploymentId: deployment.deploymentId,
    repositoryId: deployment.repositoryId,
    environment: deployment.environment,
    criticality: deployment.criticality,
    snapshotId: normalized.snapshot.id,
    affectedPackageVersionId: packageVersionId,
    affectedPackageName: packageName,
    affectedVersion: version,
    firstExposedAt,
    lastExposedAt,
    direct: evidencePaths.some(({ direct }) => direct),
    developmentOnly: evidencePaths.every(({ developmentOnly }) => developmentOnly),
    pathCount: evidencePaths.length,
    displayedPaths: evidencePaths.slice(0, pathDisplayLimit),
    pathsTruncated: pathsTruncated || evidencePaths.length > pathDisplayLimit,
    reachability,
    reachabilityEvidence,
    evidenceRefs: [
      ...new Set([
        ...evidenceRefs,
        ...reachabilityEvidence.flatMap(({ evidenceRefs: refs }) => refs),
      ]),
    ],
    confidence: incident.windowConfidence,
    unknowns:
      incident.startsAt === undefined
        ? [
            "The exact malicious-publication window is unavailable; deployment exposure is confirmed but historical overlap is uncertain.",
          ]
        : [],
    risk: emptyRiskScore(),
  };
}

function riskScoreForFinding(
  incident: IncidentRecord,
  finding: BlastRadiusFinding,
  affectedServiceCount: number,
): RiskScore {
  const inputs = [
    ["severity", incident.severityScore, 0.25],
    ["environment", environmentRisk(finding.criticality), 0.2],
    ["reachability", reachabilityRisk(finding.reachability), 0.25],
    ["exposureBreadth", Math.min(1, affectedServiceCount / 5), 0.15],
    ["incidentTiming", incident.startsAt === undefined ? 0.5 : 1, 0.1],
    ["trustContext", incident.trustContextScore, 0.05],
  ] as const;
  const components = inputs.map(([name, raw, weight]) => ({
    name,
    raw,
    weight,
    contribution: round(raw * weight * 100),
  }));
  const score = round(components.reduce((sum, component) => sum + component.contribution, 0));
  return {
    score,
    label: score >= 90 ? "Critical" : score >= 70 ? "High" : score >= 40 ? "Medium" : "Low",
    components,
  };
}

function environmentRisk(criticality: DeploymentManifest["criticality"]): number {
  switch (criticality) {
    case "production": return 1;
    case "staging": return 0.65;
    case "development": return 0.3;
    case "unknown": return 0.45;
  }
}

function reachabilityRisk(level: ReachabilityLevel): number {
  switch (level) {
    case ReachabilityLevel.RuntimeObserved: return 1;
    case ReachabilityLevel.TestObserved: return 0.85;
    case ReachabilityLevel.StaticReachable: return 0.7;
    case ReachabilityLevel.UnknownDynamicBehavior: return 0.5;
    case ReachabilityLevel.Installed: return 0.35;
    case ReachabilityLevel.NotPresent: return 0;
  }
}

function emptyRiskScore(): RiskScore {
  return { score: 0, label: "Low", components: [] };
}

function round(value: number): number { return Math.round(value * 100) / 100; }

function publicEvidencePath(
  snapshotId: StableId,
  deploymentId: StableId,
  path: InternalPath,
): EvidencePath {
  const resolutionIds = path.nodes.map(({ id }) => id);
  const pathId = stableIdFromCanonicalKey(
    `evidence-path:${snapshotId}:${deploymentId}:${resolutionIds.join(":")}`,
  );
  return {
    pathId,
    snapshotId,
    resolutionIds,
    relationshipIds: path.edges.map(({ id }) => id),
    dependencyKinds: path.edges.map(({ kind }) => kind),
    nodes: path.nodes.map((resolution) => ({
      resolutionId: resolution.id,
      packageVersionId: resolution.packageVersionId,
      packageName: resolution.packageName,
      version: resolution.version,
      sourceKey: resolution.sourceKey,
      root: resolution.root,
      direct: resolution.direct,
      dev: resolution.dev,
      optional: resolution.optional,
      peer: resolution.peer,
    })),
    direct: path.edges.length <= 1,
    developmentOnly: isDevelopmentOnly(path),
    evidenceRefs: [
      evidenceRef("snapshot", snapshotId),
      evidenceRef("deployment", deploymentId),
      evidenceRef("path", pathId),
    ],
  };
}

function isDevelopmentOnly(path: InternalPath): boolean {
  return (
    path.edges[0]?.kind === "development" ||
    path.nodes.slice(1).some(({ dev }) => dev)
  );
}

function evidenceRef(kind: string, id: StableId): string {
  return `E-${kind.toUpperCase()}-${id}`;
}

function compareFindings(left: BlastRadiusFinding, right: BlastRadiusFinding): number {
  return (
    left.serviceId.localeCompare(right.serviceId) ||
    left.environment.localeCompare(right.environment) ||
    left.deploymentId.localeCompare(right.deploymentId) ||
    left.affectedVersion.localeCompare(right.affectedVersion)
  );
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
