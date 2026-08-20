import { sha256Hex, type StableId } from "@hydratrace/domain";
import type { GraphNodeRecord } from "@hydratrace/graph-schema";
import { HydraDbGraphStore, type GraphStore } from "@hydratrace/hydradb-client";
import {
  IncidentCatalog,
  buildExposureTimeline,
  compareImmutableBlastRadius,
  incidentCatalogForSnapshots,
  type BlastRadiusQuery,
  type CatalogEntry,
  type IncidentComparisonReason,
  type IncidentComparisonResult,
  type IncidentRecord,
} from "@hydratrace/incident-analysis";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  analyzeBlastRadiusFromGraphStore,
  ensureIncidentCatalogHydrated,
  ensureSnapshotCatalogHydrated,
  loadIncident,
  loadIncidents,
  persistIncident,
} from "./graph-catalog.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MAX_PAGE_OFFSET,
  pageMetadata,
  paginate,
} from "./pagination.js";

const stableIdSchema = z.string().regex(/^\d+$/);

const incidentBodySchema = z
  .object({
    ecosystem: z.literal("npm"),
    packageName: z.string().trim().min(1).max(214),
    affectedVersions: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
    advisoryId: z.string().trim().min(1).max(256).optional(),
    advisoryPublishedAt: z.number().int().nonnegative().optional(),
    advisoryWithdrawnAt: z.number().int().nonnegative().optional(),
    packagePublishedAt: z.number().int().nonnegative().optional(),
    startsAt: z.number().int().nonnegative().optional(),
    endsAt: z.number().int().nonnegative().optional(),
    environments: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
    source: z.enum(["manual", "osv", "both"]).optional(),
    windowSource: z.string().trim().min(1).max(256).optional(),
    windowConfidence: z.number().min(0).max(1).optional(),
    severityScore: z.number().min(0).max(1).optional(),
    trustContextScore: z.number().min(0).max(1).optional(),
  })
  .strict();

const listQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).max(MAX_PAGE_OFFSET).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});

const blastQuerySchema = z.object({
  at: z.coerce.number().int().nonnegative().optional(),
  environments: z.string().trim().optional(),
  includeDevelopment: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  pathDisplayLimit: z.coerce.number().int().min(1).max(100).optional(),
  pathCountLimit: z.coerce.number().int().min(1).max(10_000).optional(),
  maxDepth: z.coerce.number().int().min(0).max(16).optional(),
  offset: z.coerce.number().int().min(0).max(MAX_PAGE_OFFSET).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
});

const exactCommitShaSchema = z.string().regex(
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu,
  "commitSha must be an immutable 40- or 64-character hexadecimal Git object ID",
);
const comparisonSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), snapshotId: stableIdSchema }).strict(),
  z.object({
    kind: z.literal("commit"),
    repositoryId: z.string().trim().min(1).max(512),
    commitSha: exactCommitShaSchema,
  }).strict(),
  // Accepted so callers receive a fail-closed domain result instead of being
  // tempted to treat an unresolvable scan ID as a snapshot ID.
  z.object({ kind: z.literal("scan"), scanId: stableIdSchema }).strict(),
]);
const comparisonBodySchema = z.object({
  baseline: comparisonSelectorSchema,
  current: comparisonSelectorSchema,
  environments: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
  includeDevelopment: z.boolean().default(false),
}).strict();

type ComparisonSelector = z.infer<typeof comparisonSelectorSchema>;

const pathsQuerySchema = blastQuerySchema.extend({
  pathOffset: z.coerce.number().int().min(0).max(9_999).default(0),
  pathLimit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
});

const findingPathQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).max(9_999).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(MAX_PAGE_LIMIT),
  pathCountLimit: z.coerce.number().int().min(1).max(10_000).default(10_000),
  maxDepth: z.coerce.number().int().min(0).max(16).default(16),
}).refine(({ offset, limit, pathCountLimit }) => pathCountLimit >= offset + limit);

