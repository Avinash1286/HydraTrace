import { internal } from "./_generated/api.js";
import { internalMutation, internalQuery } from "./_generated/server.js";
import { v } from "convex/values";

const RETRY_DELAYS_MS = [0, 10_000, 30_000, 120_000, 300_000] as const;
const terminalStates = new Set(["COMPLETE", "FAILED", "CANCELED", "CANCELLED"]);

export const getForDispatch = internalQuery({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null) return null;
    const scan = await ctx.db.get(job.scanId);
    const upload = scan?.uploadId === undefined ? null : await ctx.db.get(scan.uploadId);
    return { job, scan, upload };
  },
});

export const startAttempt = internalMutation({
  args: { jobId: v.id("jobs"), requestId: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    const now = Date.now();
    if (job === null || !["QUEUED", "RETRY_WAIT"].includes(job.status) || job.availableAt > now) return null;
    if (job.attempt >= RETRY_DELAYS_MS.length) return null;
    const attempt = job.attempt + 1;
    await ctx.db.patch(args.jobId, {
      status: "DISPATCHING",
      attempt,
      requestId: args.requestId,
      leaseOwner: "convex-dispatch",
      leaseExpiresAt: now + 120_000,
      heartbeatAt: now,
      lastError: undefined,
      nextRetryAt: undefined,
    });
    const attemptId = await ctx.db.insert("jobAttempts", {
      jobId: args.jobId,
      attempt,
      state: "DISPATCHING",
      requestId: args.requestId,
      startedAt: now,
    });
    await ctx.db.patch(job.scanId, {
      stage: "DISPATCHING",
      currentStage: "DISPATCHING",
      attempt,
      updatedAt: now,
      lastHeartbeatAt: now,
      error: undefined,
    });
    await appendEvent(
      ctx,
      args.jobId,
      "DISPATCHING",
      `Dispatch attempt ${attempt}`,
      job.idempotencyKey ?? String(args.jobId),
      now,
    );
    await appendScanEvent(ctx, job.scanId, "DISPATCHING", `Dispatch attempt ${attempt}`, now);
    return { attempt, attemptId };
  },
});

export const acknowledge = internalMutation({
  args: { jobId: v.id("jobs"), attemptId: v.id("jobAttempts"), engineJobId: v.string(), statusCode: v.number() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || job.status !== "DISPATCHING") return false;
    const now = Date.now();
    await ctx.db.patch(args.jobId, {
      status: "ACKNOWLEDGED",
      engineJobId: args.engineJobId,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      heartbeatAt: now,
    });
    await ctx.db.patch(args.attemptId, { state: "ACKNOWLEDGED", statusCode: args.statusCode, completedAt: now });
    await ctx.db.patch(job.scanId, {
      stage: "ACKNOWLEDGED",
      currentStage: "ACKNOWLEDGED",
      attempt: job.attempt,
      updatedAt: now,
      lastHeartbeatAt: now,
    });
    await appendEvent(
      ctx,
      args.jobId,
      "ACKNOWLEDGED",
      "Engine acknowledged the job",
      job.idempotencyKey ?? String(args.jobId),
      now,
    );
    await appendScanEvent(ctx, job.scanId, "ACKNOWLEDGED", "Engine acknowledged the job", now);
    return true;
  },
});

export const failAttempt = internalMutation({
  args: { jobId: v.id("jobs"), attemptId: v.optional(v.id("jobAttempts")), error: v.string(), statusCode: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || terminalStates.has(job.status)) return false;
    const now = Date.now();
    const retry = job.attempt < RETRY_DELAYS_MS.length;
    const delay = retry ? RETRY_DELAYS_MS[job.attempt]! : 0;
    await ctx.db.patch(args.jobId, {
      status: retry ? "RETRY_WAIT" : "FAILED",
      availableAt: now + delay,
      nextRetryAt: retry ? now + delay : undefined,
      lastError: args.error,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    });
    if (args.attemptId !== undefined) {
      await ctx.db.patch(args.attemptId, {
        state: retry ? "RETRY_WAIT" : "FAILED",
        completedAt: now,
        error: args.error,
        ...(args.statusCode === undefined ? {} : { statusCode: args.statusCode }),
      });
    }
    await appendEvent(
      ctx,
      args.jobId,
      retry ? "RETRY_WAIT" : "FAILED",
      args.error,
      job.idempotencyKey ?? String(args.jobId),
      now,
    );
    await ctx.db.patch(job.scanId, {
      stage: retry ? "RETRY_WAIT" : "FAILED",
      currentStage: retry ? "RETRY_WAIT" : "FAILED",
      progress: retry ? 0 : 100,
      attempt: job.attempt,
      updatedAt: now,
      error: args.error,
    });
    await appendScanEvent(ctx, job.scanId, retry ? "RETRY_WAIT" : "FAILED", args.error, now);
    if (retry) {
      const scheduledFunctionId = await ctx.scheduler.runAfter(delay, internal.scheduler.dispatchJob, { jobId: args.jobId });
      await ctx.db.patch(args.jobId, { scheduledFunctionId });
    }
    return retry;
  },
});

