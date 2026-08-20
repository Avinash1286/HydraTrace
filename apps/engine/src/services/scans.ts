import {
  sha256Hex,
  stableIdFromCanonicalKey,
  type StableId,
} from "@hydratrace/domain";
import { Buffer } from "node:buffer";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ConvexScanBackend,
  durableEvents,
  type DurableScanBackend,
  type DurableScanRecord,
} from "./convex-scan-backend.js";

const sourcePathSchema = z.string().trim().min(1).max(1_024)
  .superRefine((path, context) => {
    if (
      path.includes("\0") ||
      path.includes("\\") ||
      path.startsWith("/") ||
      /^[A-Za-z]:/u.test(path) ||
      path.split("/").some((part) => part === "..")
    ) {
      context.addIssue({ code: "custom", message: "Source paths must be safe relative POSIX paths" });
    }
  })
  .transform(normalizeSourcePath)
  .refine((path) => path !== "", { message: "Source path cannot resolve to the repository root" });

const sourceFileSchema = z.object({
  path: sourcePathSchema,
  source: z.string().max(1_000_000),
}).strict();

const staticAnalysisRequestSchema = z.object({
  // Identity fields are accepted for compatibility with standalone static
  // analysis documents, but acquisition replaces them with the pinned scan
  // identity before execution.
  snapshotId: z.string().regex(/^\d+$/u).optional(),
  repositoryId: z.string().trim().min(1).max(512).optional(),
  commitSha: z.string().trim().min(1).max(256).optional(),
  observedAt: z.number().int().nonnegative().optional(),
  entrypoints: z.array(sourcePathSchema).min(1).max(100),
  files: z.array(sourceFileSchema).min(1).max(2_000),
}).strict().superRefine((value, context) => validateStaticFiles(value.files, context));

const resolvedStaticAnalysisSchema = z.object({
  origin: z.enum(["archive", "precomputed"]),
  observedAt: z.number().int().nonnegative().optional(),
  entrypoints: z.array(sourcePathSchema).min(1).max(100),
  files: z.array(sourceFileSchema).min(1).max(2_000),
}).strict().superRefine((value, context) => validateStaticFiles(value.files, context));

const runtimeTraceRequestSchema = z.object({
  // snapshotId is accepted for compatibility and canonically replaced by the
  // snapshot created by this scan.
  snapshotId: z.string().regex(/^\d+$/u).optional(),
  runId: z.string().trim().min(1).max(256),
  startedAt: z.number().int().nonnegative(),
  command: z.string().trim().min(1).max(2_048),
  kind: z.enum(["test", "runtime"]),
  deploymentId: z.string().regex(/^\d+$/u).optional(),
  packages: z.array(z.object({
    name: z.string().trim().min(1).max(214),
    version: z.string().trim().min(1).max(128),
    firstLoadedAt: z.number().int().nonnegative(),
    loadCount: z.number().int().positive().max(1_000_000),
  }).strict()).max(10_000),
}).strict();

const resolvedRuntimeTraceSchema = runtimeTraceRequestSchema.omit({ snapshotId: true });

export const resolvedScanSchema = z
  .object({
    content: z.string().min(1).max(5_000_000),
    sourceRef: z.string().trim().min(1),
    repositoryId: z.string().trim().min(1),
    commitSha: z.string().trim().min(1),
    observedAt: z.number().int().nonnegative(),
    rootPackage: z
      .object({
        name: z.string().trim().min(1),
        version: z.string().trim().min(1),
      })
      .optional(),
    deploymentManifest: z.string().min(1).max(100_000).optional(),
    staticAnalysis: resolvedStaticAnalysisSchema.optional(),
    runtimeTrace: resolvedRuntimeTraceSchema.optional(),
  })
  .strict();

