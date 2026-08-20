import {
  normalizeNpmPackageName,
  stableIdFromCanonicalKey,
  type StableId,
} from "@hydratrace/domain";
import type { GraphStore } from "@hydratrace/hydradb-client";
import type { GraphNodeRecord } from "@hydratrace/graph-schema";
import {
  type IncidentCatalog,
} from "@hydratrace/incident-analysis";
import {
  remediationCandidate,
  solveRemediation,
  type RemediationCandidate,
  type RemediationSolution,
  simulateNpmLockfile,
} from "@hydratrace/remediation";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { analyzeBlastRadiusFromGraphStore } from "./graph-catalog.js";
import {
  discoverBuiltInDemoRemediationCandidates,
  discoverRemediationCandidates,
  type RemediationCandidateDiscoveryDependencies,
} from "./remediation-candidates.js";

const stableIdSchema = z.string().regex(/^\d+$/);
const candidateSchema = z.object({
  candidateId: stableIdSchema.optional(),
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

const createSchema = z.object({ candidates: z.array(candidateSchema).min(1).max(100).optional() }).strict();
const discoverySchema = z.object({
  artifacts: z.array(z.object({
    snapshotId: stableIdSchema,
    packageJson: z.string().min(1).max(1_000_000),
    packageLock: z.string().min(1).max(5_000_000),
    repositoryId: z.string().trim().min(1).max(512),
    commitSha: z.string().trim().min(1).max(256),
  }).strict()).min(1).max(25),
  requestedVersions: z.record(z.string().trim().min(1).max(214), z.array(z.string().trim().min(1).max(128)).min(1).max(10)).optional(),
  maxVersionsPerDependency: z.number().int().min(1).max(10).optional(),
  maxSimulations: z.number().int().min(1).max(25).optional(),
  simulationTimeoutMs: z.number().int().min(1_000).max(60_000).optional(),
}).strict();
const runParameters = z.object({ runId: stableIdSchema });
const incidentParameters = z.object({ incidentId: stableIdSchema });
const verifySchema = z.object({
  snapshotId: stableIdSchema.optional(),
  snapshotIds: z.array(stableIdSchema).min(1).max(100).optional(),
}).strict().superRefine((value, context) => {
  if (value.snapshotId === undefined && value.snapshotIds === undefined) {
    context.addIssue({ code: "custom", message: "At least one verification snapshot is required" });
  }
});
const simulationSchema = z.object({
  packageJson: z.string().min(1).max(1_000_000),
  packageLock: z.string().min(1).max(5_000_000),
  dependencyName: z.string().trim().min(1).max(214),
  toVersion: z.string().trim().min(1).max(128),
  affectedPackageName: z.string().trim().min(1).max(214),
  affectedVersions: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
  repositoryId: z.string().trim().min(1).max(512),
  commitSha: z.string().trim().min(1).max(256),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
}).strict();

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
    snapshotIds?: readonly StableId[];
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
  discoveryDependencies?: RemediationCandidateDiscoveryDependencies,
): void {
  const runs = new Map<StableId, RemediationRun>();
  const discoveredCandidates = new Map<StableId, Map<StableId, RemediationCandidate>>();

  application.get("/v1/incidents/:incidentId/remediations/candidates", async (request, reply) => {
    const parameters = incidentParameters.safeParse(request.params);
    if (!parameters.success) return reply.code(400).send({ error: "INVALID_INCIDENT_ID" });
    const incidentId = parameters.data.incidentId as StableId;
    const incident = catalog.getIncident(incidentId);
    if (incident === undefined) return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
    const blast = await completeBlast(graphStore, catalog, incidentId);
    if (blast.pathsTruncated) return reply.code(409).send({ error: "PATH_SET_TRUNCATED" });
    const cachedDemo = discoverBuiltInDemoRemediationCandidates(blast, incident);
    if (cachedDemo !== undefined) {
      const stored = discoveredCandidates.get(incidentId) ?? new Map<StableId, RemediationCandidate>();
      for (const candidate of cachedDemo.candidates) stored.set(candidate.candidateId, structuredClone(candidate));
      discoveredCandidates.set(incidentId, stored);
      return { incidentId, ...cachedDemo };
    }
    return {
      incidentId,
      state: "INCONCLUSIVE",
      complete: false,
      candidates: [],
      evidence: [],
      rejections: [{
        reason: "SOURCE_ARTIFACT_UNAVAILABLE",
        message: "POST the exact package.json and package-lock.json artifacts to this endpoint before requesting an automatic recommendation.",
      }],
      providerErrors: [],
      simulationsAttempted: 0,
    };
  });

  application.post("/v1/incidents/:incidentId/remediations/candidates", async (request, reply) => {
    const parameters = incidentParameters.safeParse(request.params);
    const parsed = discoverySchema.safeParse(request.body);
    if (!parameters.success || !parsed.success) {
      return reply.code(400).send({ error: "INVALID_CANDIDATE_DISCOVERY" });
    }
    const incidentId = parameters.data.incidentId as StableId;
    const incident = catalog.getIncident(incidentId);
    if (incident === undefined) return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
    const blast = await completeBlast(graphStore, catalog, incidentId);
    if (blast.pathsTruncated) return reply.code(409).send({ error: "PATH_SET_TRUNCATED" });
    if (discoveryDependencies === undefined) {
      return {
        incidentId,
        state: "INCONCLUSIVE",
        complete: false,
        candidates: [],
        evidence: [],
        rejections: [],
        providerErrors: [{ provider: "npm-registry", message: "Remediation discovery providers are not configured." }],
        simulationsAttempted: 0,
      };
    }
    if (
      typeof process.getuid === "function" &&
      process.getuid() === 0 &&
      discoveryDependencies.allowRootSimulation !== true
    ) {
      return {
        incidentId,
        state: "INCONCLUSIVE",
        complete: false,
        candidates: [],
        evidence: [],
        rejections: [],
        providerErrors: [{
          provider: "lockfile-simulation",
          message: "Lockfile simulations must run as a non-root user.",
        }],
        simulationsAttempted: 0,
      };
    }
    const result = await discoverRemediationCandidates(
      blast,
      incident,
      parsed.data.artifacts.map((artifact) => ({
        ...artifact,
        snapshotId: artifact.snapshotId as StableId,
      })),
      discoveryDependencies,
      {
        ...(parsed.data.requestedVersions === undefined ? {} : { requestedVersions: parsed.data.requestedVersions }),
        ...(parsed.data.maxVersionsPerDependency === undefined ? {} : { maxVersionsPerDependency: parsed.data.maxVersionsPerDependency }),
        ...(parsed.data.maxSimulations === undefined ? {} : { maxSimulations: parsed.data.maxSimulations }),
        ...(parsed.data.simulationTimeoutMs === undefined ? {} : { simulationTimeoutMs: parsed.data.simulationTimeoutMs }),
      },
    );
    const stored = discoveredCandidates.get(incidentId) ?? new Map<StableId, RemediationCandidate>();
    for (const candidate of result.candidates) stored.set(candidate.candidateId, structuredClone(candidate));
    discoveredCandidates.set(incidentId, stored);
    return { incidentId, ...result };
  });

  application.post("/v1/remediations/simulate", async (request, reply) => {
    const parsed = simulationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SIMULATION" });
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      return reply.code(503).send({ error: "ROOT_SIMULATION_FORBIDDEN", message: "Lockfile simulations must run as a non-root user" });
    }
    try {
      return await simulateNpmLockfile({
        packageJson: parsed.data.packageJson,
        packageLock: parsed.data.packageLock,
        dependencyName: parsed.data.dependencyName,
        toVersion: parsed.data.toVersion,
        affectedPackageName: parsed.data.affectedPackageName,
        affectedVersions: parsed.data.affectedVersions,
        repositoryId: parsed.data.repositoryId,
        commitSha: parsed.data.commitSha,
        ...(parsed.data.timeoutMs === undefined ? {} : { timeoutMs: parsed.data.timeoutMs }),
      });
    } catch (error) {
      return reply.code(400).send({ error: "SIMULATION_FAILED", message: error instanceof Error ? error.message : "Unknown simulation error" });
    }
  });

  application.post("/v1/incidents/:incidentId/remediations", async (request, reply) => {
    const parameters = incidentParameters.safeParse(request.params);
    const parsed = createSchema.safeParse(request.body);
    if (!parameters.success || !parsed.success) return reply.code(400).send({ error: "INVALID_REMEDIATION" });
    const incidentId = parameters.data.incidentId as StableId;
    if (catalog.getIncident(incidentId) === undefined) return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
    const blast = await completeBlast(graphStore, catalog, incidentId);
    if (blast.pathsTruncated) return reply.code(409).send({ error: "PATH_SET_TRUNCATED", message: "Remediation cannot solve an incomplete path set" });
    const beforePathIds = [...new Set(blast.findings.flatMap(({ displayedPaths }) => displayedPaths.map(({ pathId }) => pathId)))].sort();
    const safeCandidates = discoveredCandidates.get(incidentId) ?? new Map<StableId, RemediationCandidate>();
    const candidates = parsed.data.candidates === undefined
      ? [...safeCandidates.values()].map((candidate) => structuredClone(candidate))
      : parsed.data.candidates.map((input) => {
          const stored = input.candidateId === undefined
            ? undefined
            : safeCandidates.get(input.candidateId as StableId);
          return stored === undefined ? toUnverifiedCandidate(input) : structuredClone(stored);
        });
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
    await graphStore.write({
      nodes: [runNode(run)],
      relationships: [],
    });
    runs.set(runId, structuredClone(run));
    return reply.code(201).send(run);
  });

  application.get("/v1/remediations/:runId", async (request, reply) => {
    const parsed = runParameters.safeParse(request.params); if (!parsed.success) return reply.code(400).send({ error: "INVALID_RUN_ID" });
    const run = await getRun(graphStore, runs, parsed.data.runId as StableId); return run === undefined ? reply.code(404).send({ error: "REMEDIATION_NOT_FOUND" }) : structuredClone(run);
  });

  application.get("/v1/remediations/:runId/diff", async (request, reply) => {
    const parsed = runParameters.safeParse(request.params); if (!parsed.success) return reply.code(400).send({ error: "INVALID_RUN_ID" });
    const run = await getRun(graphStore, runs, parsed.data.runId as StableId); if (run === undefined) return reply.code(404).send({ error: "REMEDIATION_NOT_FOUND" });
    return { runId: run.runId, before: { affectedPaths: run.beforePathIds.length }, after: { affectedPaths: run.verification.remainingPathCount ?? null }, eliminatedPaths: run.solution.coveredPathIds.length, uncoveredPaths: run.solution.uncoveredPathIds, changes: run.solution.candidates.map(({ candidate }) => ({ dependencyName: candidate.dependencyName, fromVersion: candidate.fromVersion, toVersion: candidate.toVersion, semverImpact: candidate.semverImpact, verification: candidate.verification })) };
  });

  application.post("/v1/remediations/:runId/verify", async (request, reply) => {
    const parameters = runParameters.safeParse(request.params); const parsed = verifySchema.safeParse(request.body);
    if (!parameters.success || !parsed.success) return reply.code(400).send({ error: "INVALID_VERIFICATION" });
    const runId = parameters.data.runId as StableId; const run = await getRun(graphStore, runs, runId); if (run === undefined) return reply.code(404).send({ error: "REMEDIATION_NOT_FOUND" });
    try {
      const snapshotIds = [...new Set((parsed.data.snapshotIds ?? (parsed.data.snapshotId === undefined ? [] : [parsed.data.snapshotId])) as StableId[])];
      const coveredDeployments = new Set<string>();
      const coveredChanges = new Set<string>();
      let remainingPathCount = 0;
      for (const snapshotId of snapshotIds) {
        const entry = catalog.entry(snapshotId);
        if (entry === undefined) throw new Error(`Verification snapshot ${snapshotId} was not found`);
        const inspection = await inspectStrongGraphSnapshot(graphStore, catalog, run.incidentId, snapshotId);
        for (const deployment of entry.deployments) {
          if (deployment.endedAt === null) {
            const key = deploymentKey(
              entry.normalized.snapshot.repositoryId,
              deployment.serviceId,
              deployment.environment,
            );
            coveredDeployments.add(key);
            for (const resolution of inspection.directResolutions) {
              coveredChanges.add(changeKey(key, resolution.packageName, resolution.version));
            }
          }
        }
        remainingPathCount += inspection.pathCount;
      }
      const coveredPathIds = new Set(run.solution.coveredPathIds);
      const originalBlast = await completeBlast(graphStore, catalog, run.incidentId);
      if (originalBlast.pathsTruncated) {
        throw new Error("Original incident paths are truncated; refusing incomplete verification coverage");
      }
      const requiredDeployments = new Set(originalBlast.findings
        .filter(({ displayedPaths }) => displayedPaths.some(({ pathId }) => coveredPathIds.has(pathId)))
        .map(({ repositoryId, serviceId, environment }) => deploymentKey(repositoryId, serviceId, environment)));
      if (run.solution.candidates.length > 0 && requiredDeployments.size === 0) {
        throw new Error("Original incident deployment evidence is unavailable for verification");
      }
      const requiredChanges = new Set<string>();
      for (const { candidate } of run.solution.candidates) {
        const candidatePaths = new Set(candidate.eliminatedPathIds);
        for (const finding of originalBlast.findings) {
          if (!finding.displayedPaths.some(({ pathId }) => candidatePaths.has(pathId))) continue;
          requiredChanges.add(changeKey(
            deploymentKey(finding.repositoryId, finding.serviceId, finding.environment),
            candidate.dependencyName,
            candidate.toVersion,
          ));
        }
      }
      const missingDeployments = [...requiredDeployments].filter((deployment) => !coveredDeployments.has(deployment));
      const missingChanges = [...requiredChanges].filter((change) => !coveredChanges.has(change));
      const completePlan = run.solution.candidates.length > 0 && run.solution.uncoveredPathIds.length === 0;
      const passed = strongGraphReads && completePlan && remainingPathCount === 0 && missingDeployments.length === 0 && missingChanges.length === 0;
      const verification: RemediationRun["verification"] = {
        level: strongGraphReads ? "STRONG_GRAPH" : "REFERENCE_GRAPH",
        ...(snapshotIds.length === 1 ? { snapshotId: snapshotIds[0]! } : {}),
        snapshotIds,
        remainingPathCount,
        passed,
        message: passed
          ? "Strong-consistency graph queries returned zero affected paths for every covered service."
          : !completePlan
            ? "Strong verification cannot pass because the recommendation contains no fully simulated plan covering every incident path."
            : missingDeployments.length > 0
            ? `Verification is missing active fixed snapshots for: ${missingDeployments.map(displayDeploymentKey).join(", ")}.`
            : missingChanges.length > 0
              ? `Fixed snapshots do not contain the recommended direct upgrades: ${missingChanges.map(displayChangeKey).join(", ")}.`
            : remainingPathCount > 0
              ? `Verification found ${remainingPathCount} affected path(s).`
              : "Zero paths were found, but the store is not configured for strong consistency; verification remains inconclusive.",
      };
      const updated: RemediationRun = { ...run, status: passed ? "VERIFIED" : remainingPathCount > 0 ? "FAILED" : "INCONCLUSIVE", verification };
      const existingVerifications = await graphStore.matchNodes({
        label: "RemediationVerification",
        equals: { runId },
        limit: 100,
      });
      const verifiedAt = Math.max(
        Date.now(),
        ...existingVerifications
          .filter((candidate): candidate is GraphNodeRecord<"RemediationVerification"> =>
            candidate.label === "RemediationVerification")
          .map((candidate) => candidate.properties.createdAt + 1),
      );
      await graphStore.write({
        nodes: [verificationNode(updated, verifiedAt)],
        relationships: [],
      });
      runs.set(runId, structuredClone(updated)); return updated;
    } catch (error) { return reply.code(400).send({ error: "VERIFICATION_FAILED", message: error instanceof Error ? error.message : "Unknown verification error" }); }
  });
}

