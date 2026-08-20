import {
  canonicalKeys,
  ReachabilityLevel,
  stableIdFromCanonicalKey,
  type DeploymentManifest,
  type FactProvenance,
  type NormalizedPackageVersion,
  type NormalizedResolution,
  type NormalizedResolutionEdge,
  type NormalizedSnapshot,
  type StableId,
} from "@hydratrace/domain";
import type {
  GraphNodeRecord,
  GraphRelationshipRecord,
} from "@hydratrace/graph-schema";
import type { GraphStore } from "@hydratrace/hydradb-client";
import {
  analyzeBlastRadiusWithTraversedPaths,
  type BlastRadiusQuery,
  type BlastRadiusResult,
  type IncidentCatalog,
  type IncidentRecord,
  type TraversedDependencyPath,
  type TraversedDependencyPathSet,
} from "@hydratrace/incident-analysis";
import type { ReachabilityEvidence } from "@hydratrace/reachability";

const HYDRATION_QUERY_LIMIT = 10_000;
const DEFAULT_PATH_COUNT_LIMIT = 10_000;
const DEFAULT_MAX_PATH_DEPTH = 16;

export async function persistIncident(
  store: GraphStore,
  incident: IncidentRecord,
): Promise<void> {
  const node: GraphNodeRecord<"IncidentWindow"> = {
    id: incident.id,
    label: "IncidentWindow",
    properties: {
      ecosystem: "npm",
      packageName: incident.packageName,
      normalizedPackageName: incident.normalizedPackageName,
      affectedVersionsJson: JSON.stringify(incident.affectedVersions),
      environmentsJson: JSON.stringify(incident.environments),
      source: incident.source,
      windowSource: incident.windowSource,
      confidence: incident.windowConfidence,
      severityScore: incident.severityScore,
      trustContextScore: incident.trustContextScore,
      createdAt: incident.createdAt,
      ...(incident.advisoryId === undefined ? {} : { advisoryId: incident.advisoryId }),
      ...(incident.advisoryPublishedAt === undefined ? {} : { advisoryPublishedAt: incident.advisoryPublishedAt }),
      ...(incident.advisoryWithdrawnAt === undefined ? {} : { advisoryWithdrawnAt: incident.advisoryWithdrawnAt }),
      ...(incident.packagePublishedAt === undefined ? {} : { packagePublishedAt: incident.packagePublishedAt }),
      ...(incident.startsAt === undefined ? {} : { startsAt: incident.startsAt }),
      ...(incident.endsAt === undefined ? {} : { endsAt: incident.endsAt }),
    },
  };
  await store.write({ nodes: [node], relationships: [] });
}

export async function loadIncident(
  store: GraphStore,
  incidentId: StableId,
): Promise<IncidentRecord | undefined> {
  const node = (await store.getNodes([incidentId])).find(
    (candidate): candidate is GraphNodeRecord<"IncidentWindow"> => candidate.label === "IncidentWindow",
  );
  return node === undefined ? undefined : incidentFromNode(node);
}

