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
import { stableIdFromCanonicalKey } from "@hydratrace/domain";
import { buildExposureTimeline, IncidentCatalog } from "@hydratrace/incident-analysis";
import { PackageIntelligenceCatalog } from "@hydratrace/package-intelligence";
import { analyzeStaticImports } from "@hydratrace/reachability";
import { simulateNpmLockfile } from "@hydratrace/remediation";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import rawBody from "fastify-raw-body";
import { z } from "zod";
import { ingestLockfile } from "./services/ingestion.js";
import { registerIncidentRoutes } from "./services/incidents.js";
import { registerReachabilityRoutes } from "./services/reachability.js";
import { registerPackageIntelligenceRoutes } from "./services/package-intelligence.js";
import { registerRemediationRoutes } from "./services/remediations.js";
import { registerScanWorkflowRoutes } from "./services/scans.js";
import { registerAiRoutes } from "./services/ai.js";
import { acquireScanInput } from "./services/acquisition.js";
import {
  analyzeBlastRadiusFromGraphStore,
  ensureIncidentCatalogHydrated,
  ensureSnapshotCatalogHydrated,
  persistIncident,
} from "./services/graph-catalog.js";
import { persistRuntimeReachability, persistStaticReachability } from "./services/reachability-graph.js";
import {
  hydratePackageIntelligence,
  persistPackageIntelligence,
} from "./services/package-metadata-graph.js";
import { registerSignedJobRoutes } from "./services/signed-jobs.js";
import { EngineMetrics, installRequestObservability } from "./services/observability.js";
import { enrichScan } from "./services/scan-enrichment.js";
import { persistScanReachability } from "./services/scan-reachability.js";
import {
  hydraDbIndexerMonitor,
  waitForHydraDbIndexerVisibility,
  type HydraDbIndexerMonitor,
  type HydraDbIndexerSnapshot,
} from "./services/indexer-visibility.js";
import { builtInDemoScans, DEMO_INCIDENT_END, DEMO_INCIDENT_START } from "./demo-data.js";

const SCAN_ANALYSIS_INCIDENT_LIMIT = 100;

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
  osvClient?: Pick<OsvClient, "queryExactPackages">;
  npmRegistryClient?: Pick<NpmRegistryClient, "getVersion" | "listVersions">;
  depsDevClient?: Pick<DepsDevClient, "dependencies">;
  incidentCatalog?: IncidentCatalog;
  packageIntelligenceCatalog?: PackageIntelligenceCatalog;
  strongGraphReads?: boolean;
  convexUrl?: string;
  aiEnvironment?: NodeJS.ProcessEnv;
  jobSharedSecret?: string;
  scanEnrichmentEnabled?: boolean;
  remediationSimulation?: typeof simulateNpmLockfile;
  allowRootRemediationSimulation?: boolean;
  enableLegacyMutationRoutes?: boolean;
  scanIndexerMonitor?: HydraDbIndexerMonitor;
  readinessProbe?: () => Promise<{
    ready: boolean;
    graph: Record<string, unknown>;
    indexer: Record<string, unknown>;
  }>;
}

