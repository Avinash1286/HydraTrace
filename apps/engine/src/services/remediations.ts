import {
  stableIdFromCanonicalKey,
  type StableId,
} from "@hydratrace/domain";
import type { GraphStore } from "@hydratrace/hydradb-client";
import {
  analyzeBlastRadius,
  type IncidentCatalog,
} from "@hydratrace/incident-analysis";
import {
  remediationCandidate,
  solveRemediation,
  type RemediationCandidate,
  type RemediationSolution,
} from "@hydratrace/remediation";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const stableIdSchema = z.string().regex(/^\d+$/);
const candidateSchema = z.object({
  dependencyName: z.string().trim().min(1).max(214),
  fromVersion: z.string().trim().min(1).max(128),
  toVersion: z.string().trim().min(1).max(128),
  semverImpact: z.enum(["patch", "minor", "major", "unknown"]),
  eliminatedPathIds: z.array(stableIdSchema).max(10_000),
  affectedServices: z.array(z.string().trim().min(1).max(256)).max(1_000),
  lockfileChurn: z.number().int().nonnegative().max(1_000_000).default(0),
  deprecated: z.boolean().default(false),
  knownVulnerable: z.boolean().default(false),
  verification: z.enum(["PROPOSED", "LOCKFILE_VERIFIED", "BUILD_VERIFIED", "TEST_VERIFIED"]).default("PROPOSED"),
  evidenceRefs: z.array(z.string().trim().min(1).max(512)).max(10_000).default([]),
}).strict();

const createSchema = z.object({ candidates: z.array(candidateSchema).min(1).max(100) }).strict();
const runParameters = z.object({ runId: stableIdSchema });
const incidentParameters = z.object({ incidentId: stableIdSchema });
const verifySchema = z.object({ snapshotId: stableIdSchema }).strict();

interface RemediationRun {
  runId: StableId;
  incidentId: StableId;
  createdAt: number;
  beforePathIds: readonly StableId[];
  solution: RemediationSolution;
  status: "PROPOSED" | "VERIFIED" | "INCONCLUSIVE" | "FAILED";
  verification: {
    level: "NOT_RUN" | "STRONG_GRAPH" | "REFERENCE_GRAPH";
    snapshotId?: StableId;
    remainingPathCount?: number;
    passed: boolean;
    message: string;
  };
}

