import { internalMutation } from "./_generated/server.js";
import { v } from "convex/values";

const stages = new Set([
  "ACKNOWLEDGED", "ACQUIRING", "PARSING", "ENRICHING", "WRITING_GRAPH",
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
    const now = Date.now();
    await ctx.db.insert("callbackRequests", {
      requestId: args.requestId,
      receivedAt: now,
      expiresAt: now + 10 * 60 * 1_000,
    });
    const terminal = args.stage === "COMPLETE" || args.stage === "FAILED" || args.stage === "CANCELED";
    await ctx.db.patch(args.jobId, {
      status: args.stage,
      engineJobId: args.engineJobId,
      heartbeatAt: args.at,
      ...(terminal ? { completedAt: args.at } : {}),
      ...(args.error === undefined ? {} : { lastError: args.error }),
    });
    await ctx.db.patch(job.scanId, {
      stage: args.stage,
      currentStage: args.stage,
      progress: stageProgress(args.stage),
      lastHeartbeatAt: args.at,
      updatedAt: args.at,
      ...(args.result === undefined ? {} : { result: args.result }),
      ...(args.error === undefined ? {} : { error: args.error }),
    });
    const scanEvents = await ctx.db.query("scanEvents")
      .withIndex("by_scan_sequence", (q) => q.eq("scanId", job.scanId))
      .collect();
    await ctx.db.insert("scanEvents", {
      scanId: job.scanId,
      sequence: scanEvents.length,
      stage: args.stage,
      at: args.at,
      message: args.message,
    });
    const jobEvents = await ctx.db.query("jobEvents")
      .withIndex("by_job_sequence", (q) => q.eq("jobId", args.jobId))
      .collect();
    await ctx.db.insert("jobEvents", {
      jobId: args.jobId,
      sequence: jobEvents.length,
      state: args.stage,
      message: args.message,
      at: args.at,
      traceId: job.idempotencyKey ?? String(args.jobId),
    });
    await ctx.db.insert("auditEvents", {
      actor: "hydratrace-engine",
      action: "job.progress",
      targetType: "job",
      targetId: String(args.jobId),
      traceId: job.idempotencyKey ?? String(args.jobId),
      metadata: { stage: args.stage, engineJobId: args.engineJobId },
      at: args.at,
    });
    return true;
  },
});

function stageProgress(stage: string): number {
  const order = [
    "QUEUED", "DISPATCHING", "ACKNOWLEDGED", "ACQUIRING", "PARSING",
    "ENRICHING", "WRITING_GRAPH", "INDEXING", "WAITING_FOR_INDEX", "ANALYZING", "COMPLETE",
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

