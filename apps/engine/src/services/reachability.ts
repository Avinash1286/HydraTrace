import type { StableId } from "@hydratrace/domain";
import type { IncidentCatalog } from "@hydratrace/incident-analysis";
import { analyzeStaticImports, type RuntimeTrace } from "@hydratrace/reachability";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const stableIdSchema = z.string().regex(/^\d+$/);
const staticBodySchema = z.object({
  snapshotId: stableIdSchema,
  repositoryId: z.string().trim().min(1).max(512),
  commitSha: z.string().trim().min(1).max(256),
  observedAt: z.number().int().nonnegative().optional(),
  entrypoints: z.array(z.string().trim().min(1).max(1_024)).min(1).max(100),
  files: z.array(z.object({
    path: z.string().trim().min(1).max(1_024),
    source: z.string().max(2_000_000),
  })).min(1).max(2_000),
}).strict();

const runtimeBodySchema = z.object({
  runId: z.string().trim().min(1).max(256),
  startedAt: z.number().int().nonnegative(),
  command: z.string().trim().min(1).max(2_048),
  kind: z.enum(["test", "runtime"]),
  snapshotId: stableIdSchema,
  deploymentId: stableIdSchema.optional(),
  packages: z.array(z.object({
    name: z.string().trim().min(1).max(214),
    version: z.string().trim().min(1).max(128),
    firstLoadedAt: z.number().int().nonnegative(),
    loadCount: z.number().int().positive().max(1_000_000),
  })).max(10_000),
}).strict();

const evidenceParametersSchema = z.object({
  snapshotId: stableIdSchema,
  packageName: z.string().trim().min(1),
  version: z.string().trim().min(1),
});

export function registerReachabilityRoutes(
  application: FastifyInstance,
  catalog: IncidentCatalog,
): void {
  application.post("/v1/reachability/static", async (request, reply) => {
    const parsed = staticBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_STATIC_ANALYSIS" });
    try {
      const analysis = analyzeStaticImports(parsed.data);
      const evidence = catalog.registerStaticAnalysis(
        parsed.data.snapshotId as StableId,
        analysis,
        parsed.data.observedAt ?? Date.now(),
      );
      return reply.code(201).send({ analysis, evidence });
    } catch (error) {
      return reply.code(400).send({
        error: "STATIC_ANALYSIS_FAILED",
        message: error instanceof Error ? error.message : "Unknown static analysis error",
      });
    }
  });

  application.post("/v1/reachability/runtime", async (request, reply) => {
    const parsed = runtimeBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_RUNTIME_TRACE" });
    try {
      const trace: RuntimeTrace = {
        runId: parsed.data.runId,
        startedAt: parsed.data.startedAt,
        command: parsed.data.command,
        kind: parsed.data.kind,
        snapshotId: parsed.data.snapshotId as StableId,
        packages: parsed.data.packages,
        ...(parsed.data.deploymentId === undefined
          ? {}
          : { deploymentId: parsed.data.deploymentId as StableId }),
      };
      const evidence = catalog.registerRuntimeTrace(trace);
      return reply.code(201).send({ accepted: evidence.length, evidence });
    } catch (error) {
      return reply.code(400).send({
        error: "RUNTIME_TRACE_FAILED",
        message: error instanceof Error ? error.message : "Unknown runtime trace error",
      });
    }
  });

  application.get(
    "/v1/snapshots/:snapshotId/packages/:packageName/:version/reachability",
    async (request, reply) => {
      const parsed = evidenceParametersSchema.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: "INVALID_REACHABILITY_QUERY" });
      const evidence = catalog.reachabilityFor(
        parsed.data.snapshotId as StableId,
        parsed.data.packageName,
        parsed.data.version,
      );
      return {
        snapshotId: parsed.data.snapshotId,
        packageName: parsed.data.packageName,
        version: parsed.data.version,
        level: evidence[0]?.level ?? 1,
        evidence,
      };
    },
  );
}
