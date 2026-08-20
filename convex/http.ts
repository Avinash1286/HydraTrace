import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";

const http = httpRouter();

http.route({
  path: "/scans/upload-url",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signed = await readSignedJson(request);
    if (signed instanceof Response) return signed;
    if (!(await claimSignedRequest(ctx, signed.requestId))) return json({ error: "REPLAYED_REQUEST" }, 409);
    try {
      const uploadUrl = await ctx.runMutation(internal.uploads.generateUploadUrl, {});
      return json({ uploadUrl }, 200);
    } catch (error) {
      return json({
        error: "UPLOAD_URL_FAILED",
        message: error instanceof Error ? error.message : "Unable to create a private upload URL",
      }, 500);
    }
  }),
});

http.route({
  path: "/scans/schedule",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signed = await readSignedJson(request);
    if (signed instanceof Response) return signed;
    if (!(await claimSignedRequest(ctx, signed.requestId))) return json({ error: "REPLAYED_REQUEST" }, 409);
    const value = signed.value;
    if (
      typeof value.storageId !== "string" ||
      typeof value.stableId !== "string" ||
      typeof value.idempotencyKey !== "string" ||
      typeof value.repositoryId !== "string" ||
      typeof value.commitSha !== "string" ||
      typeof value.fileName !== "string" ||
      typeof value.contentType !== "string" ||
      typeof value.byteLength !== "number" ||
      typeof value.sha256 !== "string" ||
      !/^\d+$/u.test(value.stableId) ||
      !/^[0-9a-f]{64}$/u.test(value.idempotencyKey) ||
      !/^[0-9a-f]{64}$/u.test(value.sha256) ||
      !Number.isSafeInteger(value.byteLength) ||
      value.byteLength < 1 ||
      value.byteLength > 15_000_000 ||
      value.repositoryId.length > 512 ||
      value.commitSha.length > 256 ||
      value.fileName !== "hydratrace-scan-input.json" ||
      value.contentType !== "application/json; charset=utf-8"
    ) return json({ error: "INVALID_SCAN_SCHEDULE" }, 400);
    const storageId = value.storageId as Id<"_storage">;
    try {
      const scheduled = await ctx.runMutation(internal.scans.schedule, {
        storageId,
        stableId: value.stableId,
        idempotencyKey: value.idempotencyKey,
        repositoryId: value.repositoryId,
        commitSha: value.commitSha,
        fileName: value.fileName,
        contentType: value.contentType,
        byteLength: value.byteLength,
        sha256: value.sha256,
      });
      if (scheduled.discardStorage) await ctx.storage.delete(storageId);
      return json(scheduled, scheduled.created ? 201 : 200);
    } catch (error) {
      await ctx.storage.delete(storageId).catch(() => undefined);
      return json({
        error: "SCAN_SCHEDULE_REJECTED",
        message: error instanceof Error ? error.message : "Unable to schedule scan",
      }, 400);
    }
  }),
});

http.route({
  path: "/scans/cancel",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signed = await readSignedJson(request);
    if (signed instanceof Response) return signed;
    if (!(await claimSignedRequest(ctx, signed.requestId))) return json({ error: "REPLAYED_REQUEST" }, 409);
    if (typeof signed.value.scanId !== "string") return json({ error: "INVALID_SCAN_CANCEL" }, 400);
    try {
      const canceled = await ctx.runMutation(internal.scans.cancel, {
        scanId: signed.value.scanId as Id<"scans">,
      });
      return json({ canceled }, canceled ? 200 : 409);
    } catch (error) {
      return json({
        error: "SCAN_CANCEL_REJECTED",
        message: error instanceof Error ? error.message : "Unable to cancel scan",
      }, 400);
    }
  }),
});

http.route({
  path: "/scans/discard-storage",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signed = await readSignedJson(request);
    if (signed instanceof Response) return signed;
    if (!(await claimSignedRequest(ctx, signed.requestId))) return json({ error: "REPLAYED_REQUEST" }, 409);
    if (typeof signed.value.storageId !== "string") return json({ error: "INVALID_STORAGE_DISCARD" }, 400);
    const storageId = signed.value.storageId as Id<"_storage">;
    try {
      const recorded = await ctx.runQuery(internal.uploads.isStorageRecorded, { storageId });
      if (!recorded) await ctx.storage.delete(storageId);
      return json({ discarded: !recorded }, 200);
    } catch (error) {
      return json({
        error: "STORAGE_DISCARD_REJECTED",
        message: error instanceof Error ? error.message : "Unable to discard storage object",
      }, 400);
    }
  }),
});

http.route({
  path: "/callbacks/progress",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signed = await readSignedJson(request);
    if (signed instanceof Response) return signed;
    const { requestId, value } = signed;
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

async function readSignedJson(
  request: Request,
): Promise<{ body: string; requestId: string; value: Record<string, unknown> } | Response> {
  const secret = process.env.HYDRATRACE_JOB_SHARED_SECRET;
  if (secret === undefined || secret.length < 32) return json({ error: "SIGNED_HTTP_NOT_CONFIGURED" }, 503);
  const body = await request.text();
  const timestamp = request.headers.get("x-hydratrace-timestamp");
  const requestId = request.headers.get("x-hydratrace-request-id");
  const signature = request.headers.get("x-hydratrace-signature");
  if (timestamp === null || requestId === null || signature === null) return json({ error: "MISSING_SIGNATURE" }, 401);
  if (!/^[A-Za-z0-9_.:-]{8,256}$/u.test(requestId)) return json({ error: "INVALID_REQUEST_ID" }, 401);
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > 300_000) {
    return json({ error: "STALE_SIGNATURE" }, 401);
  }
  const expected = await sign(secret, timestamp, requestId, body);
  if (!constantTimeEqual(expected, signature)) return json({ error: "INVALID_SIGNATURE" }, 401);
  let value: unknown;
  try { value = JSON.parse(body) as unknown; }
  catch { return json({ error: "INVALID_JSON" }, 400); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return json({ error: "INVALID_JSON_OBJECT" }, 400);
  }
  return { body, requestId, value: value as Record<string, unknown> };
}

async function claimSignedRequest(
  ctx: { runMutation: (...args: any[]) => Promise<any> },
  requestId: string,
): Promise<boolean> {
  return await ctx.runMutation(internal.callbacks.claimRequest, { requestId }) as boolean;
}

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
