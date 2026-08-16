import {
  sha256Hex,
  stableIdFromCanonicalKey,
  type StableId,
} from "@hydratrace/domain";
import { ConvexHttpClient } from "convex/browser";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { api } from "../../../../convex/_generated/api.js";
import type { Id } from "../../../../convex/_generated/dataModel.js";

const scanSchema = z
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
  })
  .strict();
const scanParameters = z.object({ scanId: z.string().regex(/^\d+$/u) });

export type ScanStage =
  | "QUEUED"
  | "ACQUIRING"
  | "PARSING"
  | "WRITING_GRAPH"
  | "WAITING_FOR_INDEX"
  | "ANALYZING"
  | "COMPLETE"
  | "FAILED"
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
  convexId?: Id<"scans">;
}

export type ScanWorkflowInput = z.infer<typeof scanSchema>;

export function registerScanWorkflowRoutes(
  application: FastifyInstance,
  execute: (
    input: ScanWorkflowInput,
    progress: (stage: ScanStage, message: string) => void,
  ) => Promise<unknown>,
  convexUrl?: string,
): void {
  const scans = new Map<StableId, ScanRecord>();
  const byKey = new Map<string, StableId>();
  const normalizedConvexUrl = convexUrl?.trim();
  const convex = normalizedConvexUrl
    ? new ConvexHttpClient(normalizedConvexUrl)
    : undefined;

  application.post("/v1/scans", async (request, reply) => {
    const parsed = scanSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_SCAN" });
    }
    const key = sha256Hex(
      `${parsed.data.repositoryId}\0${parsed.data.commitSha}\0${sha256Hex(parsed.data.content)}\0${parsed.data.deploymentManifest ?? ""}`,
    );
    const knownId = byKey.get(key);
    if (knownId !== undefined) {
      return reply.code(200).send(publicScan(scans.get(knownId)!));
    }

    const createdAt = Date.now();
    const scanId = stableIdFromCanonicalKey(`scan:${key}`);
    if (convex !== undefined) {
      const durable = await convex.query(api.scans.get, { stableId: scanId });
      if (
        durable !== null &&
        ["COMPLETE", "FAILED", "CANCELED"].includes(durable.stage)
      ) {
        const events = await convex.query(api.scans.events, {
          scanId: durable._id,
        });
        return reply.code(200).send(durableScan(durable, events.length));
      }
    }

    const record: ScanRecord = {
      scanId,
      idempotencyKey: key,
      repositoryId: parsed.data.repositoryId,
      commitSha: parsed.data.commitSha,
      stage: "QUEUED",
      attempt: 1,
      createdAt,
      updatedAt: createdAt,
      events: [],
    };
    scans.set(scanId, record);
    byKey.set(key, scanId);
    progress(record, "QUEUED", "Scan accepted");
    if (convex !== undefined) {
      record.convexId = await convex.mutation(api.scans.create, {
        stableId: scanId,
        idempotencyKey: key,
        repositoryId: record.repositoryId,
        commitSha: record.commitSha,
      });
    }

    const pendingProgress: Promise<unknown>[] = [];
    const advance = (stage: ScanStage, message: string): void => {
      progress(record, stage, message);
      if (convex !== undefined && record.convexId !== undefined) {
        pendingProgress.push(
          convex.mutation(api.scans.progress, {
            scanId: record.convexId,
            stage,
            message,
          }),
        );
      }
    };
    try {
      const result = await execute(parsed.data, advance);
      record.result = result;
      progress(record, "COMPLETE", "Scan completed");
      if (convex !== undefined && record.convexId !== undefined) {
        pendingProgress.push(
          convex.mutation(api.scans.progress, {
            scanId: record.convexId,
            stage: "COMPLETE",
            message: "Scan completed",
            result,
          }),
        );
      }
      await Promise.all(pendingProgress);
      return reply.code(201).send(publicScan(record));
    } catch (error) {
      record.error = error instanceof Error ? error.message : "Unknown scan failure";
      progress(record, "FAILED", record.error);
      if (convex !== undefined && record.convexId !== undefined) {
        pendingProgress.push(
          convex.mutation(api.scans.progress, {
            scanId: record.convexId,
            stage: "FAILED",
            message: record.error,
            error: record.error,
          }),
        );
      }
      await Promise.allSettled(pendingProgress);
      return reply.code(400).send(publicScan(record));
    }
  });

  application.get("/v1/scans/:scanId", async (request, reply) => {
    const parsed = scanParameters.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SCAN_ID" });
    const stableId = parsed.data.scanId as StableId;
    const scan = scans.get(stableId);
    if (scan !== undefined) return publicScan(scan);
    if (convex !== undefined) {
      const durable = await convex.query(api.scans.get, { stableId });
      if (durable !== null) {
        const events = await convex.query(api.scans.events, {
          scanId: durable._id,
        });
        return durableScan(durable, events.length);
      }
    }
    return reply.code(404).send({ error: "SCAN_NOT_FOUND" });
  });

  application.get("/v1/scans/:scanId/events", async (request, reply) => {
    const parsed = scanParameters.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_SCAN_ID" });
    const stableId = parsed.data.scanId as StableId;
    const scan = scans.get(stableId);
    if (scan !== undefined) return { scanId: stableId, events: scan.events };
    if (convex !== undefined) {
      const durable = await convex.query(api.scans.get, { stableId });
      if (durable !== null) {
        const events = await convex.query(api.scans.events, {
          scanId: durable._id,
        });
        return {
          scanId: stableId,
          events: events.map((event) => ({
            eventId: stableIdFromCanonicalKey(
              `scan-event:${stableId}:${event.sequence}:${event.stage}`,
            ),
            stage: event.stage,
            at: event.at,
            message: event.message,
          })),
        };
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
      if (convex !== undefined && scan.convexId !== undefined) {
        await convex.mutation(api.scans.cancel, { scanId: scan.convexId });
      }
      return publicScan(scan);
    }
    if (convex !== undefined) {
      const durable = await convex.query(api.scans.get, { stableId });
      if (durable !== null) {
        const canceled = await convex.mutation(api.scans.cancel, {
          scanId: durable._id,
        });
        return canceled
          ? durableScan({ ...durable, stage: "CANCELED" }, 0)
          : reply.code(409).send({ error: "SCAN_TERMINAL", stage: durable.stage });
      }
    }
    return reply.code(404).send({ error: "SCAN_NOT_FOUND" });
  });
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
): Omit<ScanRecord, "events" | "convexId"> & { eventCount: number } {
  const { events, convexId: _convexId, ...rest } = record;
  return { ...structuredClone(rest), eventCount: events.length };
}

function durableScan(
  record: {
    stableId: string;
    idempotencyKey: string;
    repositoryId: string;
    commitSha: string;
    stage: string;
    attempt: number;
    createdAt: number;
    updatedAt: number;
    result?: unknown;
    error?: string;
  },
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