export async function loadIncidents(store: GraphStore, limit = 10_000): Promise<IncidentRecord[]> {
  const nodes = await store.matchNodes({ label: "IncidentWindow", limit });
  return nodes
    .filter((node): node is GraphNodeRecord<"IncidentWindow"> => node.label === "IncidentWindow")
    .map(incidentFromNode)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function ensureIncidentCatalogHydrated(
  store: GraphStore,
  catalog: IncidentCatalog,
  incidentId: StableId,
): Promise<IncidentRecord | undefined> {
  let incident = catalog.getIncident(incidentId);
  if (incident === undefined) {
    incident = await loadIncident(store, incidentId);
    if (incident === undefined) return undefined;
    catalog.createIncident({
      ecosystem: "npm",
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
    }, incident.createdAt);
  }

  const affectedVersionIds = incident.affectedVersions.map((version) =>
    stableIdFromCanonicalKey(canonicalKeys.packageVersion("npm", incident.packageName, version)));
  const snapshotIds = new Set<StableId>();
  for (const packageVersionId of affectedVersionIds) {
    const instances = completeHydrationBatch(await store.matchRelationships({
      type: "INSTANCE_OF",
      to: { id: packageVersionId, label: "PackageVersion" },
      limit: HYDRATION_QUERY_LIMIT,
    }), `instances of package version ${packageVersionId}`);
    for (const instance of instances) {
      const containers = completeHydrationBatch(await store.matchRelationships({
        type: "CONTAINS",
        to: { id: instance.from.id, label: "Resolution" },
        limit: HYDRATION_QUERY_LIMIT,
      }), `snapshot containers for resolution ${instance.from.id}`);
      for (const container of containers) snapshotIds.add(container.from.id);
    }
  }
  for (const snapshotId of snapshotIds) {
    if (catalog.entry(snapshotId) === undefined) {
      const entry = await reconstructSnapshot(store, snapshotId);
      if (entry !== undefined) {
        if (entry.deployments.length === 0) catalog.registerSnapshot(entry.normalized);
        else for (const deployment of entry.deployments) catalog.registerSnapshot(entry.normalized, deployment);
        await hydrateReachability(store, catalog, snapshotId);
      }
    }
  }
  return incident;
}

/** Hydrates one exact immutable snapshot and its persisted reachability evidence. */
export async function ensureSnapshotCatalogHydrated(
  store: GraphStore,
  catalog: IncidentCatalog,
  snapshotId: StableId,
): Promise<boolean> {
  if (catalog.entry(snapshotId) === undefined) {
    const entry = await reconstructSnapshot(store, snapshotId);
    if (entry === undefined) return false;
    if (entry.deployments.length === 0) catalog.registerSnapshot(entry.normalized);
    for (const deployment of entry.deployments) {
      catalog.registerSnapshot(entry.normalized, deployment);
    }
  }
  await hydrateReachability(store, catalog, snapshotId);
  return true;
}

/**
 * Traverses dependency paths through GraphStore (HydraDB SPpaths in
 * production), then delegates temporal filtering, evidence shaping, risk, and
 * ordering to the deterministic reference analyzer.
 */
export async function analyzeBlastRadiusFromGraphStore(
  store: GraphStore,
  catalog: IncidentCatalog,
  incidentId: StableId,
  query: BlastRadiusQuery = {},
  generatedAt = Date.now(),
): Promise<BlastRadiusResult> {
  const incident = catalog.getIncident(incidentId);
  if (incident === undefined) throw new Error(`Incident ${incidentId} was not found`);
  const maxDepth = query.maxDepth ?? DEFAULT_MAX_PATH_DEPTH;
  const pathCountLimit = query.pathCountLimit ?? DEFAULT_PATH_COUNT_LIMIT;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 16) {
    throw new Error("maxDepth must be an integer between 0 and 16");
  }
  if (!Number.isInteger(pathCountLimit) || pathCountLimit < 1 || pathCountLimit > 10_000) {
    throw new Error("pathCountLimit must be an integer between 1 and 10000");
  }

  const traversedBySnapshotAndVersion = new Map<string, TraversedDependencyPathSet>();
  for (const entry of catalog.entries()) {
    const affectedVersions = entry.normalized.packages
      .filter(({ normalizedName, version }) =>
        normalizedName === incident.normalizedPackageName &&
        incident.affectedVersions.includes(version))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (affectedVersions.length === 0) continue;
    const roots = entry.normalized.resolutions
      .filter(({ root }) => root)
      .sort((left, right) => left.id.localeCompare(right.id));

    for (const affectedVersion of affectedVersions) {
      const targets = entry.normalized.resolutions
        .filter(({ packageVersionId }) => packageVersionId === affectedVersion.id)
        .sort((left, right) => left.id.localeCompare(right.id));
      if (targets.length === 0) continue;
      const traversed = await traverseSnapshotPaths(
        store,
        roots.map(({ id }) => id),
        targets.map(({ id }) => id),
        maxDepth,
        pathCountLimit,
      );
      traversedBySnapshotAndVersion.set(
        pathLookupKey(entry.normalized.snapshot.id, affectedVersion.id),
        traversed,
      );
    }
  }

  return analyzeBlastRadiusWithTraversedPaths(
    catalog,
    incidentId,
    query,
    ({ snapshotId, affectedPackageVersionId }) =>
      traversedBySnapshotAndVersion.get(pathLookupKey(snapshotId, affectedPackageVersionId)),
    generatedAt,
  );
}

