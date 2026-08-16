import { mutation, query } from "./_generated/server.js";
import { v } from "convex/values";

export const upsert = mutation({ args: { stableId: v.string(), packageName: v.string(), affectedVersions: v.array(v.string()), startsAt: v.optional(v.number()), endsAt: v.optional(v.number()) }, handler: async (ctx, args) => { const existing = await ctx.db.query("incidents").withIndex("by_stable_id", (q) => q.eq("stableId", args.stableId)).unique(); if (existing !== null) return existing._id; return ctx.db.insert("incidents", { ...args, createdAt: Date.now() }); } });
export const get = query({ args: { stableId: v.string() }, handler: (ctx, args) => ctx.db.query("incidents").withIndex("by_stable_id", (q) => q.eq("stableId", args.stableId)).unique() });