export function buildEngine(dependencies: EngineDependencies = {}): FastifyInstance {
  const graphStore = dependencies.graphStore ?? new InMemoryGraphStore();
  const scanIndexerMonitor = dependencies.scanIndexerMonitor ??
    (graphStore instanceof HydraDbGraphStore
      ? hydraDbIndexerMonitor(process.env.HYDRADB_INDEXER_ADMIN_URL ?? "", {
          graphId: process.env.HYDRADB_GRAPH_ID ?? "default",
        })
      : undefined);
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
  const engineMetrics = new EngineMetrics();
  installRequestObservability(application, engineMetrics);
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
  const legacyMutationRoutesEnabled =
    dependencies.enableLegacyMutationRoutes ?? process.env.NODE_ENV !== "production";
  if (!legacyMutationRoutesEnabled) {
    const disabledLegacyMutations = new Set([
      "/v1/package-metadata",
      "/v1/enrichment/osv",
      "/v1/enrichment/npm",
      "/v1/enrichment/deps-dev",
      "/v1/reachability/static",
      "/v1/reachability/runtime",
      "/v1/remediations/simulate",
    ]);
    application.addHook("onRequest", async (request, reply) => {
      const path = request.url.split("?", 1)[0]!;
      if (request.method === "POST" && disabledLegacyMutations.has(path)) {
        return reply.code(404).send({
          error: "ROUTE_NOT_AVAILABLE",
          message: "This legacy mutation route is disabled in production; use the signed scan workflow.",
        });
      }
    });
  }

  let demoSeed: Promise<Awaited<ReturnType<typeof seedBuiltInDemo>>> | undefined;
  const ensureDemo = (): Promise<Awaited<ReturnType<typeof seedBuiltInDemo>>> => {
    if (demoSeed === undefined) {
      demoSeed = restoreBuiltInDemoFromGraph(
        graphStore,
        incidentCatalog,
        packageIntelligenceCatalog,
      ).then((restored) => restored ??
        seedBuiltInDemo(graphStore, incidentCatalog, packageIntelligenceCatalog))
        .catch((error: unknown) => {
          // A transient graph or object-storage failure must not poison every
          // later restore attempt for the lifetime of the engine process.
          demoSeed = undefined;
          throw error;
        });
    }
    return demoSeed;
  };
  // Keep build/test behavior deterministic. Stateless demo seeding is an
  // explicit deployment choice, never an implicit consequence of VERCEL=1.
  const runningTests = process.env.VITEST !== undefined ||
    process.argv.some((argument) => /(?:^|[\\/])vitest(?:\.m?js)?$/u.test(argument));
  const autoSeedDemo = !runningTests &&
    process.env.HYDRATRACE_AUTO_SEED_DEMO === "true" &&
    !(graphStore instanceof HydraDbGraphStore);
  if (autoSeedDemo) {
    application.addHook("preHandler", async (request) => {
      if (
        request.url.startsWith("/v1/incidents") ||
        request.url.startsWith("/v1/packages") ||
        request.url.startsWith("/v1/demo")
      ) {
        await ensureDemo();
      }
    });
  }

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
  application.get("/ready", async (_request, reply) => {
    const readiness = dependencies.readinessProbe === undefined
      ? await dependencyReadiness(graphStore)
      : await dependencies.readinessProbe();
    return reply
      .code(readiness.ready ? 200 : 503)
      .send({ status: readiness.ready ? "ready" : "not-ready", ...readiness });
  });
  application.get("/metrics", async (request, reply) => {
    const graphConsistency = graphStore instanceof HydraDbGraphStore
      ? process.env.HYDRADB_CONSISTENCY ?? "causal"
      : "in-memory-reference";
    const catalogStats = incidentCatalog.stats();
    const result = {
      service: "hydratrace-engine",
      graphConsistency,
      ...catalogStats,
      packageMetadata: packageIntelligenceCatalog.size,
      ...engineMetrics.snapshot(),
    };
    if (request.headers.accept?.includes("text/plain")) {
      return reply.type("text/plain; version=0.0.4").send(engineMetrics.prometheus({
        hydratrace_graph_snapshots: catalogStats.snapshots,
        hydratrace_graph_resolutions: catalogStats.resolutions,
        hydratrace_graph_consistency: graphConsistency,
      }));
    }
    return result;
  });
  application.get("/v1/system", async () => {
    let graphHealthy = true;
    if (graphStore instanceof HydraDbGraphStore) {
      try { await graphStore.verifyConnectivity(); } catch { graphHealthy = false; }
    }
    const indexer = await indexerStatus(process.env.HYDRADB_INDEXER_ADMIN_URL);
    return {
      checkedAt: Date.now(),
      engine: { healthy: true, version: "0.1.0", runtime: process.version },
      graph: {
        healthy: graphHealthy,
        provider: graphStore instanceof HydraDbGraphStore ? "HydraDB" : "in-memory-reference",
        consistency: graphStore instanceof HydraDbGraphStore ? process.env.HYDRADB_CONSISTENCY ?? "causal" : "reference",
      },
      indexer,
      cache: { provider: responseCache instanceof FileResponseCache ? "filesystem" : "memory", status: "ready" },
      ai: {
        gatewayConfigured: Boolean(process.env.AI_GATEWAY_URL && process.env.AI_GATEWAY_SHARED_SECRET),
        deterministicFallback: true,
      },
      metrics: engineMetrics.snapshot(),
    };
  });
  application.post("/v1/demo/reset", async () => {
    return ensureDemo();
  });
  application.get("/v1/demo", async () => ensureDemo());
  registerIncidentRoutes(application, incidentCatalog, graphStore);
  registerReachabilityRoutes(application, incidentCatalog, graphStore);
  registerPackageIntelligenceRoutes(application, packageIntelligenceCatalog, graphStore);
  registerRemediationRoutes(
    application,
    incidentCatalog,
    graphStore,
    dependencies.strongGraphReads ??
      (graphStore instanceof HydraDbGraphStore && process.env.HYDRADB_CONSISTENCY === "strong"),
    {
      npmRegistryClient,
      osvClient,
      simulateLockfile: dependencies.remediationSimulation ?? simulateNpmLockfile,
      ...(dependencies.allowRootRemediationSimulation === undefined
        ? {}
        : { allowRootSimulation: dependencies.allowRootRemediationSimulation }),
    },
  );
  registerAiRoutes(
    application,
    incidentCatalog,
    graphStore,
    dependencies.aiEnvironment ?? (process.env.NODE_ENV === "test" ? {} : process.env),
  );

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

  const executeScan = async (
    input: import("./services/scans.js").ScanWorkflowInput,
    progress: (stage: import("./services/scans.js").ScanStage, message: string) => void,
  ): Promise<unknown> => {
    const jobStarted = performance.now();
    engineMetrics.increment("hydratrace_jobs_total");
    progress("ACQUIRING", "Synchronous acquisition preflight completed before durable dispatch");
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
      onGraphWriteStart: () => {
        progress("WRITING_GRAPH", "Writing canonical lockfile and deployment records idempotently");
      },
    });
    progress("ENRICHING", "Querying exact advisory metadata and persisting bounded scan evidence");
    const enrichment = await enrichScan(
      result.normalized,
      {
        graphStore,
        incidentCatalog,
        packageIntelligenceCatalog,
        osvClient,
        npmRegistryClient,
        depsDevClient,
        onExternalError: () =>
          engineMetrics.increment("hydratrace_external_api_errors_total"),
      },
      {
        enabled:
          dependencies.scanEnrichmentEnabled ??
          (process.env.NODE_ENV !== "test" &&
            process.env.HYDRATRACE_SCAN_ENRICHMENT !== "false"),
        incidentCreatedAt: input.observedAt,
      },
    );
    incidentCatalog.registerSnapshot(result.normalized, result.deployment);
    const reachability = await persistScanReachability(
      graphStore,
      incidentCatalog,
      input,
      result.normalized.snapshot.id,
    );
    engineMetrics.increment("hydratrace_packages_parsed_total", result.normalized.packages.length);
    engineMetrics.increment("hydratrace_graph_nodes_written_total", result.graphWrite.nodes.created);
    engineMetrics.increment("hydratrace_graph_edges_written_total", result.graphWrite.relationships.created);
    const indexer = await awaitScanIndexVisibility(
      scanIndexerMonitor,
      result.normalized.edges.length > 0 ? "DEPENDS_ON_INSTANCE" : undefined,
      progress,
    );
    const incidentIds = [...new Set(enrichment.packages.flatMap(({ advisories }) =>
      advisories.flatMap(({ incident }) => incident === undefined ? [] : [incident.id])))]
      .sort((left, right) => left.localeCompare(right));
    const analyzedIncidentIds = incidentIds.slice(0, SCAN_ANALYSIS_INCIDENT_LIMIT);
    progress(
      "ANALYZING",
      analyzedIncidentIds.length === 0
        ? "No exact advisory incidents require blast-radius traversal"
        : `Running bounded graph blast-radius traversal for ${analyzedIncidentIds.length} incident(s)`,
    );
    const incidentAnalyses = [];
    for (const incidentId of analyzedIncidentIds) {
      const analysis = await analyzeBlastRadiusFromGraphStore(
        graphStore,
        incidentCatalog,
        incidentId,
        {
          includeDevelopment: false,
          pathDisplayLimit: 20,
          pathCountLimit: 10_000,
          limit: 100,
        },
        input.observedAt,
      );
      incidentAnalyses.push({
        incidentId,
        totalFindings: analysis.totalFindings,
        totalAffectedServices: analysis.totalAffectedServices,
        totalAffectedDeployments: analysis.totalAffectedDeployments,
        totalPaths: analysis.totalPaths,
        pathsTruncated: analysis.pathsTruncated,
      });
    }
    const output = {
      snapshot: result.normalized.snapshot,
      deployment: result.deployment,
      graphWrite: result.graphWrite,
      enrichment,
      reachability,
      indexer,
      analysis: {
        incidentsDiscovered: incidentIds.length,
        incidentsAnalyzed: analyzedIncidentIds.length,
        truncated: incidentIds.length > analyzedIncidentIds.length,
        incidents: incidentAnalyses,
      },
      counts: {
        packageVersions: result.normalized.packages.length,
        resolutions: result.normalized.resolutions.length,
        dependencyEdges: result.normalized.edges.length,
        warnings: result.normalized.warnings.length,
      },
    };
    engineMetrics.observeJob((performance.now() - jobStarted) / 1_000);
    return output;
  };
  registerScanWorkflowRoutes(
    application,
    acquireScanInput,
    executeScan,
    dependencies.convexUrl ?? (process.env.NODE_ENV === "test" ? undefined : process.env.CONVEX_URL),
  );
  void application.register(async (signedRoutes) => {
    await signedRoutes.register(rawBody, {
      field: "rawBody",
      global: false,
      encoding: false,
      runFirst: true,
    });
    registerSignedJobRoutes(
      signedRoutes,
      executeScan,
      dependencies.jobSharedSecret ?? process.env.HYDRATRACE_JOB_SHARED_SECRET,
    );
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
      await persistPackageIntelligence(graphStore, packageIntelligenceCatalog);
      return { packages };
    } catch (error) {
      engineMetrics.increment("hydratrace_external_api_errors_total");
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
      engineMetrics.increment("hydratrace_external_api_errors_total");
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

async function awaitScanIndexVisibility(
  monitor: HydraDbIndexerMonitor | undefined,
  requiredGenerationEdgeType: string | undefined,
  progress: (stage: "INDEXING" | "WAITING_FOR_INDEX", message: string) => void,
): Promise<{
  provider: "HydraDB" | "in-memory-reference";
  waited: boolean;
  baseline?: HydraDbIndexerSnapshot;
  visible?: HydraDbIndexerSnapshot;
}> {
  if (monitor === undefined) {
    progress("INDEXING", "In-memory graph mutations are committed synchronously");
    progress("WAITING_FOR_INDEX", "No external indexer wait is required for the in-memory reference store");
    return { provider: "in-memory-reference", waited: false };
  }

  progress("INDEXING", "Graph mutations committed; capturing the separate indexer's cycle baseline");
  const baseline = await monitor.probe();
  progress(
    "WAITING_FOR_INDEX",
    `Waiting for a fresh healthy indexer cycle after cycle ${baseline.successfulCycles}` +
      (requiredGenerationEdgeType === undefined
        ? " with a published graph generation"
        : ` with a published ${requiredGenerationEdgeType} generation`),
  );
  const visible = await waitForHydraDbIndexerVisibility(
    monitor,
    baseline,
    requiredGenerationEdgeType,
  );
  return { provider: "HydraDB", waited: true, baseline, visible };
}

async function indexerStatus(adminUrl: string | undefined): Promise<Record<string, unknown>> {
  if (adminUrl === undefined || adminUrl.trim() === "") {
    return { configured: false, healthy: null, lastSuccessfulCycleAt: null };
  }
  try {
    const base = adminUrl.replace(/\/$/u, "");
    const [ready, metrics] = await Promise.all([
      fetch(`${base}/readyz`, { signal: AbortSignal.timeout(2_000) }),
      fetch(`${base}/metrics`, { signal: AbortSignal.timeout(2_000) }),
    ]);
    const text = metrics.ok ? await metrics.text() : "";
    const generation = /hydradb_graph_generation(?:\{[^}]*\})?\s+(\d+)/u.exec(text)?.[1];
    return {
      configured: true,
      healthy: ready.ok,
      lastSuccessfulCycleAt: ready.ok ? Date.now() : null,
      ...(generation === undefined ? {} : { graphGeneration: Number(generation) }),
    };
  } catch (error) {
    return { configured: true, healthy: false, lastSuccessfulCycleAt: null, error: error instanceof Error ? error.message : "Indexer status failed" };
  }
}

async function dependencyReadiness(graphStore: GraphStore): Promise<{
  ready: boolean;
  graph: Record<string, unknown>;
  indexer: Record<string, unknown>;
}> {
  const hydraDb = graphStore instanceof HydraDbGraphStore;
  let graphHealthy = true;
  if (hydraDb) {
    try {
      await graphStore.verifyConnectivity();
    } catch {
      graphHealthy = false;
    }
  }
  const indexer = await indexerStatus(hydraDb ? process.env.HYDRADB_INDEXER_ADMIN_URL : undefined);
  const indexerRequired = hydraDb && indexer.configured === true;
  const indexerHealthy = !indexerRequired || indexer.healthy === true;
  return {
    ready: graphHealthy && indexerHealthy,
    graph: {
      configured: hydraDb,
      healthy: graphHealthy,
      provider: hydraDb ? "HydraDB" : "in-memory-reference",
    },
    indexer,
  };
}

async function seedBuiltInDemo(
  graphStore: GraphStore,
  incidentCatalog: IncidentCatalog,
  packageIntelligenceCatalog: PackageIntelligenceCatalog,
): Promise<Record<string, unknown>> {
  const writes = [];
  const snapshots = [];
  for (const input of builtInDemoScans()) {
    const result = await ingestLockfile(graphStore, {
      content: input.content,
      deploymentManifest: input.deploymentManifest!,
      options: {
        sourceRef: input.sourceRef,
        repositoryId: input.repositoryId,
        commitSha: input.commitSha,
        observedAt: input.observedAt,
        ...(input.rootPackage === undefined ? {} : { rootPackage: input.rootPackage }),
      },
    });
    incidentCatalog.registerSnapshot(result.normalized, result.deployment);
    writes.push(result.graphWrite);
    snapshots.push(result.normalized.snapshot);
  }

  const checkout = incidentCatalog.entries().find(({ normalized }) =>
    normalized.snapshot.repositoryId === "acme-commerce/checkout-api" &&
    normalized.snapshot.commitSha === "1111111111111111111111111111111111111111");
  const payment = incidentCatalog.entries().find(({ normalized }) =>
    normalized.snapshot.repositoryId === "acme-commerce/payment-worker" &&
    normalized.snapshot.commitSha === "2222222222222222222222222222222222222222");
  if (checkout === undefined || payment === undefined) throw new Error("Built-in demo snapshots were not seeded");

  const staticInput = {
    repositoryId: checkout.normalized.snapshot.repositoryId,
    commitSha: checkout.normalized.snapshot.commitSha,
    entrypoints: ["src/server.ts"],
    files: [{ path: "src/server.ts", source: 'import helper from "compromised-helper"; helper();' }],
  };
  const staticResult = analyzeStaticImports(staticInput);
  const staticEvidence = incidentCatalog.registerStaticAnalysis(
    checkout.normalized.snapshot.id,
    staticResult,
    Date.parse("2026-08-15T09:18:00.000Z"),
  );
  await persistStaticReachability(graphStore, checkout, staticInput, staticResult, staticEvidence);
  const runtimeTrace = {
    runId: "acme-payment-test-20260815",
    startedAt: Date.parse("2026-08-15T09:25:00.000Z"),
    command: "pnpm test",
    kind: "test",
    snapshotId: payment.normalized.snapshot.id,
    deploymentId: payment.deployments[0]!.deploymentId,
    packages: [{
      name: "compromised-helper",
      version: "1.4.2",
      firstLoadedAt: Date.parse("2026-08-15T09:25:10.000Z"),
      loadCount: 4,
    }],
  } as const;
  const runtimeEvidence = incidentCatalog.registerRuntimeTrace(runtimeTrace);
  await persistRuntimeReachability(graphStore, payment, runtimeTrace, runtimeEvidence);

  packageIntelligenceCatalog.register({
    name: "compromised-helper",
    version: "1.4.2",
    maintainers: [{ name: "Acme Demo Publisher", email: "publisher@example.test", source: "fictional-demo" }],
    repositoryUrl: "https://github.com/acme-demo/helper",
    tarballUrl: "https://registry.example.test/compromised-helper/-/compromised-helper-1.4.2.tgz",
    weeklyDownloads: 120_000,
    createdAt: Date.parse("2024-01-01T00:00:00.000Z"),
  });
  packageIntelligenceCatalog.register({
    name: "compromised-he1per",
    version: "1.0.0",
    maintainers: [{ name: "Unknown Demo Publisher", email: "publisher@example.test", source: "fictional-demo" }],
    repositoryUrl: "https://github.com/acme-demo/helper",
    weeklyDownloads: 12,
    createdAt: Date.parse("2026-08-14T00:00:00.000Z"),
  });
  await persistPackageIntelligence(graphStore, packageIntelligenceCatalog);

  const incident = incidentCatalog.createIncident({
    ecosystem: "npm",
    packageName: "compromised-helper",
    affectedVersions: ["1.4.2"],
    startsAt: DEMO_INCIDENT_START,
    endsAt: DEMO_INCIDENT_END,
    environments: ["production"],
    source: "manual",
    windowSource: "fictional-demo-incident",
    windowConfidence: 1,
    severityScore: 0.95,
  }, DEMO_INCIDENT_START);
  await persistIncident(graphStore, incident);
  const blastRadius = await analyzeBlastRadiusFromGraphStore(graphStore, incidentCatalog, incident.id, {
    includeDevelopment: false,
    pathDisplayLimit: 100,
    pathCountLimit: 10_000,
    limit: 100,
  });
  const timeline = buildExposureTimeline(incidentCatalog, incident.id);
  return {
    status: "ready",
    fictional: true,
    incident,
    blastRadius,
    timeline,
    snapshots,
    stats: incidentCatalog.stats(),
    graphWrite: {
      nodesCreated: writes.reduce((sum, write) => sum + write.nodes.created, 0),
      relationshipsCreated: writes.reduce((sum, write) => sum + write.relationships.created, 0),
    },
  };
}

async function restoreBuiltInDemoFromGraph(
  graphStore: GraphStore,
  incidentCatalog: IncidentCatalog,
  packageIntelligenceCatalog: PackageIntelligenceCatalog,
): Promise<Awaited<ReturnType<typeof seedBuiltInDemo>> | undefined> {
  const incidentId = stableIdFromCanonicalKey([
    "incident",
    "compromised-helper",
    "1.4.2",
    "",
    DEMO_INCIDENT_START,
    DEMO_INCIDENT_END,
    "",
    "production",
  ].join(":"));
  const incident = await ensureIncidentCatalogHydrated(graphStore, incidentCatalog, incidentId);
  if (incident === undefined) return undefined;

  const expectedSnapshots = new Set(builtInDemoScans().map((scan) =>
    `${scan.repositoryId}\0${scan.commitSha}`));
  const storedSnapshots = (await graphStore.matchNodes({
    label: "LockfileSnapshot",
    limit: 10_000,
  })).filter((node) => node.label === "LockfileSnapshot" && expectedSnapshots.has(
    `${node.properties.repositoryId}\0${node.properties.commitSha}`,
  ));
  if (storedSnapshots.length !== expectedSnapshots.size) return undefined;

  for (const snapshot of storedSnapshots) {
    if (!(await ensureSnapshotCatalogHydrated(graphStore, incidentCatalog, snapshot.id))) {
      return undefined;
    }
  }
  await hydratePackageIntelligence(graphStore, packageIntelligenceCatalog);

  const snapshots = incidentCatalog.entries()
    .filter(({ normalized }) => expectedSnapshots.has(
      `${normalized.snapshot.repositoryId}\0${normalized.snapshot.commitSha}`,
    ))
    .map(({ normalized }) => normalized.snapshot)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (snapshots.length !== expectedSnapshots.size) return undefined;

  const blastRadius = await analyzeBlastRadiusFromGraphStore(
    graphStore,
    incidentCatalog,
    incident.id,
    {
      includeDevelopment: false,
      pathDisplayLimit: 100,
      pathCountLimit: 10_000,
      limit: 100,
    },
    incident.createdAt,
  );
  return {
    status: "ready",
    fictional: true,
    incident,
    blastRadius,
    timeline: buildExposureTimeline(incidentCatalog, incident.id),
    snapshots,
    stats: incidentCatalog.stats(),
    graphWrite: { nodesCreated: 0, relationshipsCreated: 0 },
  };
}

export function graphStoreFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): GraphStore {
  return environment.HYDRADB_BOLT_URI === undefined
    ? new InMemoryGraphStore()
    : HydraDbGraphStore.connect(hydraDbConnectionOptionsFromEnv(environment));
}