async function traverseSnapshotPaths(
  store: GraphStore,
  rootIds: readonly StableId[],
  targetIds: readonly StableId[],
  maxDepth: number,
  countLimit: number,
): Promise<TraversedDependencyPathSet> {
  const pairs = rootIds.flatMap((rootId) =>
    targetIds.map((targetId) => ({ rootId, targetId })));
  const unique = new Map<string, TraversedDependencyPath>();
  let truncated = false;

  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair === undefined) continue;
    const remaining = countLimit - unique.size;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    // Fetch one sentinel path whenever HydraDB's 10,000 result cap permits it.
    // At the absolute cap an exactly-full result is conservatively marked
    // truncated because SPpaths v0.1.1 exposes no cursor or exact total count.
    const queryLimit = Math.min(10_000, remaining + 1);
    const paths = await store.findPaths({
      from: { id: pair.rootId, label: "Resolution" },
      to: { id: pair.targetId, label: "Resolution" },
      relationshipType: "DEPENDS_ON_INSTANCE",
      direction: "out",
      minDepth: 0,
      maxDepth,
      limit: queryLimit,
    });
    for (const path of paths) {
      unique.set(path.nodeIds.join("/"), {
        nodeIds: [...path.nodeIds],
        relationshipIds: [...path.relationshipIds],
      });
    }
    if (paths.length > remaining || (remaining === 10_000 && paths.length === 10_000)) {
      truncated = true;
      break;
    }
    if (unique.size >= countLimit && index < pairs.length - 1) {
      truncated = true;
      break;
    }
  }

  const paths = [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, countLimit)
    .map(([, path]) => path);
  return { paths, truncated };
}

function pathLookupKey(snapshotId: StableId, packageVersionId: StableId): string {
  return `${snapshotId}:${packageVersionId}`;
}

async function hydrateReachability(
  store: GraphStore,
  catalog: IncidentCatalog,
  snapshotId: StableId,
): Promise<void> {
  const nodes = completeHydrationBatch(await store.matchNodes({
    label: "Evidence",
    equals: { snapshotId },
    limit: HYDRATION_QUERY_LIMIT,
  }), `reachability evidence for snapshot ${snapshotId}`);
  for (const node of nodes) {
    if (node.label !== "Evidence" || !node.properties.type.startsWith("reachability:")) continue;
    const source = node.properties.type.slice("reachability:".length);
    if (source !== "static" && source !== "test-trace" && source !== "runtime-trace" && source !== "dynamic-unknown") continue;
    const level = asReachabilityLevel(node.properties.level);
    const evidenceRefs = parseStringArray(node.properties.evidenceRefsJson);
    const details = parseObject(node.properties.detailsJson);
    const evidence: ReachabilityEvidence = {
      id: node.id,
      snapshotId,
      packageName: node.properties.packageName,
      level,
      source,
      observedAt: node.properties.observedAt,
      evidenceRefs,
      details,
      ...(node.properties.version === undefined ? {} : { version: node.properties.version }),
    };
    catalog.registerReachabilityEvidence(evidence);
  }
}

