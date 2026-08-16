import {
  FileResponseCache,
  MemoryResponseCache,
  DepsDevClient,
  NpmRegistryClient,
  OsvClient,
} from "@hydratrace/ecosystem-enrichment";
import {
  HydraDbGraphStore,
  InMemoryGraphStore,
  hydraDbConnectionOptionsFromEnv,
  type GraphStore,
} from "@hydratrace/hydradb-client";
import { IncidentCatalog } from "@hydratrace/incident-analysis";
import { PackageIntelligenceCatalog } from "@hydratrace/package-intelligence";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { ingestLockfile } from "./services/ingestion.js";
import { registerIncidentRoutes } from "./services/incidents.js";
import { registerReachabilityRoutes } from "./services/reachability.js";
import { registerPackageIntelligenceRoutes } from "./services/package-intelligence.js";
import { registerRemediationRoutes } from "./services/remediations.js";
import { registerScanWorkflowRoutes } from "./services/scans.js";
import { registerAiRoutes } from "./services/ai.js";

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
  npmRegistryClient?: NpmRegistryClient;
  depsDevClient?: DepsDevClient;
  incidentCatalog?: IncidentCatalog;
  packageIntelligenceCatalog?: PackageIntelligenceCatalog;
  strongGraphReads?: boolean;
  convexUrl?: string;
}

