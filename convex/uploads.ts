import { internalMutation, internalQuery } from "./_generated/server.js";
import { v } from "convex/values";

export const generateUploadUrl = internalMutation({
  args: {},
  handler: (ctx) => ctx.storage.generateUploadUrl(),
});

export const deleteExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.db.query("uploads")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", Date.now()))
      .take(100);
    for (const upload of expired) {
      await ctx.storage.delete(upload.storageId);
      await ctx.db.delete(upload._id);
    }
    return expired.length;
  },
});

export const isStorageRecorded = internalQuery({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => (await ctx.db.query("uploads")
    .withIndex("by_storage_id", (q) => q.eq("storageId", args.storageId))
    .first()) !== null,
});