function runNode(run: RemediationRun): GraphNodeRecord<"RemediationRun"> {
  return {
    id: run.runId,
    label: "RemediationRun",
    properties: {
      incidentId: run.incidentId,
      createdAt: run.createdAt,
      beforePathIdsJson: JSON.stringify(run.beforePathIds),
      solutionJson: JSON.stringify(run.solution),
      status: "PROPOSED",
    },
  };
}

function verificationNode(
  run: RemediationRun,
  verifiedAt: number,
): GraphNodeRecord<"RemediationVerification"> {
  const snapshotIds = run.verification.snapshotIds ?? (
    run.verification.snapshotId === undefined ? [] : [run.verification.snapshotId]
  );
  return {
    id: stableIdFromCanonicalKey(
      `remediation-verification:${run.runId}:${run.status}:${snapshotIds.join(",")}:${run.verification.remainingPathCount ?? ""}`,
    ),
    label: "RemediationVerification",
    properties: {
      runId: run.runId,
      createdAt: verifiedAt,
      level: run.verification.level,
      snapshotIdsJson: JSON.stringify(snapshotIds),
      remainingPathCount: run.verification.remainingPathCount ?? -1,
      passed: run.verification.passed,
      message: run.verification.message,
      status: run.status,
    },
  };
}

async function getRun(
  store: GraphStore,
  cache: Map<StableId, RemediationRun>,
  runId: StableId,
): Promise<RemediationRun | undefined> {
  const cached = cache.get(runId);
  if (cached !== undefined) return structuredClone(cached);
  const node = (await store.getNodes([runId])).find(
    (candidate): candidate is GraphNodeRecord<"RemediationRun"> => candidate.label === "RemediationRun",
  );
  if (node === undefined) return undefined;
  const run: RemediationRun = {
    runId,
    incidentId: node.properties.incidentId,
    createdAt: node.properties.createdAt,
    beforePathIds: JSON.parse(node.properties.beforePathIdsJson) as StableId[],
    solution: JSON.parse(node.properties.solutionJson) as RemediationSolution,
    status: "PROPOSED",
    verification: {
      level: "NOT_RUN",
      passed: false,
      message: "Strong graph verification has not run.",
    },
  };
  const verification = (await store.matchNodes({
    label: "RemediationVerification",
    equals: { runId },
    limit: 100,
  }))
    .filter((candidate): candidate is GraphNodeRecord<"RemediationVerification"> =>
      candidate.label === "RemediationVerification")
    .sort((left, right) => right.properties.createdAt - left.properties.createdAt)[0];
  if (verification !== undefined) {
    const snapshotIds = JSON.parse(verification.properties.snapshotIdsJson) as StableId[];
    run.status = verification.properties.status as RemediationRun["status"];
    run.verification = {
      level: verification.properties.level as RemediationRun["verification"]["level"],
      snapshotIds,
      ...(snapshotIds.length === 1 ? { snapshotId: snapshotIds[0]! } : {}),
      ...(verification.properties.remainingPathCount < 0
        ? {}
        : { remainingPathCount: verification.properties.remainingPathCount }),
      passed: verification.properties.passed,
      message: verification.properties.message,
    };
  }
  cache.set(runId, structuredClone(run));
  return run;
}

