import { createHmac, timingSafeEqual } from "node:crypto";
import { stableIdFromCanonicalKey } from "@hydratrace/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  resolvedScanSchema,
  type ScanStage,
  type ScanWorkflowInput,
} from "./scans.js";
import {
  jobStatusStoreFromEnvironment,
  type DurableJobStatus,
  type JobStatusStore,
} from "./job-status-store.js";

const dispatchSchema = z.object({
  jobId: z.string().trim().min(1).max(256),
  idempotencyKey: z.string().regex(/^[0-9a-f]{64}$/u),
  callbackUrl: z.string().url().max(2_048),
  scan: resolvedScanSchema,
}).strict();

export class SignedRequestVerifier {
  readonly #seen = new Map<string, number>();
  constructor(
    readonly secret: string,
    readonly now: () => number = Date.now,
    readonly maximumAgeMs = 300_000,
  ) {
    if (secret.length < 32) throw new Error("HYDRATRACE_JOB_SHARED_SECRET must contain at least 32 characters");
  }

  verify(headers: Record<string, string | string[] | undefined>, rawBody: string): string {
    const timestamp = singleHeader(headers["x-hydratrace-timestamp"]);
    const requestId = singleHeader(headers["x-hydratrace-request-id"]);
    const signature = singleHeader(headers["x-hydratrace-signature"]);
    if (timestamp === undefined || requestId === undefined || signature === undefined) {
      throw new Error("Signed job headers are required");
    }
    if (!/^\d+$/u.test(timestamp) || !/^[A-Za-z0-9_.:-]{8,256}$/u.test(requestId)) {
      throw new Error("Signed job headers are malformed");
    }
    const now = this.now();
    const timestampMs = Number(timestamp);
    if (!Number.isSafeInteger(timestampMs) || Math.abs(now - timestampMs) > this.maximumAgeMs) {
      throw new Error("Signed job timestamp is outside the five-minute window");
    }
    for (const [id, expiresAt] of this.#seen) if (expiresAt < now) this.#seen.delete(id);
    if (this.#seen.has(requestId)) throw new Error("Signed job request ID was already used");
    const expected = signHydraTraceRequest(this.secret, timestamp, requestId, rawBody);
    if (!safeEqualHex(expected, signature)) throw new Error("Signed job signature is invalid");
    this.#seen.set(requestId, now + this.maximumAgeMs);
    return requestId;
  }
}

export function signHydraTraceRequest(
  secret: string,
  timestamp: string,
  requestId: string,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${requestId}.${rawBody}`, "utf8")
    .digest("hex");
}

export function registerSignedJobRoutes(
  application: FastifyInstance,
  execute: (
    input: ScanWorkflowInput,
    progress: (stage: ScanStage, message: string) => void,
  ) => Promise<unknown>,
  sharedSecret = process.env.HYDRATRACE_JOB_SHARED_SECRET,
  statusStore: JobStatusStore = jobStatusStoreFromEnvironment(),
): void {
  const verifier = sharedSecret === undefined ? undefined : new SignedRequestVerifier(sharedSecret);
  const running = new Set<string>();

  application.post("/v1/internal/jobs/dispatch", {
    bodyLimit: 15_500_000,
    config: { rawBody: true },
  }, async (request, reply) => {
    if (verifier === undefined) return reply.code(503).send({ error: "SIGNED_DISPATCH_NOT_CONFIGURED" });
    const rawBody = rawRequestBody(request);
    try { verifier.verify(request.headers, rawBody); }
    catch (error) { return reply.code(401).send({ error: "INVALID_SIGNATURE", message: error instanceof Error ? error.message : "Signature validation failed" }); }
    const parsed = dispatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_JOB_DISPATCH" });
    const existing = await statusStore.get(parsed.data.idempotencyKey);
    if (existing?.state === "COMPLETE" || running.has(parsed.data.idempotencyKey)) {
      return reply.code(200).send(existing);
    }
    const engineJobId = stableIdFromCanonicalKey(`engine-job:${parsed.data.idempotencyKey}`);
    const job: DurableJobStatus = {
      jobId: parsed.data.jobId,
      idempotencyKey: parsed.data.idempotencyKey,
      engineJobId,
      state: "ACKNOWLEDGED",
      checkpointStage: existing?.checkpointStage ?? "ACKNOWLEDGED",
      updatedAt: Date.now(),
    };
    await statusStore.put(job);
    running.add(job.idempotencyKey);
    const execution = executeDispatchedJob(
      job,
      parsed.data.scan,
      parsed.data.callbackUrl,
      execute,
      verifier.secret,
      statusStore,
    ).finally(() => running.delete(job.idempotencyKey));
    // Vercel may freeze a function as soon as its response is returned. Await
    // bounded work there so progress/final callbacks cannot be abandoned.
    if (process.env.VERCEL === "1") await execution;
    else void execution;
    return reply.code(202).send(job);
  });

  application.get("/v1/internal/jobs/:idempotencyKey", async (request, reply) => {
    if (verifier === undefined) return reply.code(503).send({ error: "SIGNED_DISPATCH_NOT_CONFIGURED" });
    try { verifier.verify(request.headers, ""); }
    catch (error) { return reply.code(401).send({ error: "INVALID_SIGNATURE", message: error instanceof Error ? error.message : "Signature validation failed" }); }
    const parsed = z.object({ idempotencyKey: z.string().regex(/^[0-9a-f]{64}$/u) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_IDEMPOTENCY_KEY" });
    const job = await statusStore.get(parsed.data.idempotencyKey);
    return job === undefined ? reply.code(404).send({ error: "ENGINE_JOB_NOT_FOUND" }) : structuredClone(job);
  });
}

async function executeDispatchedJob(
  job: DurableJobStatus,
  scan: ScanWorkflowInput,
  callbackUrl: string,
  execute: (input: ScanWorkflowInput, progress: (stage: ScanStage, message: string) => void) => Promise<unknown>,
  secret: string,
  statusStore: JobStatusStore,
): Promise<void> {
  let callbackChain = Promise.resolve();
  const enqueueCallback = (payload: Record<string, unknown>): void => {
    const checkpoint = structuredClone(job);
    callbackChain = callbackChain
      .catch(() => undefined)
      .then(async () => {
        await statusStore.put(checkpoint);
        await sendCallback(callbackUrl, secret, payload);
      });
  };
  const progress = (stage: ScanStage, message: string): void => {
    job.state = stage;
    job.checkpointStage = stage;
    job.updatedAt = Date.now();
    enqueueCallback({ jobId: job.jobId, engineJobId: job.engineJobId, stage, message, at: job.updatedAt });
  };
  enqueueCallback({
    jobId: job.jobId,
    engineJobId: job.engineJobId,
    stage: "ACKNOWLEDGED",
    message: "Engine acknowledged the job",
    at: job.updatedAt,
  });
  try {
    const result = await execute(scan, progress);
    job.result = result;
    job.state = "COMPLETE";
    job.checkpointStage = "COMPLETE";
    job.updatedAt = Date.now();
    enqueueCallback({
      jobId: job.jobId,
      engineJobId: job.engineJobId,
      stage: "COMPLETE",
      message: "Engine job completed",
      at: job.updatedAt,
      result,
    });
  } catch (error) {
    job.error = error instanceof Error ? error.message : "Unknown engine job failure";
    job.state = "FAILED";
    job.checkpointStage = "FAILED";
    job.updatedAt = Date.now();
    enqueueCallback({
      jobId: job.jobId,
      engineJobId: job.engineJobId,
      stage: "FAILED",
      message: job.error,
      at: job.updatedAt,
      error: job.error,
    });
  }
  await callbackChain.catch(async () => statusStore.put(structuredClone(job)));
}

async function sendCallback(
  callbackUrl: string,
  secret: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const requestId = `callback:${payload.engineJobId}:${payload.stage}:${timestamp}`;
  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hydratrace-timestamp": timestamp,
      "x-hydratrace-request-id": requestId,
      "x-hydratrace-signature": signHydraTraceRequest(secret, timestamp, requestId, body),
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Convex progress callback returned HTTP ${response.status}`);
}

function rawRequestBody(request: FastifyRequest): string {
  const value = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
  if (value === undefined) throw new Error("Raw request body was not captured");
  return value.toString("utf8");
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/iu.test(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
