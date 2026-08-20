import { internalMutation, query } from "./_generated/server.js";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";

export const schedule = internalMutation({
  args: {
    stableId: v.string(),
    idempotencyKey: v.string(),
    repositoryId: v.string(),
    commitSha: v.string(),
    storageId: v.id("_storage"),
    fileName: v.string(),
    contentType: v.string(),
    byteLength: v.number(),
    sha256: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("scans")
      .withIndex("by_idempotency", (q) => q.eq("idempotencyKey", args.idempotencyKey))
      .unique();
    if (existing !== null) {
      const existingUpload = existing.uploadId === undefined ? null : await ctx.db.get(existing.uploadId);
      return {
        scanId: existing._id,
        created: false,
        discardStorage: existingUpload?.storageId !== args.storageId,
      };
    }
    if (args.byteLength < 1 || args.byteLength > 15_000_000) {
      throw new Error("Upload exceeds the 15 MB durable-envelope limit");
    }
    if (!/^[0-9a-f]{64}$/u.test(args.sha256)) throw new Error("Upload SHA-256 is invalid");
    const now = Date.now();
    const uploadId = await ctx.db.insert("uploads", {
      storageId: args.storageId,
      fileName: args.fileName,
      contentType: args.contentType,
      byteLength: args.byteLength,
      sha256: args.sha256,
      createdAt: now,
      expiresAt: now + 24 * 60 * 60 * 1_000,
    });
    const scanId = await ctx.db.insert("scans", {
      stableId: args.stableId,
      idempotencyKey: args.idempotencyKey,
      repositoryId: args.repositoryId,
      commitSha: args.commitSha,
      stage: "QUEUED",
      currentStage: "QUEUED",
      progress: 0,
      attempt: 0,
      uploadId,
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
      dispatchPayload: { encoding: "scan-input-json-v1" },
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
    return { scanId, jobId, created: true, discardStorage: false };
  },
});

export const get = query({ args: { stableId: v.string() }, handler: (ctx, args) => ctx.db.query("scans").withIndex("by_stable_id", (q) => q.eq("stableId", args.stableId)).unique() });
export const events = query({ args: { scanId: v.id("scans") }, handler: (ctx, args) => ctx.db.query("scanEvents").withIndex("by_scan_sequence", (q) => q.eq("scanId", args.scanId)).collect() });
export const cancel = internalMutation({
  args: { scanId: v.id("scans") },
  handler: async (ctx, args) => {
    const scan = await ctx.db.get(args.scanId);
    if (scan === null) throw new Error("Scan not found");
    if (["COMPLETE", "FAILED", "CANCELED", "CANCELLED"].includes(scan.stage)) return false;
    const now = Date.now();
    const job = await ctx.db.query("jobs")
      .withIndex("by_scan", (q) => q.eq("scanId", args.scanId))
      .first();
    if (job?.scheduledFunctionId !== undefined) {
      await ctx.scheduler.cancel(job.scheduledFunctionId);
    }
    if (job !== null) {
      await ctx.db.patch(job._id, {
        status: "CANCELLED",
        canceledAt: now,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
      });
      const jobEvents = await ctx.db.query("jobEvents")
        .withIndex("by_job_sequence", (q) => q.eq("jobId", job._id))
        .collect();
      await ctx.db.insert("jobEvents", {
        jobId: job._id,
        sequence: jobEvents.length,
        state: "CANCELLED",
        message: "Job canceled by user",
        at: now,
        traceId: job.idempotencyKey ?? String(job._id),
      });
    }
    const scanEvents = await ctx.db.query("scanEvents")
      .withIndex("by_scan_sequence", (q) => q.eq("scanId", args.scanId))
      .collect();
    await ctx.db.patch(args.scanId, {
      stage: "CANCELED",
      currentStage: "CANCELED",
      progress: 100,
      canceledAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("scanEvents", {
      scanId: args.scanId,
      sequence: scanEvents.length,
      stage: "CANCELED",
      at: now,
      message: "Scan canceled by user",
    });
    return true;
  },
});