export function registerIncidentRoutes(
  application: FastifyInstance,
  catalog: IncidentCatalog,
  graphStore: GraphStore,
): void {
  application.post("/v1/incidents", async (request, reply) => {
    const parsed = incidentBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_INCIDENT",
        issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
      });
    }
    try {
      const incident = catalog.createIncident({
        ecosystem: parsed.data.ecosystem,
        packageName: parsed.data.packageName,
        affectedVersions: parsed.data.affectedVersions,
        ...(parsed.data.advisoryId === undefined
          ? {}
          : { advisoryId: parsed.data.advisoryId }),
        ...(parsed.data.advisoryPublishedAt === undefined ? {} : { advisoryPublishedAt: parsed.data.advisoryPublishedAt }),
        ...(parsed.data.advisoryWithdrawnAt === undefined ? {} : { advisoryWithdrawnAt: parsed.data.advisoryWithdrawnAt }),
        ...(parsed.data.packagePublishedAt === undefined ? {} : { packagePublishedAt: parsed.data.packagePublishedAt }),
        ...(parsed.data.startsAt === undefined
          ? {}
          : { startsAt: parsed.data.startsAt }),
        ...(parsed.data.endsAt === undefined
          ? {}
          : { endsAt: parsed.data.endsAt }),
        ...(parsed.data.environments === undefined
          ? {}
          : { environments: parsed.data.environments }),
        ...(parsed.data.source === undefined ? {} : { source: parsed.data.source }),
        ...(parsed.data.windowSource === undefined
          ? {}
          : { windowSource: parsed.data.windowSource }),
        ...(parsed.data.windowConfidence === undefined
          ? {}
          : { windowConfidence: parsed.data.windowConfidence }),
        ...(parsed.data.severityScore === undefined
          ? {}
          : { severityScore: parsed.data.severityScore }),
        ...(parsed.data.trustContextScore === undefined
          ? {}
          : { trustContextScore: parsed.data.trustContextScore }),
      });
      await persistIncident(graphStore, incident);
      return reply.code(201).send({ incident });
    } catch (error) {
      return reply.code(400).send({
        error: "INCIDENT_CREATION_FAILED",
        message: error instanceof Error ? error.message : "Unknown incident error",
      });
    }
  });

  application.post(
    "/v1/incidents/:incidentId/comparison",
    async (request, reply) => {
      const incidentId = parseIncidentId(request.params);
      const parsed = comparisonBodySchema.safeParse(request.body);
      if (incidentId === undefined || !parsed.success) {
        return reply.code(400).send({
          error: "INVALID_INCIDENT_COMPARISON",
          ...(!parsed.success
            ? { issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) }
            : {}),
        });
      }
      if (await ensureIncidentCatalogHydrated(graphStore, catalog, incidentId) === undefined) {
        return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
      }
      const incident = catalog.getIncident(incidentId);
      if (incident === undefined) return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
      if (
        graphStore instanceof HydraDbGraphStore &&
        process.env.HYDRADB_CONSISTENCY !== "strong"
      ) {
        return inconclusiveComparison(
          incidentId,
          emptySelection(),
          emptySelection(),
          [{
            code: "STRONG_CONSISTENCY_REQUIRED",
            message: "Atomic baseline decisions require HYDRADB_CONSISTENCY=strong.",
          }],
        );
      }

      try {
        const [baseline, current] = await Promise.all([
          resolveComparisonSelection(graphStore, catalog, incident, parsed.data.baseline),
          resolveComparisonSelection(graphStore, catalog, incident, parsed.data.current),
        ]);
        const selectionReasons = [...baseline.reasons, ...current.reasons];
        if (selectionReasons.length > 0 || baseline.snapshotIds.length === 0 || current.snapshotIds.length === 0) {
          return inconclusiveComparison(
            incidentId,
            baseline,
            current,
            selectionReasons.length > 0
              ? selectionReasons
              : [{ code: "SNAPSHOT_NOT_FOUND", message: "Baseline or current snapshot evidence is unavailable." }],
          );
        }

        const baselineCatalog = incidentCatalogForSnapshots(catalog, incidentId, baseline.snapshotIds);
        const currentCatalog = incidentCatalogForSnapshots(catalog, incidentId, current.snapshotIds);
        const generatedAt = Date.now();
        const query: BlastRadiusQuery = {
          includeDevelopment: parsed.data.includeDevelopment,
          pathDisplayLimit: 100,
          pathCountLimit: 100,
          maxDepth: 16,
          offset: 0,
          limit: 100,
          ...(parsed.data.environments === undefined
            ? {}
            : { environments: parsed.data.environments }),
        };
        const baselineBlast = await analyzeBlastRadiusFromGraphStore(
          graphStore,
          baselineCatalog,
          incidentId,
          query,
          generatedAt,
        );
        const currentBlast = await analyzeBlastRadiusFromGraphStore(
          graphStore,
          currentCatalog,
          incidentId,
          query,
          generatedAt,
        );
        const comparison = compareImmutableBlastRadius(baselineBlast, currentBlast);

        // Exact snapshots are immutable, but reachability and the set selected
        // by a commit can grow. Re-resolve after both graph traversals and
        // refuse a decision if either evidence set changed during the request.
        const [baselineAfter, currentAfter] = await Promise.all([
          resolveComparisonSelection(graphStore, catalog, incident, parsed.data.baseline),
          resolveComparisonSelection(graphStore, catalog, incident, parsed.data.current),
        ]);
        const changedReasons: IncidentComparisonReason[] = [];
        if (
          baseline.fingerprint !== baselineAfter.fingerprint ||
          current.fingerprint !== currentAfter.fingerprint
        ) {
          changedReasons.push({
            code: "EVIDENCE_CHANGED_DURING_COMPARISON",
            message: "Snapshot, deployment, or reachability evidence changed while the comparison was running.",
          });
        }
        changedReasons.push(...baselineAfter.reasons, ...currentAfter.reasons);
        const finalComparison: IncidentComparisonResult = changedReasons.length === 0
          ? comparison
          : {
              ...comparison,
              status: "INCONCLUSIVE",
              newBlockingPaths: [],
              reasons: [...comparison.reasons, ...changedReasons],
            };
        return {
          comparison: finalComparison,
          baseline: publicSelection(baseline),
          current: publicSelection(current),
        };
      } catch (error) {
        return inconclusiveComparison(
          incidentId,
          emptySelection(),
          emptySelection(),
          [{
            code: "COMPARISON_FAILED",
            message: error instanceof Error ? error.message : "Unknown comparison failure",
          }],
        );
      }
    },
  );

  application.get("/v1/incidents", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_PAGINATION" });
    const durable = await loadIncidents(graphStore);
    const incidents = durable.length === 0 ? catalog.listIncidents() : durable;
    const paginated = paginate(incidents, parsed.data.offset, parsed.data.limit);
    return {
      total: incidents.length,
      offset: parsed.data.offset,
      limit: parsed.data.limit,
      incidents: paginated.items,
      page: paginated.page,
    };
  });

  application.get("/v1/incidents/:incidentId", async (request, reply) => {
    const incidentId = parseIncidentId(request.params);
    if (incidentId === undefined) {
      return reply.code(400).send({ error: "INVALID_INCIDENT_ID" });
    }
    const incident = catalog.getIncident(incidentId) ?? await loadIncident(graphStore, incidentId);
    return incident === undefined
      ? reply.code(404).send({ error: "INCIDENT_NOT_FOUND" })
      : { incident };
  });

  application.get(
    "/v1/incidents/:incidentId/blast-radius",
    async (request, reply) => {
      const incidentId = parseIncidentId(request.params);
      const query = parseBlastQuery(request.query);
      if (incidentId === undefined || query === undefined) {
        return reply.code(400).send({ error: "INVALID_BLAST_RADIUS_QUERY" });
      }
      if (await ensureIncidentCatalogHydrated(graphStore, catalog, incidentId) === undefined) {
        return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
      }
      try {
        const result = await analyzeBlastRadiusFromGraphStore(
          graphStore,
          catalog,
          incidentId,
          query,
        );
        return {
          ...result,
          page: pageMetadata(result.totalFindings, result.offset, result.limit, result.findings.length),
        };
      } catch (error) {
        return reply.code(400).send({
          error: "BLAST_RADIUS_FAILED",
          message: error instanceof Error ? error.message : "Unknown analysis error",
        });
      }
    },
  );

  application.get(
    "/v1/incidents/:incidentId/timeline",
    async (request, reply) => {
      const incidentId = parseIncidentId(request.params);
      const pagination = listQuerySchema.safeParse(request.query);
      if (incidentId === undefined || !pagination.success) {
        return reply.code(400).send({ error: "INVALID_PAGINATION" });
      }
      if (await ensureIncidentCatalogHydrated(graphStore, catalog, incidentId) === undefined) {
        return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
      }
      const timeline = buildExposureTimeline(catalog, incidentId);
      const events = paginate(timeline.events, pagination.data.offset, pagination.data.limit);
      return {
        ...timeline,
        events: events.items,
        totalEvents: timeline.events.length,
        totalEventsExact: !timeline.sourceFindingsTruncated,
        eventsTruncated: timeline.sourceFindingsTruncated || events.page.truncated,
        page: events.page,
      };
    },
  );

  application.get("/v1/incidents/:incidentId/paths", async (request, reply) => {
    const incidentId = parseIncidentId(request.params);
    const parsedQuery = parsePathsQuery(request.query);
    if (incidentId === undefined || parsedQuery === undefined) {
      return reply.code(400).send({ error: "INVALID_PATH_QUERY" });
    }
    if (await ensureIncidentCatalogHydrated(graphStore, catalog, incidentId) === undefined) {
      return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
    }
    const result = await analyzeBlastRadiusFromGraphStore(
      graphStore,
      catalog,
      incidentId,
      parsedQuery.query,
    );
    return {
      incidentId,
      totalPaths: result.totalPaths,
      pathsTruncated: result.pathsTruncated,
      totalFindings: result.totalFindings,
      offset: result.offset,
      limit: result.limit,
      page: pageMetadata(result.totalFindings, result.offset, result.limit, result.findings.length),
      findings: result.findings.map((finding) => {
        const displayedPaths = finding.displayedPaths;
        return {
          findingId: finding.findingId,
          serviceId: finding.serviceId,
          deploymentId: finding.deploymentId,
          pathCount: finding.pathCount,
          pathCountTruncated: finding.pathCountTruncated,
          displayedPaths,
          pathsTruncated: finding.pathsTruncated || parsedQuery.pathOffset > 0,
          pathPage: pathPageMetadata(
            finding.pathCount,
            finding.pathCountTruncated,
            parsedQuery.pathOffset,
            parsedQuery.pathLimit,
            displayedPaths.length,
          ),
        };
      }),
    };
  });

  application.get(
    "/v1/incidents/:incidentId/findings/:findingId",
    async (request, reply) => {
      const parameters = z
        .object({ incidentId: stableIdSchema, findingId: stableIdSchema })
        .safeParse(request.params);
      if (!parameters.success) {
        return reply.code(400).send({ error: "INVALID_FINDING_ID" });
      }
      const query = findingPathQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ error: "INVALID_PAGINATION" });
      }
      const incidentId = parameters.data.incidentId as StableId;
      if (await ensureIncidentCatalogHydrated(graphStore, catalog, incidentId) === undefined) {
        return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
      }
      const result = await analyzeBlastRadiusFromGraphStore(graphStore, catalog, incidentId, {
        includeDevelopment: true,
        pathOffset: query.data.offset,
        pathDisplayLimit: query.data.limit,
        pathCountLimit: query.data.pathCountLimit,
        maxDepth: query.data.maxDepth,
        findingId: parameters.data.findingId as StableId,
        limit: 1,
      });
      const finding = result.findings[0];
      const displayedPaths = finding?.displayedPaths;
      return finding === undefined
        ? reply.code(404).send({ error: "FINDING_NOT_FOUND" })
        : {
            finding: {
              ...finding,
              displayedPaths,
              pathsTruncated: finding.pathsTruncated || query.data.offset > 0,
            },
            pathPage: pathPageMetadata(
              finding.pathCount,
              finding.pathCountTruncated,
              query.data.offset,
              query.data.limit,
              displayedPaths?.length ?? 0,
            ),
            pathCountTruncated: finding.pathCountTruncated,
          };
    },
  );
}

