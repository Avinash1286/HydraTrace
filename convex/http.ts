import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";

const http = httpRouter();

http.route({
  path: "/callbacks/progress",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.HYDRATRACE_JOB_SHARED_SECRET;
    if (secret === undefined || secret.length < 32) return json({ error: "CALLBACK_NOT_CONFIGURED" }, 503);
    const body = await request.text();
    const timestamp = request.headers.get("x-hydratrace-timestamp");
    const requestId = request.headers.get("x-hydratrace-request-id");
    const signature = request.headers.get("x-hydratrace-signature");
    if (timestamp === null || requestId === null || signature === null) return json({ error: "MISSING_SIGNATURE" }, 401);
    const timestampMs = Number(timestamp);
    if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > 300_000) {
      return json({ error: "STALE_SIGNATURE" }, 401);
    }
    const expected = await sign(secret, timestamp, requestId, body);
    if (!constantTimeEqual(expected, signature)) return json({ error: "INVALID_SIGNATURE" }, 401);
    let value: Record<string, unknown>;
    try { value = JSON.parse(body) as Record<string, unknown>; }
    catch { return json({ error: "INVALID_JSON" }, 400); }
    if (
      typeof value.jobId !== "string" ||
      typeof value.engineJobId !== "string" ||
      typeof value.stage !== "string" ||
      typeof value.message !== "string" ||
      typeof value.at !== "number"
    ) return json({ error: "INVALID_CALLBACK" }, 400);
    try {
      const accepted = await ctx.runMutation(internal.callbacks.progress, {
        requestId,
        jobId: value.jobId as Id<"jobs">,
        engineJobId: value.engineJobId,
        stage: value.stage,
        message: value.message,
        at: value.at,
        ...(value.result === undefined ? {} : { result: value.result }),
        ...(typeof value.error === "string" ? { error: value.error } : {}),
      });
      return json({ accepted }, 200);
    } catch (error) {
      return json({ error: "CALLBACK_REJECTED", message: error instanceof Error ? error.message : "Unknown callback failure" }, 400);
    }
  }),
});

export default http;

async function sign(secret: string, timestamp: string, requestId: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${requestId}.${body}`));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