function completeBlast(graphStore: GraphStore, catalog: IncidentCatalog, incidentId: StableId) {
  return analyzeBlastRadiusFromGraphStore(graphStore, catalog, incidentId, {
    includeDevelopment: false,
    pathDisplayLimit: 100,
    pathCountLimit: 10_000,
    limit: 100,
  });
}

function toUnverifiedCandidate(input: z.infer<typeof candidateSchema>): RemediationCandidate {
  return remediationCandidate({ dependencyName: input.dependencyName, fromVersion: input.fromVersion, toVersion: input.toVersion, semverImpact: input.semverImpact, eliminatedPathIds: input.eliminatedPathIds as StableId[], affectedServices: input.affectedServices, lockfileChurn: input.lockfileChurn, deprecated: input.deprecated, knownVulnerable: input.knownVulnerable, verification: "PROPOSED", evidenceRefs: input.evidenceRefs });
}

function deploymentKey(repositoryId: string, serviceId: string, environment: string): string {
  return `${repositoryId}\0${serviceId}\0${environment}`;
}

function displayDeploymentKey(key: string): string {
  return key.split("\0").join("/");
}

function changeKey(deployment: string, dependencyName: string, version: string): string {
  return `${deployment}\0${normalizeNpmPackageName(dependencyName)}\0${version}`;
}