function parseIncidentId(parameters: unknown): StableId | undefined {
  const parsed = z.object({ incidentId: stableIdSchema }).safeParse(parameters);
  return parsed.success ? (parsed.data.incidentId as StableId) : undefined;
}

function parseBlastQuery(value: unknown): BlastRadiusQuery | undefined {
  const parsed = blastQuerySchema.safeParse(value);
  if (!parsed.success) return undefined;
  const environments = parsed.data.environments
    ?.split(",")
    .map((environment) => environment.trim())
    .filter((environment) => environment.length > 0);
  return {
    ...(parsed.data.at === undefined ? {} : { at: parsed.data.at }),
    ...(environments === undefined ? {} : { environments }),
    ...(parsed.data.includeDevelopment === undefined
      ? {}
      : { includeDevelopment: parsed.data.includeDevelopment }),
    ...(parsed.data.pathDisplayLimit === undefined
      ? {}
      : { pathDisplayLimit: parsed.data.pathDisplayLimit }),
    ...(parsed.data.pathCountLimit === undefined
      ? {}
      : { pathCountLimit: parsed.data.pathCountLimit }),
    ...(parsed.data.maxDepth === undefined
      ? {}
      : { maxDepth: parsed.data.maxDepth }),
    ...(parsed.data.offset === undefined ? {} : { offset: parsed.data.offset }),
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
  };
}