export function registerRemediationRoutes(
  application: FastifyInstance,
  catalog: IncidentCatalog,
  graphStore: GraphStore,
  strongGraphReads: boolean,
): void {
  const runs = new Map<StableId, RemediationRun>();

  application.post("/v1/incidents/:incidentId/remediations", async (request, reply) => {
    const parameters = incidentParameters.safeParse(request.params);
    const parsed = createSchema.safeParse(request.body);
    if (!parameters.success || !parsed.success) return reply.code(400).send({ error: "INVALID_REMEDIATION" });
    const incidentId = parameters.data.incidentId as StableId;
    if (catalog.getIncident(incidentId) === undefined) return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
    const blast = analyzeBlastRadius(catalog, incidentId, { includeDevelopment: true, pathDisplayLimit: 100, pathCountLimit: 10_000, limit: 100 });
    if (blast.pathsTruncated) return reply.code(409).send({ error: "PATH_SET_TRUNCATED", message: "Remediation cannot solve an incomplete path set" });
    const beforePathIds = [...new Set(blast.findings.flatMap(({ displayedPaths }) => displayedPaths.map(({ pathId }) => pathId)))].sort();
    const candidates = parsed.data.candidates.map(toCandidate);
    const solution = solveRemediation(beforePathIds, candidates);
    const createdAt = Date.now();
    const runId = stableIdFromCanonicalKey(`remediation-run:${incidentId}:${createdAt}:${candidates.map(({ candidateId }) => candidateId).join(",")}`);
    const run: RemediationRun = {
      runId,
      incidentId,
      createdAt,
      beforePathIds,
      solution,
      status: "PROPOSED",
      verification: { level: "NOT_RUN", passed: false, message: "Strong graph verification has not run." },
    };
    runs.set(runId, structuredClone(run));
    return reply.code(201).send(run);
  });

  application.get("/v1/remediations/:runId", async (request, reply) => {
    const parsed = runParameters.safeParse(request.params); if (!parsed.success) return reply.code(400).send({ error: "INVALID_RUN_ID" });
    const run = runs.get(parsed.data.runId as StableId); return run === undefined ? reply.code(404).send({ error: "REMEDIATION_NOT_FOUND" }) : structuredClone(run);
  });

  application.get("/v1/remediations/:runId/diff", async (request, reply) => {
    const parsed = runParameters.safeParse(request.params); if (!parsed.success) return reply.code(400).send({ error: "INVALID_RUN_ID" });
    const run = runs.get(parsed.data.runId as StableId); if (run === undefined) return reply.code(404).send({ error: "REMEDIATION_NOT_FOUND" });
    return { runId: run.runId, before: { affectedPaths: run.beforePathIds.length }, after: { affectedPaths: run.verification.remainingPathCount ?? null }, eliminatedPaths: run.solution.coveredPathIds.length, uncoveredPaths: run.solution.uncoveredPathIds, changes: run.solution.candidates.map(({ candidate }) => ({ dependencyName: candidate.dependencyName, fromVersion: candidate.fromVersion, toVersion: candidate.toVersion, semverImpact: candidate.semverImpact, verification: candidate.verification })) };
  });

  application.post("/v1/remediations/:runId/verify", async (request, reply) => {
    const parameters = runParameters.safeParse(request.params); const parsed = verifySchema.safeParse(request.body);
    if (!parameters.success || !parsed.success) return reply.code(400).send({ error: "INVALID_VERIFICATION" });
    const runId = parameters.data.runId as StableId; const run = runs.get(runId); if (run === undefined) return reply.code(404).send({ error: "REMEDIATION_NOT_FOUND" });
    try {
      const remainingPathCount = await countStrongGraphPaths(graphStore, catalog, run.incidentId, parsed.data.snapshotId as StableId);
      const passed = strongGraphReads && remainingPathCount === 0;
      const verification: RemediationRun["verification"] = {
        level: strongGraphReads ? "STRONG_GRAPH" : "REFERENCE_GRAPH",
        snapshotId: parsed.data.snapshotId as StableId,
        remainingPathCount,
        passed,
        message: passed ? "Strong-consistency graph query returned zero affected paths." : remainingPathCount > 0 ? `Verification found ${remainingPathCount} affected path(s).` : "Zero paths were found, but the store is not configured for strong consistency; verification remains inconclusive.",
      };
      const updated: RemediationRun = { ...run, status: passed ? "VERIFIED" : remainingPathCount > 0 ? "FAILED" : "INCONCLUSIVE", verification };
      runs.set(runId, structuredClone(updated)); return updated;
    } catch (error) { return reply.code(400).send({ error: "VERIFICATION_FAILED", message: error instanceof Error ? error.message : "Unknown verification error" }); }
  });
}

function toCandidate(input: z.infer<typeof candidateSchema>): RemediationCandidate {
  return remediationCandidate({ dependencyName: input.dependencyName, fromVersion: input.fromVersion, toVersion: input.toVersion, semverImpact: input.semverImpact, eliminatedPathIds: input.eliminatedPathIds as StableId[], affectedServices: input.affectedServices, lockfileChurn: input.lockfileChurn, deprecated: input.deprecated, knownVulnerable: input.knownVulnerable, verification: input.verification, evidenceRefs: input.evidenceRefs });
}

async function countStrongGraphPaths(store: GraphStore, catalog: IncidentCatalog, incidentId: StableId, snapshotId: StableId): Promise<number> {
  const incident = catalog.getIncident(incidentId); if (incident === undefined) throw new Error("Incident was not found");
  const entry = catalog.entry(snapshotId); if (entry === undefined) throw new Error("Verification snapshot was not found");
  const snapshotNode = await store.getNodes([snapshotId]); if (snapshotNode.length !== 1) throw new Error("Verification snapshot is not present in the graph store");
  const affectedVersionIds = new Set(entry.normalized.packages.filter(({ normalizedName, version }) => normalizedName === incident.normalizedPackageName && incident.affectedVersions.includes(version)).map(({ id }) => id));
  const targets = entry.normalized.resolutions.filter(({ packageVersionId }) => affectedVersionIds.has(packageVersionId));
  const roots = entry.normalized.resolutions.filter(({ root }) => root); let count = 0;
  for (const root of roots) for (const target of targets) count += (await store.findPaths({ from: { label: "Resolution", id: root.id }, to: { label: "Resolution", id: target.id }, relationshipType: "DEPENDS_ON_INSTANCE", direction: "out", minDepth: 0, maxDepth: 16, limit: 10_000 })).length;
  return count;
}
