import { mutation, query } from "./_generated/server.js";
import { v } from "convex/values";

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