interface ResolvedComparisonSelection {
  snapshotIds: StableId[];
  snapshots: Array<{
    snapshotId: StableId;
    repositoryId: string;
    commitSha: string;
    sourceRef: string;
    contentHash: string;
  }>;
  fingerprint: string;
  reasons: IncidentComparisonReason[];
}

async function resolveComparisonSelection(
  graphStore: GraphStore,
  catalog: IncidentCatalog,
  incident: IncidentRecord,
  selector: ComparisonSelector,
): Promise<ResolvedComparisonSelection> {
  if (selector.kind === "scan") {
    return {
      ...emptySelection(),
      reasons: [{
        code: "SCAN_SELECTOR_UNAVAILABLE",
        message: `Scan ${selector.scanId} is not durably linked to a graph snapshot; use the completed scan's result.snapshot.id instead.`,
      }],
    };
  }

  const nodes = selector.kind === "snapshot"
    ? (await graphStore.getNodes([selector.snapshotId as StableId])).filter(
        (node) => node.label === "LockfileSnapshot",
      )
    : await graphStore.matchNodes({
        label: "LockfileSnapshot",
        equals: {
          repositoryId: selector.repositoryId,
          commitSha: selector.commitSha.toLowerCase(),
        },
        limit: 101,
      });
  const reasons: IncidentComparisonReason[] = [];
  if (nodes.length === 0) {
    reasons.push({
      code: "SNAPSHOT_NOT_FOUND",
      message: selector.kind === "snapshot"
        ? `Snapshot ${selector.snapshotId} is not present in the graph store.`
        : `No stored snapshot exactly matches ${selector.repositoryId}@${selector.commitSha}.`,
    });
  }
  if (nodes.length >= 101) {
    reasons.push({
      code: "SNAPSHOT_SELECTION_TRUNCATED",
      message: "The commit resolves to more than 100 snapshots; comparison refuses an incomplete selection.",
    });
  }

  const snapshotNodes = nodes
    .filter((node): node is GraphNodeRecord<"LockfileSnapshot"> => node.label === "LockfileSnapshot")
    .sort((left, right) => left.id.localeCompare(right.id));
  if (selector.kind === "commit") {
    const bySource = new Map<string, GraphNodeRecord<"LockfileSnapshot">[]>();
    for (const node of snapshotNodes) {
      const existing = bySource.get(node.properties.sourceRef) ?? [];
      bySource.set(node.properties.sourceRef, [...existing, node]);
    }
    for (const [sourceRef, candidates] of bySource) {
      if (candidates.length > 1) {
        reasons.push({
          code: "AMBIGUOUS_COMMIT_EVIDENCE",
          message: `${selector.repositoryId}@${selector.commitSha} has ${candidates.length} different snapshots for ${sourceRef}.`,
        });
      }
    }
  }

  const snapshotIds = snapshotNodes.map(({ id }) => id);
  for (const snapshotId of snapshotIds) {
    if (!(await ensureSnapshotCatalogHydrated(graphStore, catalog, snapshotId))) {
      reasons.push({
        code: "SNAPSHOT_HYDRATION_FAILED",
        message: `Snapshot ${snapshotId} could not be reconstructed from graph evidence.`,
      });
    }
  }
  const entries = snapshotIds
    .map((snapshotId) => catalog.entry(snapshotId))
    .filter((entry): entry is CatalogEntry => entry !== undefined);
  for (const entry of entries) {
    const snapshotId = entry.normalized.snapshot.id;
    if (entry.deployments.length === 0) {
      reasons.push({
        code: "DEPLOYMENT_EVIDENCE_MISSING",
        message: `Snapshot ${snapshotId} has no deployment manifest; service and environment exposure cannot be compared.`,
      });
    }
    const depth = pathDepthCompleteness(entry, incident);
    if (depth === "exceeded") {
      reasons.push({
        code: "PATH_DEPTH_TRUNCATED",
        message: `Snapshot ${snapshotId} contains an affected dependency path beyond HydraDB's depth-16 comparison limit.`,
      });
    } else if (depth === "complex") {
      reasons.push({
        code: "PATH_COMPLEXITY_LIMIT",
        message: `Snapshot ${snapshotId} exceeded the bounded completeness proof for dependency depth.`,
      });
    }
  }

  const snapshots = snapshotNodes.map((node) => ({
    snapshotId: node.id,
    repositoryId: node.properties.repositoryId,
    commitSha: node.properties.commitSha,
    sourceRef: node.properties.sourceRef,
    contentHash: node.properties.contentHash,
  }));
  const fingerprint = sha256Hex(canonicalJson(entries.map((entry) => ({
    snapshot: entry.normalized.snapshot,
    packages: entry.normalized.packages.map(({ id, name, version }) => ({ id, name, version })),
    resolutions: entry.normalized.resolutions.map(({ id, packageVersionId, sourceKey }) => ({ id, packageVersionId, sourceKey })),
    edges: entry.normalized.edges.map(({ id, fromResolutionId, toResolutionId, kind }) => ({ id, fromResolutionId, toResolutionId, kind })),
    deployments: entry.deployments,
    reachability: entry.normalized.packages.flatMap(({ name, version }) =>
      catalog.reachabilityFor(entry.normalized.snapshot.id, name, version)),
  }))));
  return { snapshotIds, snapshots, fingerprint, reasons: uniqueComparisonReasons(reasons) };
}

