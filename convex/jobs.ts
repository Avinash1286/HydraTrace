import { internal } from "./_generated/api.js";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import { v } from "convex/values";

const RETRY_DELAYS_MS = [0, 10_000, 30_000, 120_000, 300_000] as const;
const terminalStates = new Set(["COMPLETE", "FAILED", "CANCELLED"]);

export const enqueue = mutation({
  args: {
    scanId: v.id("scans"),
    type: v.string(),
    idempotencyKey: v.string(),
    dispatchPayload: v.any(),
    callbackUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("jobs").withIndex("by_scan", (q) => q.eq("scanId", args.scanId)).first();
    if (existing !== null && !terminalStates.has(existing.status)) return existing._id;
    const now = Date.now();
    const jobId = await ctx.db.insert("jobs", {
      scanId: args.scanId,
      type: args.type,
      status: "QUEUED",
      attempt: 0,
      availableAt: now,
      signature: "hmac-sha256",
      idempotencyKey: args.idempotencyKey,
      dispatchPayload: args.dispatchPayload,
      callbackUrl: args.callbackUrl,
    });
    await appendEvent(ctx, jobId, "QUEUED", "Job queued", args.idempotencyKey);
    const scheduledFunctionId = await ctx.scheduler.runAfter(0, internal.scheduler.dispatchJob, { jobId });
    await ctx.db.patch(jobId, { scheduledFunctionId });
    return jobId;
  },
});

export const pending = query({
  args: {},
  handler: (ctx) => ctx.db.query("jobs")
    .withIndex("by_status_available", (q) => q.eq("status", "QUEUED"))
    .filter((q) => q.lte(q.field("availableAt"), Date.now()))
    .take(100),
});

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
    });
    const attemptId = await ctx.db.insert("jobAttempts", {
      jobId: args.jobId,
      attempt,
      state: "DISPATCHING",
      requestId: args.requestId,
      startedAt: now,
    });
    await appendEvent(ctx, args.jobId, "DISPATCHING", `Dispatch attempt ${attempt}`, job.idempotencyKey ?? String(args.jobId));
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
    await appendEvent(ctx, args.jobId, "ACKNOWLEDGED", "Engine acknowledged the job", job.idempotencyKey ?? String(args.jobId));
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
    await appendEvent(ctx, args.jobId, retry ? "RETRY_WAIT" : "FAILED", args.error, job.idempotencyKey ?? String(args.jobId));
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
      updatedAt: now,
      ...(args.result === undefined ? {} : { result: args.result }),
    });
    await appendEvent(ctx, args.jobId, "COMPLETE", "Recovered completed engine job without duplicate ingestion", job.idempotencyKey ?? String(args.jobId));
    return true;
  },
});

export const cancel = mutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (job === null || terminalStates.has(job.status)) return false;
    const now = Date.now();
    if (job.scheduledFunctionId !== undefined) await ctx.scheduler.cancel(job.scheduledFunctionId);
    await ctx.db.patch(args.jobId, { status: "CANCELLED", canceledAt: now, leaseOwner: undefined, leaseExpiresAt: undefined });
    await ctx.db.patch(job.scanId, { stage: "CANCELED", canceledAt: now, updatedAt: now });
    await appendEvent(ctx, args.jobId, "CANCELLED", "Job canceled by user", job.idempotencyKey ?? String(args.jobId));
    return true;
  },
});

export const reclaimExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const candidates = await ctx.db.query("jobs")
      .filter((q) => q.or(q.eq(q.field("status"), "DISPATCHING"), q.eq(q.field("status"), "ACKNOWLEDGED")))
      .collect();
    const now = Date.now();
    let reclaimed = 0;
    for (const job of candidates) {
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
      await appendEvent(ctx, job._id, retry ? "RETRY_WAIT" : "FAILED", "Engine heartbeat expired", job.idempotencyKey ?? String(job._id));
      if (retry) {
        const scheduledFunctionId = await ctx.scheduler.runAfter(delay, internal.scheduler.dispatchJob, { jobId: job._id });
        await ctx.db.patch(job._id, { scheduledFunctionId });
      }
      reclaimed += 1;
    }
    return reclaimed;
  },
});

async function appendEvent(ctx: any, jobId: any, state: string, message: string, traceId: string): Promise<void> {
  const events = await ctx.db.query("jobEvents").withIndex("by_job_sequence", (q: any) => q.eq("jobId", jobId)).collect();
  await ctx.db.insert("jobEvents", { jobId, sequence: events.length, state, message, at: Date.now(), traceId });
}
