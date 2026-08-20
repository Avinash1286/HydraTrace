import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import { v } from "convex/values";

const RETRY_DELAYS_MS = [0, 10_000, 30_000, 120_000, 300_000] as const;

const stages = new Set([
  "ACKNOWLEDGED", "ACQUIRING", "PARSING", "WRITING_GRAPH", "ENRICHING",
  "INDEXING", "WAITING_FOR_INDEX", "ANALYZING", "COMPLETE", "FAILED", "CANCELED",
]);

export const progress = internalMutation({
  args: {
    requestId: v.string(),
    jobId: v.id("jobs"),
    engineJobId: v.string(),
    stage: v.string(),
    message: v.string(),
    at: v.number(),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!stages.has(args.stage)) throw new Error("Unknown engine progress stage");
    const replay = await ctx.db.query("callbackRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (replay !== null) return false;
    const job = await ctx.db.get(args.jobId);
    if (job === null) throw new Error("Unknown job ID");
    if (["COMPLETE", "FAILED", "CANCELED", "CANCELLED"].includes(job.status)) return false;
    if (job.engineJobId !== undefined && job.engineJobId !== args.engineJobId) {
      throw new Error("Engine job ID does not match the active attempt");
    }
    const now = Date.now();
    await ctx.db.insert("callbackRequests", {
      requestId: args.requestId,
      receivedAt: now,
      expiresAt: now + 10 * 60 * 1_000,
    });
    const retryFailure = args.stage === "FAILED" && job.attempt < RETRY_DELAYS_MS.length;
    const persistedStage = retryFailure ? "RETRY_WAIT" : args.stage;
    const retryDelay = retryFailure ? RETRY_DELAYS_MS[job.attempt]! : 0;
    const terminal = persistedStage === "COMPLETE" || persistedStage === "FAILED" || persistedStage === "CANCELED";
    await ctx.db.patch(args.jobId, {
      status: persistedStage,
      engineJobId: args.engineJobId,
      heartbeatAt: args.at,
      ...(retryFailure ? {
        availableAt: now + retryDelay,
        nextRetryAt: now + retryDelay,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
      } : {}),
      ...(terminal ? { completedAt: args.at } : {}),
      ...(args.error === undefined ? {} : { lastError: args.error }),
    });
    await ctx.db.patch(job.scanId, {
      stage: persistedStage,
      currentStage: persistedStage,
      progress: stageProgress(persistedStage),
      lastHeartbeatAt: args.at,
      updatedAt: args.at,
      ...(args.result === undefined ? {} : { result: args.result }),
      ...(args.error === undefined ? {} : { error: args.error }),
    });
    const scanEvents = await ctx.db.query("scanEvents")
      .withIndex("by_scan_sequence", (q) => q.eq("scanId", job.scanId))
      .collect();
    const scanDispatchSequence = scanEvents.reduce(
      (latest, event) => event.stage === "DISPATCHING"
        ? Math.max(latest, event.sequence)
        : latest,
      -1,
    );
    const existingScanAcknowledgement = persistedStage === "ACKNOWLEDGED"
      ? scanEvents.find((event) =>
        event.stage === "ACKNOWLEDGED" && event.sequence > scanDispatchSequence)
      : undefined;
    if (existingScanAcknowledgement === undefined) {
      await ctx.db.insert("scanEvents", {
        scanId: job.scanId,
        sequence: scanEvents.length,
        stage: persistedStage,
        at: args.at,
        message: retryFailure ? `${args.message}; retry scheduled` : args.message,
      });
    } else if (args.at < existingScanAcknowledgement.at) {
      // The dispatch action and the engine callback can acknowledge the same
      // attempt concurrently. Keep one event at the engine's earlier time so
      // the following progress callback cannot make the timeline run backward.
      await ctx.db.patch(existingScanAcknowledgement._id, { at: args.at });
    }
    const jobEvents = await ctx.db.query("jobEvents")
      .withIndex("by_job_sequence", (q) => q.eq("jobId", args.jobId))
      .collect();
    const jobDispatchSequence = jobEvents.reduce(
      (latest, event) => event.state === "DISPATCHING"
        ? Math.max(latest, event.sequence)
        : latest,
      -1,
    );
    const existingJobAcknowledgement = persistedStage === "ACKNOWLEDGED"
      ? jobEvents.find((event) =>
        event.state === "ACKNOWLEDGED" && event.sequence > jobDispatchSequence)
      : undefined;
    if (existingJobAcknowledgement === undefined) {
      await ctx.db.insert("jobEvents", {
        jobId: args.jobId,
        sequence: jobEvents.length,
        state: persistedStage,
        message: retryFailure ? `${args.message}; retry scheduled` : args.message,
        at: args.at,
        traceId: job.idempotencyKey ?? String(args.jobId),
      });
    } else if (args.at < existingJobAcknowledgement.at) {
      await ctx.db.patch(existingJobAcknowledgement._id, { at: args.at });
    }
    await ctx.db.insert("auditEvents", {
      actor: "hydratrace-engine",
      action: "job.progress",
      targetType: "job",
      targetId: String(args.jobId),
      traceId: job.idempotencyKey ?? String(args.jobId),
      metadata: { stage: persistedStage, engineJobId: args.engineJobId },
      at: args.at,
    });
    if (retryFailure) {
      const scheduledFunctionId = await ctx.scheduler.runAfter(
        retryDelay,
        internal.scheduler.dispatchJob,
        { jobId: args.jobId },
      );
      await ctx.db.patch(args.jobId, { scheduledFunctionId });
    }
    return true;
  },
});

function stageProgress(stage: string): number {
  const order = [
    "QUEUED", "DISPATCHING", "ACKNOWLEDGED", "ACQUIRING", "PARSING",
    "WRITING_GRAPH", "ENRICHING", "INDEXING", "WAITING_FOR_INDEX", "ANALYZING", "COMPLETE",
  ];
  const index = order.indexOf(stage);
  return stage === "FAILED" || stage === "CANCELED" ? 100 : Math.round(Math.max(0, index) / (order.length - 1) * 100);
}

export const deleteExpiredReplayKeys = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db.query("callbackRequests")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", Date.now()))
      .take(1_000);
    await Promise.all(expired.map(({ _id }) => ctx.db.delete(_id)));
    return expired.length;
  },
});

export const claimRequest = internalMutation({
  args: { requestId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("callbackRequests")
      .withIndex("by_request_id", (q) => q.eq("requestId", args.requestId))
      .unique();
    if (existing !== null) return false;
    const now = Date.now();
    await ctx.db.insert("callbackRequests", {
      requestId: args.requestId,
      receivedAt: now,
      expiresAt: now + 10 * 60 * 1_000,
    });
    return true;
  },
});