function pathDepthCompleteness(
  entry: CatalogEntry,
  incident: IncidentRecord,
): "complete" | "exceeded" | "complex" {
  const affectedVersionIds = new Set(entry.normalized.packages
    .filter(({ normalizedName, version }) =>
      normalizedName === incident.normalizedPackageName && incident.affectedVersions.includes(version))
    .map(({ id }) => id));
  const targets = new Set(entry.normalized.resolutions
    .filter(({ packageVersionId }) => affectedVersionIds.has(packageVersionId))
    .map(({ id }) => id));
  if (targets.size === 0) return "complete";
  const forward = new Map<StableId, StableId[]>();
  const reverse = new Map<StableId, StableId[]>();
  for (const edge of entry.normalized.edges) {
    forward.set(edge.fromResolutionId, [...(forward.get(edge.fromResolutionId) ?? []), edge.toResolutionId]);
    reverse.set(edge.toResolutionId, [...(reverse.get(edge.toResolutionId) ?? []), edge.fromResolutionId]);
  }
  const canReachTarget = new Set(targets);
  const reversePending = [...targets];
  while (reversePending.length > 0) {
    const current = reversePending.pop()!;
    for (const previous of reverse.get(current) ?? []) {
      if (canReachTarget.has(previous)) continue;
      canReachTarget.add(previous);
      reversePending.push(previous);
    }
  }
  const pending = entry.normalized.resolutions
    .filter(({ root, id }) => root && canReachTarget.has(id))
    .map(({ id }) => ({ id, path: new Set<StableId>([id]), depth: 0 }));
  let visitedStates = 0;
  while (pending.length > 0) {
    const state = pending.pop()!;
    visitedStates += 1;
    if (visitedStates > 100_000) return "complex";
    const next = (forward.get(state.id) ?? [])
      .filter((id) => canReachTarget.has(id) && !state.path.has(id));
    if (state.depth >= 16 && next.length > 0) return "exceeded";
    for (const id of next) {
      pending.push({ id, path: new Set([...state.path, id]), depth: state.depth + 1 });
    }
  }
  return "complete";
}

