import { mutation, query } from "./_generated/server.js";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";

export const schedule = mutation({
  args: {
    stableId: v.string(),
    idempotencyKey: v.string(),
    repositoryId: v.string(),
    commitSha: v.string(),
    uploadId: v.id("uploads"),
    sourceRef: v.string(),
    observedAt: v.number(),
    deploymentManifest: v.optional(v.string()),
    callbackUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("scans")
      .withIndex("by_idempotency", (q) => q.eq("idempotencyKey", args.idempotencyKey))
      .unique();
    if (existing !== null) return { scanId: existing._id, created: false };
    const upload = await ctx.db.get(args.uploadId);
    if (upload === null || upload.expiresAt < Date.now()) throw new Error("Scan upload was not found or has expired");
    const now = Date.now();
    const scanId = await ctx.db.insert("scans", {
      stableId: args.stableId,
      idempotencyKey: args.idempotencyKey,
      repositoryId: args.repositoryId,
      commitSha: args.commitSha,
      stage: "QUEUED",
      currentStage: "QUEUED",
      progress: 0,
      attempt: 0,
      uploadId: args.uploadId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("scanEvents", { scanId, sequence: 0, stage: "QUEUED", at: now, message: "Scan accepted by durable scheduler" });
    const jobId = await ctx.db.insert("jobs", {
      scanId,
      type: "repository_scan",
      status: "QUEUED",
      attempt: 0,
      availableAt: now,
      signature: "hmac-sha256",
      idempotencyKey: args.idempotencyKey,
      callbackUrl: args.callbackUrl,
      dispatchPayload: {
        sourceRef: args.sourceRef,
        repositoryId: args.repositoryId,
        commitSha: args.commitSha,
        observedAt: args.observedAt,
        ...(args.deploymentManifest === undefined ? {} : { deploymentManifest: args.deploymentManifest }),
      },
    });
    await ctx.db.insert("jobEvents", { jobId, sequence: 0, state: "QUEUED", message: "Job queued", at: now, traceId: args.idempotencyKey });
    const scheduledFunctionId = await ctx.scheduler.runAfter(0, internal.scheduler.dispatchJob, { jobId });
    await ctx.db.patch(jobId, { scheduledFunctionId });
    await ctx.db.insert("auditEvents", {
      actor: "user",
      action: "scan.schedule",
      targetType: "scan",
      targetId: args.stableId,
      traceId: args.idempotencyKey,
      at: now,
    });
    return { scanId, jobId, created: true };
  },
});

export const create = mutation({
  args: { stableId: v.string(), idempotencyKey: v.string(), repositoryId: v.string(), commitSha: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("scans").withIndex("by_idempotency", (q) => q.eq("idempotencyKey", args.idempotencyKey)).unique();
    if (existing !== null) return existing._id;
    const now = Date.now();
    const scanId = await ctx.db.insert("scans", { ...args, stage: "QUEUED", attempt: 1, createdAt: now, updatedAt: now });
    await ctx.db.insert("scanEvents", { scanId, sequence: 0, stage: "QUEUED", at: now, message: "Scan accepted" });
    return scanId;
  },
});

export const get = query({ args: { stableId: v.string() }, handler: (ctx, args) => ctx.db.query("scans").withIndex("by_stable_id", (q) => q.eq("stableId", args.stableId)).unique() });
export const events = query({ args: { scanId: v.id("scans") }, handler: (ctx, args) => ctx.db.query("scanEvents").withIndex("by_scan_sequence", (q) => q.eq("scanId", args.scanId)).collect() });
export const cancel = mutation({ args: { scanId: v.id("scans") }, handler: async (ctx, args) => { const scan = await ctx.db.get(args.scanId); if (scan === null) throw new Error("Scan not found"); if (["COMPLETE", "FAILED", "CANCELED"].includes(scan.stage)) return false; const now = Date.now(); await ctx.db.patch(args.scanId, { stage: "CANCELED", canceledAt: now, updatedAt: now }); return true; } });

export const progress = mutation({
  args: {
    scanId: v.id("scans"),
    stage: v.string(),
    message: v.string(),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scan = await ctx.db.get(args.scanId);
    if (scan === null) throw new Error("Scan not found");
    const events = await ctx.db
      .query("scanEvents")
      .withIndex("by_scan_sequence", (q) => q.eq("scanId", args.scanId))
      .collect();
    const now = Date.now();
    await ctx.db.patch(args.scanId, {
      stage: args.stage,
      updatedAt: now,
      ...(args.result === undefined ? {} : { result: args.result }),
      ...(args.error === undefined ? {} : { error: args.error }),
    });
    await ctx.db.insert("scanEvents", {
      scanId: args.scanId,
      sequence: events.length,
      stage: args.stage,
      at: now,
      message: args.message,
    });
  },
});