export function buildEngine(dependencies: EngineDependencies = {}): FastifyInstance {
  const graphStore = dependencies.graphStore ?? new InMemoryGraphStore();
  const incidentCatalog = dependencies.incidentCatalog ?? new IncidentCatalog();
  const packageIntelligenceCatalog =
    dependencies.packageIntelligenceCatalog ?? new PackageIntelligenceCatalog();
  const responseCache =
    process.env.VERCEL === "1"
      ? new MemoryResponseCache()
      : new FileResponseCache(".cache");
  const osvClient =
    dependencies.osvClient ??
    new OsvClient({
      cache: responseCache,
      ...(process.env.OSV_BASE_URL === undefined
        ? {}
        : { baseUrl: process.env.OSV_BASE_URL }),
    });
  const npmRegistryClient =
    dependencies.npmRegistryClient ?? new NpmRegistryClient({ cache: responseCache });
  const depsDevClient =
    dependencies.depsDevClient ?? new DepsDevClient({ cache: responseCache });
  const application = Fastify({
    logger: false,
    bodyLimit: 5_500_000,
    requestTimeout: 30_000,
  });
  const allowedOrigins = (process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000,http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  void application.register(cors, {
    origin: allowedOrigins,
    methods: ["GET", "POST", "OPTIONS"],
  });
  const rateLimitMax = Number(process.env.ENGINE_RATE_LIMIT_PER_MINUTE ?? "120");
  if (!Number.isInteger(rateLimitMax) || rateLimitMax < 1) {
    throw new Error("ENGINE_RATE_LIMIT_PER_MINUTE must be a positive integer");
  }
  void application.register(rateLimit, {
    max: rateLimitMax,
    timeWindow: "1 minute",
  });

  application.get("/", async () => ({
    service: "HydraTrace Engine",
    version: "0.1.0",
    status: "ok",
    documentation: "/v1",
    health: "/health",
    readiness: "/ready",
  }));
  application.get("/v1", async () => ({
    endpoints: {
      scans: "/v1/scans",
      incidents: "/v1/incidents",
      reachability: "/v1/reachability/static",
      packages: "/v1/package-metadata",
      metrics: "/metrics",
    },
  }));
  application.get("/health", async () => ({ status: "ok", service: "hydratrace-engine" }));
  application.get("/ready", async () => ({ status: "ready" }));
  application.get("/metrics", async () => ({
    service: "hydratrace-engine",
    graphConsistency:
      graphStore instanceof HydraDbGraphStore
        ? process.env.HYDRADB_CONSISTENCY ?? "causal"
        : "in-memory-reference",
    ...incidentCatalog.stats(),
    packageMetadata: packageIntelligenceCatalog.size,
  }));
  registerIncidentRoutes(application, incidentCatalog);
  registerReachabilityRoutes(application, incidentCatalog);
  registerPackageIntelligenceRoutes(application, packageIntelligenceCatalog);
  registerRemediationRoutes(
    application,
    incidentCatalog,
    graphStore,
    dependencies.strongGraphReads ??
      (graphStore instanceof HydraDbGraphStore && process.env.HYDRADB_CONSISTENCY === "strong"),
  );
  registerAiRoutes(application, incidentCatalog);

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
      incidentCatalog.registerSnapshot(result.normalized, result.deployment);
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

  registerScanWorkflowRoutes(application, async (input, progress) => {
    progress("ACQUIRING", "Lockfile input validated");
    progress("PARSING", "Parsing exact lockfile resolution graph");
    const result = await ingestLockfile(graphStore, {
      content: input.content,
      ...(input.deploymentManifest === undefined
        ? {}
        : { deploymentManifest: input.deploymentManifest }),
      options: {
        sourceRef: input.sourceRef,
        repositoryId: input.repositoryId,
        commitSha: input.commitSha,
        observedAt: input.observedAt,
        ...(input.rootPackage === undefined ? {} : { rootPackage: input.rootPackage }),
      },
    });
    progress("WRITING_GRAPH", "Canonical graph records written idempotently");
    incidentCatalog.registerSnapshot(result.normalized, result.deployment);
    progress("WAITING_FOR_INDEX", "Graph write is available for bounded queries");
    progress("ANALYZING", "Snapshot is ready for incident analysis");
    return {
      snapshot: result.normalized.snapshot,
      deployment: result.deployment,
      graphWrite: result.graphWrite,
      counts: {
        packageVersions: result.normalized.packages.length,
        resolutions: result.normalized.resolutions.length,
        dependencyEdges: result.normalized.edges.length,
        warnings: result.normalized.warnings.length,
      },
    };
  }, dependencies.convexUrl ?? (process.env.NODE_ENV === "test" ? undefined : process.env.CONVEX_URL));

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

  application.post("/v1/enrichment/npm", async (request, reply) => {
    const parsed = osvBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_NPM_METADATA_QUERY" });
    try {
      const packages = await Promise.all(
        parsed.data.packages.map(({ name, version }) =>
          npmRegistryClient.getVersion(name, version),
        ),
      );
      for (const metadata of packages) {
        packageIntelligenceCatalog.register({
          name: metadata.name,
          version: metadata.version,
          maintainers: metadata.maintainers,
          ...(metadata.homepage === undefined ? {} : { homepage: metadata.homepage }),
          ...(metadata.repositoryUrl === undefined
            ? {}
            : { repositoryUrl: metadata.repositoryUrl }),
          ...(metadata.tarballUrl === undefined
            ? {}
            : { tarballUrl: metadata.tarballUrl }),
          ...(metadata.publishedAt === undefined
            ? {}
            : { publishedAt: metadata.publishedAt }),
          ...(metadata.createdAt === undefined ? {} : { createdAt: metadata.createdAt }),
        });
      }
      return { packages };
    } catch (error) {
      return reply.code(502).send({
        error: "NPM_METADATA_FAILED",
        message: error instanceof Error ? error.message : "Unknown npm metadata error",
      });
    }
  });

  application.post("/v1/enrichment/deps-dev", async (request, reply) => {
    const parsed = osvBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_DEPS_DEV_QUERY" });
    try {
      return {
        results: await Promise.all(
          parsed.data.packages.map(async ({ name, version }) => ({
            package: { name, version },
            graph: await depsDevClient.dependencies(name, version),
          })),
        ),
      };
    } catch (error) {
      return reply.code(502).send({
        error: "DEPS_DEV_FAILED",
        message: error instanceof Error ? error.message : "Unknown deps.dev error",
      });
    }
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