function publicSelection(selection: ResolvedComparisonSelection): Record<string, unknown> {
  return {
    snapshotIds: selection.snapshotIds,
    snapshots: selection.snapshots,
    selectionFingerprint: selection.fingerprint,
  };
}

function emptySelection(): ResolvedComparisonSelection {
  return { snapshotIds: [], snapshots: [], fingerprint: sha256Hex("[]"), reasons: [] };
}

function inconclusiveComparison(
  incidentId: StableId,
  baseline: ResolvedComparisonSelection,
  current: ResolvedComparisonSelection,
  reasons: readonly IncidentComparisonReason[],
): Record<string, unknown> {
  return {
    comparison: {
      status: "INCONCLUSIVE",
      incidentId,
      baseline: {
        evidenceFingerprint: baseline.fingerprint,
        totalFindings: 0,
        totalPaths: 0,
        blockingPaths: 0,
      },
      current: {
        evidenceFingerprint: current.fingerprint,
        totalFindings: 0,
        totalPaths: 0,
        blockingPaths: 0,
      },
      newBlockingPaths: [],
      reasons: uniqueComparisonReasons(reasons),
    } satisfies IncidentComparisonResult,
    baseline: publicSelection(baseline),
    current: publicSelection(current),
  };
}

function uniqueComparisonReasons(
  reasons: readonly IncidentComparisonReason[],
): IncidentComparisonReason[] {
  return [...new Map(reasons.map((reason) => [`${reason.code}\0${reason.message}`, reason])).values()]
    .sort((left, right) => left.code.localeCompare(right.code) || left.message.localeCompare(right.message));
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

function parsePathsQuery(value: unknown): {
  query: BlastRadiusQuery;
  pathOffset: number;
  pathLimit: number;
} | undefined {
  const parsed = pathsQuerySchema.safeParse(value);
  if (!parsed.success) return undefined;
  const query = parseBlastQuery(value);
  if (query === undefined) return undefined;
  const pathLimit = parsed.data.pathLimit ?? parsed.data.pathDisplayLimit ?? 20;
  if (
    (parsed.data.pathCountLimit ?? 10_000) < parsed.data.pathOffset + pathLimit
  ) return undefined;
  return {
    query: {
      ...query,
      pathOffset: parsed.data.pathOffset,
      pathDisplayLimit: pathLimit,
    },
    pathOffset: parsed.data.pathOffset,
    pathLimit,
  };
}

function pathPageMetadata(
  total: number,
  totalTruncated: boolean,
  offset: number,
  limit: number,
  returned: number,
) {
  const page = pageMetadata(total, offset, limit, returned);
  return {
    ...page,
    truncated: page.truncated || totalTruncated,
    totalIsExact: !totalTruncated,
  };
}
