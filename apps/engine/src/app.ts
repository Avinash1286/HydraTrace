import { FileResponseCache, OsvClient } from "@hydratrace/ecosystem-enrichment";
import {
  HydraDbGraphStore,
  InMemoryGraphStore,
  hydraDbConnectionOptionsFromEnv,
  type GraphStore,
} from "@hydratrace/hydradb-client";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { ingestLockfile } from "./services/ingestion.js";

const scanBodySchema = z.object({
  content: z.string().min(1).max(5_000_000),
  sourceRef: z.string().trim().min(1),
  repositoryId: z.string().trim().min(1),
  commitSha: z.string().trim().min(1),
  observedAt: z.number().int().nonnegative(),
  rootPackage: z
    .object({ name: z.string().trim().min(1), version: z.string().trim().min(1) })
    .optional(),
  deploymentManifest: z.string().min(1).max(100_000).optional(),
});

const osvBodySchema = z.object({
  packages: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        version: z.string().trim().min(1),
      }),
    )
    .min(1)
    .max(1_000),
});

export interface EngineDependencies {
  graphStore?: GraphStore;
  osvClient?: OsvClient;
}

export function buildEngine(dependencies: EngineDependencies = {}): FastifyInstance {
  const graphStore = dependencies.graphStore ?? new InMemoryGraphStore();
  const osvClient =
    dependencies.osvClient ??
    new OsvClient({
      cache: new FileResponseCache(".cache"),
      ...(process.env.OSV_BASE_URL === undefined
        ? {}
        : { baseUrl: process.env.OSV_BASE_URL }),
    });
  const application = Fastify({
    logger: false,
    bodyLimit: 5_500_000,
    requestTimeout: 30_000,
  });

  application.get("/health", async () => ({ status: "ok", service: "hydratrace-engine" }));
  application.get("/ready", async () => ({ status: "ready" }));

  application.post("/v1/scans/lockfile", async (request, reply) => {
    const parsed = scanBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_SCAN",
        issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
      });
    }
    let result;
    try {
      result = await ingestLockfile(graphStore, {
        content: parsed.data.content,
        ...(parsed.data.deploymentManifest === undefined
          ? {}
          : { deploymentManifest: parsed.data.deploymentManifest }),
        options: {
          sourceRef: parsed.data.sourceRef,
          repositoryId: parsed.data.repositoryId,
          commitSha: parsed.data.commitSha,
          observedAt: parsed.data.observedAt,
          ...(parsed.data.rootPackage === undefined
            ? {}
            : { rootPackage: parsed.data.rootPackage }),
        },
      });
    } catch (error) {
      return reply.code(400).send({
        error: "LOCKFILE_INGESTION_FAILED",
        message: error instanceof Error ? error.message : "Unknown ingestion error",
      });
    }
    return reply.code(201).send({
      snapshot: result.normalized.snapshot,
      deployment: result.deployment,
      counts: {
        packageVersions: result.normalized.packages.length,
        resolutions: result.normalized.resolutions.length,
        dependencyEdges: result.normalized.edges.length,
        warnings: result.normalized.warnings.length,
      },
      warnings: result.normalized.warnings,
      graphWrite: result.graphWrite,
    });
  });

  application.post("/v1/enrichment/osv", async (request, reply) => {
    const parsed = osvBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_OSV_QUERY" });
    }
    const results = await osvClient.queryExactPackages(
      parsed.data.packages.map(({ name, version }) => ({
        ecosystem: "npm",
        name,
        version,
      })),
    );
    return { results };
  });

  application.addHook("onClose", async () => {
    await graphStore.close();
  });
  return application;
}

export function graphStoreFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): GraphStore {
  return environment.HYDRADB_BOLT_URI === undefined
    ? new InMemoryGraphStore()
    : HydraDbGraphStore.connect(hydraDbConnectionOptionsFromEnv(environment));
}