async function reconstructSnapshot(
  store: GraphStore,
  snapshotId: StableId,
): Promise<{ normalized: NormalizedSnapshot; deployments: DeploymentManifest[] } | undefined> {
  const snapshotNode = (await store.getNodes([snapshotId])).find(
    (node): node is GraphNodeRecord<"LockfileSnapshot"> => node.label === "LockfileSnapshot",
  );
  if (snapshotNode === undefined) return undefined;
  const contains = completeHydrationBatch(await store.matchRelationships({
    type: "CONTAINS",
    from: { id: snapshotId, label: "LockfileSnapshot" },
    limit: HYDRATION_QUERY_LIMIT,
  }), `resolutions in snapshot ${snapshotId}`);
  const resolutionNodes = (await store.getNodes(contains.map(({ to }) => to.id)))
    .filter((node): node is GraphNodeRecord<"Resolution"> => node.label === "Resolution");
  const versionIds = [...new Set(resolutionNodes.map(({ properties }) => properties.packageVersionId))];
  const versionNodes = (await store.getNodes(versionIds))
    .filter((node): node is GraphNodeRecord<"PackageVersion"> => node.label === "PackageVersion");
  const provenanceByVersion = new Map<StableId, FactProvenance>();
  const resolutions: NormalizedResolution[] = resolutionNodes.map((node) => {
    const provenance = provenanceFromResolution(node);
    provenanceByVersion.set(node.properties.packageVersionId, provenance);
    return {
      id: node.id,
      snapshotId,
      packageVersionId: node.properties.packageVersionId,
      packageName: node.properties.packageName,
      version: node.properties.version,
      sourceKey: node.properties.sourceKey,
      installPath: node.properties.installPath,
      root: node.properties.root,
      direct: node.properties.direct,
      dev: node.properties.dev,
      optional: node.properties.optional,
      peer: node.properties.peer,
      provenance,
      ...(node.properties.integrity === undefined ? {} : { integrity: node.properties.integrity }),
      ...(node.properties.resolved === undefined ? {} : { resolved: node.properties.resolved }),
    };
  });
  const packages: NormalizedPackageVersion[] = versionNodes.map((node) => ({
    id: node.id,
    packageId: node.properties.packageId,
    ecosystem: "npm",
    name: node.properties.name,
    normalizedName: node.properties.normalizedName,
    version: node.properties.version,
    provenance: provenanceByVersion.get(node.id) ?? fallbackProvenance(snapshotNode),
    ...(node.properties.deprecated === undefined ? {} : { deprecated: node.properties.deprecated }),
  }));
  const dependencyRelationships = completeHydrationBatch(await store.matchRelationships({
    type: "DEPENDS_ON_INSTANCE",
    equals: { sourceSha256: snapshotNode.properties.contentHash },
    limit: HYDRATION_QUERY_LIMIT,
  }), `dependency relationships in snapshot ${snapshotId}`);
  const resolutionIds = new Set(resolutions.map(({ id }) => id));
  const edges: NormalizedResolutionEdge[] = dependencyRelationships
    .filter((relationship): relationship is GraphRelationshipRecord<"DEPENDS_ON_INSTANCE"> =>
      relationship.type === "DEPENDS_ON_INSTANCE" &&
      resolutionIds.has(relationship.from.id) &&
      resolutionIds.has(relationship.to.id))
    .map((relationship) => ({
      id: relationship.id,
      snapshotId,
      fromResolutionId: relationship.from.id,
      toResolutionId: relationship.to.id,
      dependencyName: relationship.properties.dependencyName,
      kind: relationship.properties.kind,
      provenance: provenanceFromRelationship(relationship),
      ...(relationship.properties.specifier === undefined ? {} : { specifier: relationship.properties.specifier }),
    }));
  const normalized: NormalizedSnapshot = {
    snapshot: {
      id: snapshotId,
      ecosystem: "npm",
      lockfileType: snapshotNode.properties.lockfileType,
      contentHash: snapshotNode.properties.contentHash,
      repositoryId: snapshotNode.properties.repositoryId,
      commitSha: snapshotNode.properties.commitSha,
      sourceRef: snapshotNode.properties.sourceRef,
      parserVersion: snapshotNode.properties.parserVersion,
      createdAt: snapshotNode.properties.createdAt,
      ...(snapshotNode.properties.validUntil === undefined ? {} : { validUntil: snapshotNode.properties.validUntil }),
    },
    packages,
    resolutions,
    edges,
    warnings: [],
  };
  const deployments = await reconstructDeployments(store, snapshotNode);
  return { normalized, deployments };
}

async function reconstructDeployments(
  store: GraphStore,
  snapshot: GraphNodeRecord<"LockfileSnapshot">,
): Promise<DeploymentManifest[]> {
  const uses = completeHydrationBatch(await store.matchRelationships({
    type: "USES_SNAPSHOT",
    to: { id: snapshot.id, label: "LockfileSnapshot" },
    limit: HYDRATION_QUERY_LIMIT,
  }), `deployments using snapshot ${snapshot.id}`);
  const deployments: DeploymentManifest[] = [];
  for (const use of uses) {
    const deployment = (await store.getNodes([use.from.id])).find(
      (node): node is GraphNodeRecord<"Deployment"> => node.label === "Deployment",
    );
    if (deployment === undefined) continue;
    const serviceRelationship = (await store.matchRelationships({
      type: "HAS_DEPLOYMENT",
      to: { id: deployment.id, label: "Deployment" },
      limit: 1,
    }))[0];
    const environmentRelationship = (await store.matchRelationships({
      type: "IN_ENVIRONMENT",
      from: { id: deployment.id, label: "Deployment" },
      limit: 1,
    }))[0];
    if (serviceRelationship === undefined || environmentRelationship === undefined) continue;
    // Keep v0.1.1 cold-start hydration conservative and sequential. This path
    // runs only while rebuilding the in-memory catalog, so parallel reads are
    // not worth adding another compatibility variable to the restored state.
    const service = await store.getNodes([serviceRelationship.from.id]);
    const environment = await store.getNodes([environmentRelationship.to.id]);
    const serviceNode = service.find((node): node is GraphNodeRecord<"Service"> => node.label === "Service");
    const environmentNode = environment.find((node): node is GraphNodeRecord<"Environment"> => node.label === "Environment");
    if (serviceNode === undefined || environmentNode === undefined) continue;
    deployments.push({
      schemaVersion: 1,
      organizationId: snapshot.properties.repositoryId.split("/")[0] ?? "unknown",
      repositoryId: snapshot.properties.repositoryId,
      serviceId: serviceNode.properties.name,
      deploymentId: deployment.id,
      environment: environmentNode.properties.name,
      criticality: asCriticality(environmentNode.properties.criticality),
      commitSha: snapshot.properties.commitSha,
      lockfile: snapshot.properties.sourceRef,
      lockfileSha256: snapshot.properties.contentHash,
      startedAt: deployment.properties.startedAt,
      endedAt: deployment.properties.endedAt ?? null,
    });
  }
  return deployments;
}

