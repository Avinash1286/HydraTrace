import { internal } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";
import { v } from "convex/values";

export const dispatchJob = internalAction({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const snapshot = await ctx.runQuery(internal.jobs.getForDispatch, { jobId: args.jobId });
    if (snapshot === null || snapshot.scan === null) return;
    const secret = process.env.HYDRATRACE_JOB_SHARED_SECRET;
    const engineUrl = process.env.HYDRATRACE_ENGINE_DISPATCH_URL?.replace(/\/$/u, "");
    if (secret === undefined || secret.length < 32 || engineUrl === undefined) {
      await ctx.runMutation(internal.jobs.failAttempt, {
        jobId: args.jobId,
        error: "Convex dispatch environment is not configured",
      });
      return;
    }
    const requestId = `dispatch:${String(args.jobId)}:${crypto.randomUUID()}`;
    const attempt = await ctx.runMutation(internal.jobs.startAttempt, { jobId: args.jobId, requestId });
    if (attempt === null) return;

    try {
      if (snapshot.job.attempt > 0 && snapshot.job.idempotencyKey !== undefined) {
        const recovered = await inspectExistingJob(engineUrl, secret, snapshot.job.idempotencyKey);
        if (recovered?.state === "COMPLETE") {
          await ctx.runMutation(internal.jobs.completeRecovered, {
            jobId: args.jobId,
            attemptId: attempt.attemptId,
            engineJobId: String(recovered.engineJobId),
            result: recovered.result,
          });
          return;
        }
        if (recovered !== undefined && recovered.state !== "FAILED") {
          await ctx.runMutation(internal.jobs.acknowledge, {
            jobId: args.jobId,
            attemptId: attempt.attemptId,
            engineJobId: String(recovered.engineJobId),
            statusCode: 200,
          });
          return;
        }
      }

      let content = typeof snapshot.job.dispatchPayload?.content === "string"
        ? snapshot.job.dispatchPayload.content
        : undefined;
      if (content === undefined && snapshot.upload !== null) {
        const uploadUrl = await ctx.storage.getUrl(snapshot.upload.storageId);
        if (uploadUrl === null) throw new Error("Scheduled scan upload has expired");
        const upload = await fetch(uploadUrl, { signal: AbortSignal.timeout(20_000) });
        if (!upload.ok) throw new Error(`Scheduled scan upload returned HTTP ${upload.status}`);
        content = await upload.text();
      }
      if (content === undefined) throw new Error("Scheduled scan has no lockfile content");
      const body = JSON.stringify({
        jobId: String(args.jobId),
        idempotencyKey: snapshot.job.idempotencyKey,
        callbackUrl: snapshot.job.callbackUrl,
        scan: { ...snapshot.job.dispatchPayload, content },
      });
      const response = await signedFetch(`${engineUrl}/v1/internal/jobs/dispatch`, "POST", secret, requestId, body);
      const value = await response.json() as { engineJobId?: unknown; message?: unknown };
      if (!response.ok || typeof value.engineJobId !== "string") {
        throw Object.assign(new Error(typeof value.message === "string" ? value.message : `Engine dispatch returned HTTP ${response.status}`), { statusCode: response.status });
      }
      await ctx.runMutation(internal.jobs.acknowledge, {
        jobId: args.jobId,
        attemptId: attempt.attemptId,
        engineJobId: value.engineJobId,
        statusCode: response.status,
      });
    } catch (error) {
      await ctx.runMutation(internal.jobs.failAttempt, {
        jobId: args.jobId,
        attemptId: attempt.attemptId,
        error: error instanceof Error ? error.message : "Unknown engine dispatch error",
        ...(typeof (error as { statusCode?: unknown }).statusCode === "number"
          ? { statusCode: (error as { statusCode: number }).statusCode }
          : {}),
      });
    }
  },
});

async function inspectExistingJob(
  engineUrl: string,
  secret: string,
  idempotencyKey: string,
): Promise<Record<string, unknown> | undefined> {
  const requestId = `status:${idempotencyKey}:${crypto.randomUUID()}`;
  const response = await signedFetch(
    `${engineUrl}/v1/internal/jobs/${idempotencyKey}`,
    "GET",
    secret,
    requestId,
    "",
  );
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Engine status lookup returned HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

async function signedFetch(
  url: string,
  method: "GET" | "POST",
  secret: string,
  requestId: string,
  body: string,
): Promise<Response> {
  const timestamp = String(Date.now());
  const signature = await sign(secret, timestamp, requestId, body);
  return fetch(url, {
    method,
    headers: {
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      "x-hydratrace-timestamp": timestamp,
      "x-hydratrace-request-id": requestId,
      "x-hydratrace-signature": signature,
    },
    ...(method === "POST" ? { body } : {}),
    signal: AbortSignal.timeout(30_000),
  });
}

async function sign(secret: string, timestamp: string, requestId: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${requestId}.${body}`));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

