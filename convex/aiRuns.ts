import { mutation, query } from "./_generated/server.js";
import { v } from "convex/values";

export const cached = query({ args: { evidenceHash: v.string(), promptVersion: v.string() }, handler: (ctx, args) => ctx.db.query("aiRuns").withIndex("by_evidence_prompt", (q) => q.eq("evidenceHash", args.evidenceHash).eq("promptVersion", args.promptVersion)).filter((q) => q.eq(q.field("status"), "COMPLETE")).first() });
export const record = mutation({ args: { incidentId: v.id("incidents"), evidenceHash: v.string(), promptVersion: v.string(), provider: v.string(), status: v.string(), latencyMs: v.optional(v.number()), evidenceRefs: v.array(v.string()), output: v.optional(v.any()), error: v.optional(v.string()) }, handler: (ctx, args) => ctx.db.insert("aiRuns", { ...args, createdAt: Date.now() }) });