const scanRequestSchema = z
  .object({
    mode: z.enum(["lockfile", "zip", "repository"]).default("lockfile"),
    content: z.string().min(1).max(5_000_000).optional(),
    archiveBase64: z.string().min(1).max(5_400_000).optional(),
    repositoryUrl: z.string().url().max(2_048).optional(),
    ref: z.string().trim().min(1).max(256).optional(),
    lockfilePath: z.string().trim().min(1).max(1_024).optional(),
    sourceRef: z.string().trim().min(1).max(1_024).optional(),
    repositoryId: z.string().trim().min(1).max(512).optional(),
    commitSha: z.string().trim().min(1).max(256).optional(),
    observedAt: z.number().int().nonnegative().optional(),
    rootPackage: z
      .object({
        name: z.string().trim().min(1),
        version: z.string().trim().min(1),
      })
      .optional(),
    deploymentManifest: z.string().min(1).max(100_000).optional(),
    staticAnalysis: staticAnalysisRequestSchema.optional(),
    runtimeTrace: runtimeTraceRequestSchema.optional(),
    organizationId: z.string().trim().min(1).max(256).optional(),
    serviceId: z.string().trim().min(1).max(256).optional(),
    environment: z.string().trim().min(1).max(128).optional(),
    deploymentStartedAt: z.number().int().nonnegative().optional(),
    deploymentEndedAt: z.number().int().nonnegative().nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "lockfile" && value.content === undefined) {
      context.addIssue({ code: "custom", path: ["content"], message: "Lockfile content is required" });
    }
    if (value.mode === "zip" && value.archiveBase64 === undefined) {
      context.addIssue({ code: "custom", path: ["archiveBase64"], message: "ZIP archive is required" });
    }
    if (value.mode === "repository" && value.repositoryUrl === undefined) {
      context.addIssue({ code: "custom", path: ["repositoryUrl"], message: "Repository URL is required" });
    }
    if (
      value.deploymentStartedAt !== undefined &&
      value.deploymentEndedAt !== undefined &&
      value.deploymentEndedAt !== null &&
      value.deploymentEndedAt <= value.deploymentStartedAt
    ) {
      context.addIssue({ code: "custom", path: ["deploymentEndedAt"], message: "Deployment end must be later than start" });
    }
  });