export const completeRecovered = internalMutation({
  args: {
    jobId: v.id("jobs"),
    attemptId: v.id("jobAttempts"),
    engineJobId: v.string(),
    result: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || terminalStates.has(job.status)) return false;
    const now = Date.now();
    await ctx.db.patch(args.jobId, {
      status: "COMPLETE",
      engineJobId: args.engineJobId,
      completedAt: now,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    });
    await ctx.db.patch(args.attemptId, { state: "COMPLETE", completedAt: now, statusCode: 200 });
    await ctx.db.patch(job.scanId, {
      stage: "COMPLETE",
      currentStage: "COMPLETE",
      progress: 100,
      updatedAt: now,
      ...(args.result === undefined ? {} : { result: args.result }),
    });
    await appendEvent(
      ctx,
      args.jobId,
      "COMPLETE",
      "Recovered completed engine job without duplicate ingestion",
      job.idempotencyKey ?? String(args.jobId),
      now,
    );
    await appendScanEvent(
      ctx,
      job.scanId,
      "COMPLETE",
      "Recovered completed engine job without duplicate ingestion",
      now,
    );
    return true;
  },
});

export const reclaimExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const candidates = await ctx.db.query("jobs").take(1_000);
    const now = Date.now();
    let reclaimed = 0;
    for (const job of candidates) {
      if (terminalStates.has(job.status) || ["QUEUED", "RETRY_WAIT"].includes(job.status)) continue;
      const heartbeatExpired = (job.heartbeatAt ?? 0) < now - 120_000;
      const leaseExpired = job.leaseExpiresAt !== undefined && job.leaseExpiresAt < now;
      if (!heartbeatExpired && !leaseExpired) continue;
      const retry = job.attempt < RETRY_DELAYS_MS.length;
      const delay = retry ? RETRY_DELAYS_MS[job.attempt]! : 0;
      await ctx.db.patch(job._id, {
        status: retry ? "RETRY_WAIT" : "FAILED",
        availableAt: now + delay,
        nextRetryAt: retry ? now + delay : undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastError: "Engine heartbeat expired",
      });
      await appendEvent(
        ctx,
        job._id,
        retry ? "RETRY_WAIT" : "FAILED",
        "Engine heartbeat expired",
        job.idempotencyKey ?? String(job._id),
        now,
      );
      await ctx.db.patch(job.scanId, {
        stage: retry ? "RETRY_WAIT" : "FAILED",
        currentStage: retry ? "RETRY_WAIT" : "FAILED",
        progress: retry ? 0 : 100,
        attempt: job.attempt,
        updatedAt: now,
        error: "Engine heartbeat expired",
      });
      await appendScanEvent(
        ctx,
        job.scanId,
        retry ? "RETRY_WAIT" : "FAILED",
        "Engine heartbeat expired",
        now,
      );
      if (retry) {
        const scheduledFunctionId = await ctx.scheduler.runAfter(delay, internal.scheduler.dispatchJob, { jobId: job._id });
        await ctx.db.patch(job._id, { scheduledFunctionId });
      }
      reclaimed += 1;
    }
    return reclaimed;
  },
});

async function appendEvent(
  ctx: any,
  jobId: any,
  state: string,
  message: string,
  traceId: string,
  at: number,
): Promise<void> {
  const events = await ctx.db.query("jobEvents").withIndex("by_job_sequence", (q: any) => q.eq("jobId", jobId)).collect();
  await ctx.db.insert("jobEvents", { jobId, sequence: events.length, state, message, at, traceId });
}

async function appendScanEvent(
  ctx: any,
  scanId: any,
  stage: string,
  message: string,
  at: number,
): Promise<void> {
  const events = await ctx.db.query("scanEvents").withIndex("by_scan_sequence", (q: any) => q.eq("scanId", scanId)).collect();
  await ctx.db.insert("scanEvents", { scanId, sequence: events.length, stage, message, at });
}