function displayChangeKey(key: string): string {
  const parts = key.split("\0");
  return `${parts.slice(0, 3).join("/")}:${parts[3] ?? "unknown"}@${parts[4] ?? "unknown"}`;
}

async function inspectStrongGraphSnapshot(store: GraphStore, catalog: IncidentCatalog, incidentId: StableId, snapshotId: StableId): Promise<{
  pathCount: number;
  directResolutions: Array<{ packageName: string; version: string }>;
}> {
  const incident = catalog.getIncident(incidentId); if (incident === undefined) throw new Error("Incident was not found");
  const entry = catalog.entry(snapshotId); if (entry === undefined) throw new Error("Verification snapshot was not found");
  const snapshotNode = (await store.getNodes([snapshotId])).find(
    (node): node is GraphNodeRecord<"LockfileSnapshot"> => node.label === "LockfileSnapshot",
  );
  if (snapshotNode === undefined) throw new Error("Verification snapshot is not present in the graph store");
  const contains = await store.matchRelationships({
    type: "CONTAINS",
    from: { id: snapshotId, label: "LockfileSnapshot" },
    limit: 10_000,
  });
  if (contains.length >= 10_000) {
    throw new Error("Verification snapshot reached the 10000-resolution query cap; refusing an incomplete zero-path result");
  }
  const resolutionIds = [...new Set(contains.map(({ to }) => to.id))];
  const resolutions = (await store.getNodes(resolutionIds)).filter(
    (node): node is GraphNodeRecord<"Resolution"> => node.label === "Resolution",
  );
  if (resolutions.length !== resolutionIds.length) {
    throw new Error("Verification snapshot contains missing or mislabeled resolution nodes");
  }
  const targets = resolutions.filter(({ properties }) =>
    normalizeNpmPackageName(properties.packageName) === incident.normalizedPackageName &&
    incident.affectedVersions.includes(properties.version));
  const roots = resolutions.filter(({ properties }) => properties.root);
  if (roots.length === 0) {
    throw new Error("Verification snapshot has no graph root resolution");
  }
  let count = 0;
  for (const root of roots) {
    for (const target of targets) {
      const paths = await store.findPaths({
        from: { label: "Resolution", id: root.id },
        to: { label: "Resolution", id: target.id },
        relationshipType: "DEPENDS_ON_INSTANCE",
        direction: "out",
        minDepth: 0,
        maxDepth: 16,
        limit: 10_000,
      });
      if (paths.length >= 10_000) {
        throw new Error("Strong verification reached the 10000-path cap; refusing an incomplete result");
      }
      count += paths.length;
    }
  }
  return {
    pathCount: count,
    directResolutions: resolutions
      .filter(({ properties }) => properties.direct)
      .map(({ properties }) => ({ packageName: properties.packageName, version: properties.version })),
  };
}