const scanParameters = z.object({ scanId: z.string().regex(/^\d+$/u) });
const eventListQuery = z.object({
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ScanStage =
  | "QUEUED"
  | "ACQUIRING"
  | "PARSING"
  | "ENRICHING"
  | "WRITING_GRAPH"
  | "INDEXING"
  | "WAITING_FOR_INDEX"
  | "ANALYZING"
  | "COMPLETE"
  | "FAILED"
  | "RETRY_WAIT"
  | "CANCEL_REQUESTED"
  | "CANCELLED"
  | "CANCELED";

interface ScanEvent {
  eventId: StableId;
  stage: ScanStage;
  at: number;
  message: string;
}

interface ScanRecord {
  scanId: StableId;
  idempotencyKey: string;
  repositoryId: string;
  commitSha: string;
  stage: ScanStage;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  result?: unknown;
  error?: string;
  events: ScanEvent[];
}

export type ScanWorkflowInput = z.infer<typeof resolvedScanSchema>;
export type ScanWorkflowRequest = z.infer<typeof scanRequestSchema>;

export function registerScanWorkflowRoutes(
  application: FastifyInstance,
  prepare: (request: ScanWorkflowRequest) => Promise<ScanWorkflowInput>,
  execute: (
    input: ScanWorkflowInput,
    progress: (stage: ScanStage, message: string) => void,
  ) => Promise<unknown>,
  convexUrl?: string,
  providedDurableBackend?: DurableScanBackend,
): void {
  const scans = new Map<StableId, ScanRecord>();
  const byKey = new Map<string, StableId>();
  const normalizedConvexUrl = convexUrl?.trim();
  const durableBackend = providedDurableBackend ?? (normalizedConvexUrl
    ? new ConvexScanBackend(
      normalizedConvexUrl,
      process.env.HYDRATRACE_JOB_SHARED_SECRET ?? "",
      {
        ...(process.env.CONVEX_SITE_URL === undefined
          ? {}
          : { siteUrl: process.env.CONVEX_SITE_URL }),
      },
    )
    : undefined);

  application.post("/v1/scans", async (request, reply) => {
    const parsed = scanRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_SCAN",
        issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
      });
    }
    let input: ScanWorkflowInput;
    try {
      input = resolvedScanSchema.parse(await prepare(parsed.data));
    } catch (error) {
      return reply.code(400).send({
        error: "ACQUISITION_FAILED",
        message: error instanceof Error ? error.message : "Repository acquisition failed",
      });
    }
    const key = sha256Hex(
      [
        input.repositoryId,
        input.commitSha,
        sha256Hex(input.content),
        input.deploymentManifest ?? "",
        canonicalJson(input.staticAnalysis ?? null),
        canonicalJson(input.runtimeTrace ?? null),
      ].join("\0"),
    );
    const scanId = stableIdFromCanonicalKey(`scan:${key}`);
    if (durableBackend !== undefined) {
      try {
        const scheduled = await durableBackend.schedule(scanId, key, input);
        return reply
          .code(scheduled.created ? 202 : 200)
          .send(durableScan(scheduled.record, scheduled.events.length));
      } catch (error) {
        return reply.code(503).send({
          error: "DURABLE_SCHEDULER_UNAVAILABLE",
          message: error instanceof Error ? error.message : "Convex scheduling failed",
        });
      }
    }
    const knownId = byKey.get(key);
    if (knownId !== undefined) {
      return reply.code(200).send(publicScan(scans.get(knownId)!));
    }

    const createdAt = Date.now();
    const record: ScanRecord = {
      scanId,
      idempotencyKey: key,
      repositoryId: input.repositoryId,
      commitSha: input.commitSha,
      stage: "QUEUED",
      attempt: 1,
      createdAt,
      updatedAt: createdAt,
      events: [],
    };
    scans.set(scanId, record);
    byKey.set(key, scanId);
    progress(record, "QUEUED", "Scan accepted");
    const advance = (stage: ScanStage, message: string): void => {
      progress(record, stage, message);
    };
    try {
      const result = await execute(input, advance);
      record.result = result;
      progress(record, "COMPLETE", "Scan completed");
      return reply.code(201).send(publicScan(record));
    } catch (error) {
      record.error = error instanceof Error ? error.message : "Unknown scan failure";
      progress(record, "FAILED", record.error);
      return reply.code(400).send(publicScan(record));
    }
  });

  application.get("/v1/scans/:scanId", async (request, reply) => {
    const parsed = scanParameters.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SCAN_ID" });
    const stableId = parsed.data.scanId as StableId;
    const scan = scans.get(stableId);
    if (scan !== undefined) return publicScan(scan);
    if (durableBackend !== undefined) {
      try {
        const durable = await durableBackend.get(stableId);
        if (durable !== undefined) return durableScan(durable.record, durable.events.length);
      } catch (error) {
        return reply.code(503).send({
          error: "DURABLE_SCHEDULER_UNAVAILABLE",
          message: error instanceof Error ? error.message : "Convex status lookup failed",
        });
      }
    }
    return reply.code(404).send({ error: "SCAN_NOT_FOUND" });
  });

  application.get("/v1/scans/:scanId/events", async (request, reply) => {
    const parsed = scanParameters.safeParse(request.params);
    const query = eventListQuery.safeParse(request.query);
    if (!parsed.success || !query.success) return reply.code(400).send({ error: "INVALID_SCAN_EVENT_QUERY" });
    const stableId = parsed.data.scanId as StableId;
    const scan = scans.get(stableId);
    if (scan !== undefined) return {
      scanId: stableId,
      total: scan.events.length,
      offset: query.data.offset,
      limit: query.data.limit,
      events: scan.events.slice(query.data.offset, query.data.offset + query.data.limit),
    };
    if (durableBackend !== undefined) {
      try {
        const durable = await durableBackend.get(stableId);
        if (durable !== undefined) {
          const events = durableEvents(stableId, durable.events);
        return {
          scanId: stableId,
          total: events.length,
          offset: query.data.offset,
          limit: query.data.limit,
            events: events.slice(query.data.offset, query.data.offset + query.data.limit),
        };
        }
      } catch (error) {
        return reply.code(503).send({
          error: "DURABLE_SCHEDULER_UNAVAILABLE",
          message: error instanceof Error ? error.message : "Convex event lookup failed",
        });
      }
    }
    return reply.code(404).send({ error: "SCAN_NOT_FOUND" });
  });

  application.post("/v1/scans/:scanId/cancel", async (request, reply) => {
    const parsed = scanParameters.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SCAN_ID" });
    const stableId = parsed.data.scanId as StableId;
    const scan = scans.get(stableId);
    if (scan !== undefined) {
      if (["COMPLETE", "FAILED", "CANCELED"].includes(scan.stage)) {
        return reply.code(409).send({ error: "SCAN_TERMINAL", stage: scan.stage });
      }
      progress(scan, "CANCELED", "Scan canceled by user");
      return publicScan(scan);
    }
    if (durableBackend !== undefined) {
      try {
        const durable = await durableBackend.get(stableId);
        if (durable !== undefined) {
          if (["COMPLETE", "FAILED", "CANCELED", "CANCELLED"].includes(durable.record.stage)) {
            return reply.code(409).send({ error: "SCAN_TERMINAL", stage: durable.record.stage });
          }
          const canceled = await durableBackend.cancel(stableId);
          if (canceled !== undefined) return durableScan(canceled.record, canceled.events.length);
        }
      } catch (error) {
        return reply.code(503).send({
          error: "DURABLE_SCHEDULER_UNAVAILABLE",
          message: error instanceof Error ? error.message : "Convex cancellation failed",
        });
      }
    }
    return reply.code(404).send({ error: "SCAN_NOT_FOUND" });
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function normalizeSourcePath(path: string): string {
  return path.split("/").filter((part) => part !== "" && part !== ".").join("/");
}

function validateStaticFiles(
  files: Array<{ path: string; source: string }>,
  context: { addIssue: (issue: { code: "custom"; path: Array<string | number>; message: string }) => void },
): void {
  const seen = new Set<string>();
  let sourceBytes = 0;
  files.forEach((file, index) => {
    if (seen.has(file.path)) {
      context.addIssue({
        code: "custom",
        path: ["files", index, "path"],
        message: `Duplicate normalized source path ${file.path}`,
      });
    }
    seen.add(file.path);
    sourceBytes += Buffer.byteLength(file.source, "utf8");
  });
  if (sourceBytes > 5_000_000) {
    context.addIssue({
      code: "custom",
      path: ["files"],
      message: "Aggregate source content exceeds 5000000 bytes",
    });
  }
}

function progress(record: ScanRecord, stage: ScanStage, message: string): void {
  const at = Date.now();
  record.stage = stage;
  record.updatedAt = at;
  record.events.push({
    eventId: stableIdFromCanonicalKey(
      `scan-event:${record.scanId}:${record.events.length}:${stage}`,
    ),
    stage,
    at,
    message,
  });
}

function publicScan(
  record: ScanRecord,
): Omit<ScanRecord, "events"> & { eventCount: number } {
  const { events, ...rest } = record;
  return { ...structuredClone(rest), eventCount: events.length };
}

function durableScan(
  record: DurableScanRecord,
  eventCount: number,
): Record<string, unknown> {
  return {
    scanId: record.stableId,
    idempotencyKey: record.idempotencyKey,
    repositoryId: record.repositoryId,
    commitSha: record.commitSha,
    stage: record.stage,
    attempt: record.attempt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.error === undefined ? {} : { error: record.error }),
    eventCount,
  };
}
