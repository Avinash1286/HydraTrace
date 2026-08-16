import { mutation, query } from "./_generated/server.js";
import { v } from "convex/values";

export const generateUploadUrl = mutation({
  args: {},
  handler: (ctx) => ctx.storage.generateUploadUrl(),
});

export const record = mutation({
  args: {
    storageId: v.id("_storage"),
    fileName: v.string(),
    contentType: v.string(),
    byteLength: v.number(),
    sha256: v.string(),
    repositoryId: v.optional(v.id("repositories")),
  },
  handler: async (ctx, args) => {
    if (args.byteLength < 1 || args.byteLength > 8_000_000) throw new Error("Upload exceeds the 8 MB limit");
    if (!/^[0-9a-f]{64}$/u.test(args.sha256)) throw new Error("Upload SHA-256 is invalid");
    return ctx.db.insert("uploads", {
      ...args,
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
    });
  },
});

export const get = query({
  args: { uploadId: v.id("uploads") },
  handler: (ctx, args) => ctx.db.get(args.uploadId),
});