function incidentFromNode(node: GraphNodeRecord<"IncidentWindow">): IncidentRecord {
  const properties = node.properties;
  return {
    id: node.id,
    ecosystem: "npm",
    packageName: properties.packageName,
    normalizedPackageName: properties.normalizedPackageName,
    affectedVersions: parseStringArray(properties.affectedVersionsJson),
    environments: parseStringArray(properties.environmentsJson),
    source: asIncidentSource(properties.source),
    windowSource: properties.windowSource,
    windowConfidence: properties.confidence,
    severityScore: properties.severityScore,
    trustContextScore: properties.trustContextScore,
    createdAt: properties.createdAt,
    ...(properties.advisoryId === undefined ? {} : { advisoryId: properties.advisoryId }),
    ...(properties.advisoryPublishedAt === undefined ? {} : { advisoryPublishedAt: properties.advisoryPublishedAt }),
    ...(properties.advisoryWithdrawnAt === undefined ? {} : { advisoryWithdrawnAt: properties.advisoryWithdrawnAt }),
    ...(properties.packagePublishedAt === undefined ? {} : { packagePublishedAt: properties.packagePublishedAt }),
    ...(properties.startsAt === undefined ? {} : { startsAt: properties.startsAt }),
    ...(properties.endsAt === undefined ? {} : { endsAt: properties.endsAt }),
  };
}

function provenanceFromResolution(node: GraphNodeRecord<"Resolution">): FactProvenance {
  return {
    sourceType: node.properties.sourceType,
    sourceRef: node.properties.sourceRef,
    sourceSha256: node.properties.sourceSha256,
    repositoryId: node.properties.repositoryId,
    commitSha: node.properties.commitSha,
    importRunId: node.properties.importRunId,
    observedAt: node.properties.observedAt,
    parserVersion: node.properties.parserVersion,
    confidence: node.properties.confidence,
  };
}

function provenanceFromRelationship(
  relationship: GraphRelationshipRecord<"DEPENDS_ON_INSTANCE">,
): FactProvenance {
  return {
    sourceType: relationship.properties.sourceType,
    sourceRef: relationship.properties.sourceRef,
    sourceSha256: relationship.properties.sourceSha256,
    repositoryId: relationship.properties.repositoryId,
    commitSha: relationship.properties.commitSha,
    importRunId: relationship.properties.importRunId,
    observedAt: relationship.properties.observedAt,
    parserVersion: relationship.properties.parserVersion,
    confidence: relationship.properties.confidence,
  };
}

function fallbackProvenance(snapshot: GraphNodeRecord<"LockfileSnapshot">): FactProvenance {
  return {
    sourceType: snapshot.properties.lockfileType,
    sourceRef: snapshot.properties.sourceRef,
    sourceSha256: snapshot.properties.contentHash,
    repositoryId: snapshot.properties.repositoryId,
    commitSha: snapshot.properties.commitSha,
    importRunId: stableIdFromCanonicalKey(canonicalKeys.importRun(snapshot.id, snapshot.properties.parserVersion)),
    observedAt: snapshot.properties.createdAt,
    parserVersion: snapshot.properties.parserVersion,
    confidence: 1,
  };
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("Persisted incident contains an invalid string-array property");
  }
  return parsed;
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Persisted evidence contains invalid details JSON");
  }
  return parsed as Record<string, unknown>;
}

function asReachabilityLevel(value: number): ReachabilityLevel {
  if (!Object.values(ReachabilityLevel).includes(value)) {
    throw new Error("Persisted evidence contains an invalid reachability level");
  }
  return value;
}

function asIncidentSource(value: string): IncidentRecord["source"] {
  if (value !== "manual" && value !== "osv" && value !== "both") {
    throw new Error("Persisted incident contains an invalid source");
  }
  return value;
}

function asCriticality(value: string): DeploymentManifest["criticality"] {
  return value === "production" || value === "staging" || value === "development"
    ? value
    : "unknown";
}

function completeHydrationBatch<T>(records: readonly T[], context: string): readonly T[] {
  if (records.length >= HYDRATION_QUERY_LIMIT) {
    throw new Error(
      `Graph hydration for ${context} reached the ${HYDRATION_QUERY_LIMIT}-record limit; refusing an incomplete incident analysis`,
    );
  }
  return records;
}
