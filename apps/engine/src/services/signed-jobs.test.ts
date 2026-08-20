import Fastify from "fastify";
import rawBody from "fastify-raw-body";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryJobStatusStore } from "./job-status-store.js";
import { registerSignedJobRoutes, SignedRequestVerifier, signHydraTraceRequest } from "./signed-jobs.js";

describe("signed Convex/engine requests", () => {
  const secret = "s".repeat(64);
  const now = 1_786_704_000_000;
  const body = JSON.stringify({ jobId: "job-1" });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VERCEL;
  });

  it("accepts the exact raw body once", () => {
    const verifier = new SignedRequestVerifier(secret, () => now);
    const timestamp = String(now);
    const requestId = "request:12345678";
    const headers = {
      "x-hydratrace-timestamp": timestamp,
      "x-hydratrace-request-id": requestId,
      "x-hydratrace-signature": signHydraTraceRequest(secret, timestamp, requestId, body),
    };
    expect(verifier.verify(headers, body)).toBe(requestId);
    expect(() => verifier.verify(headers, body)).toThrow(/already used/u);
  });

  it("rejects stale timestamps, body tampering, and invalid signatures", () => {
    const timestamp = String(now - 300_001);
    const requestId = "request:stale-123";
    expect(() => new SignedRequestVerifier(secret, () => now).verify({
      "x-hydratrace-timestamp": timestamp,
      "x-hydratrace-request-id": requestId,
      "x-hydratrace-signature": signHydraTraceRequest(secret, timestamp, requestId, body),
    }, body)).toThrow(/five-minute/u);

    const current = String(now);
    expect(() => new SignedRequestVerifier(secret, () => now).verify({
      "x-hydratrace-timestamp": current,
      "x-hydratrace-request-id": "request:tampered",
      "x-hydratrace-signature": signHydraTraceRequest(secret, current, "request:tampered", body),
    }, `${body} `)).toThrow(/invalid/u);
  });

  it("replays an interrupted checkpoint and persists completion when callbacks are lost", async () => {
    process.env.VERCEL = "1";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("callback connection lost")));
    const store = new MemoryJobStatusStore();
    const idempotencyKey = "d".repeat(64);
    await store.put({
      jobId: "job-restart",
      idempotencyKey,
      engineJobId: "123",
      state: "PARSING",
      checkpointStage: "PARSING",
      updatedAt: 1,
    });
    let executions = 0;
    const application = Fastify();
    await application.register(rawBody, { field: "rawBody", global: false, encoding: false, runFirst: true });
    registerSignedJobRoutes(application, async (_scan, progress) => {
      executions += 1;
      progress("PARSING", "resumed deterministic parsing");
      progress("WRITING_GRAPH", "idempotent graph write resumed");
      return { graphWrite: { nodes: { created: 0 }, relationships: { created: 0 } } };
    }, secret, store);
    await application.ready();

    const dispatchBody = JSON.stringify({
      jobId: "job-restart",
      idempotencyKey,
      callbackUrl: "https://convex.example.test/callbacks/progress",
      scan: {
        content: "{\"lockfileVersion\":3,\"packages\":{}}",
        sourceRef: "package-lock.json",
        repositoryId: "fixture/restart",
        commitSha: "abc123",
        observedAt: 1,
      },
    });
    const dispatched = await application.inject({
      method: "POST",
      url: "/v1/internal/jobs/dispatch",
      payload: dispatchBody,
      headers: signedHeaders(secret, dispatchBody, "dispatch:restart-1"),
    });
    expect(dispatched.statusCode).toBe(202);
    expect(executions).toBe(1);
    expect(await store.get(idempotencyKey)).toMatchObject({ state: "COMPLETE", checkpointStage: "COMPLETE" });

    const duplicate = await application.inject({
      method: "POST",
      url: "/v1/internal/jobs/dispatch",
      payload: dispatchBody,
      headers: signedHeaders(secret, dispatchBody, "dispatch:restart-2"),
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ state: "COMPLETE" });
    expect(executions).toBe(1);
    await application.close();
  });
});

function signedHeaders(secret: string, body: string, requestId: string): Record<string, string> {
  const timestamp = String(Date.now());
  return {
    "content-type": "application/json",
    "x-hydratrace-timestamp": timestamp,
    "x-hydratrace-request-id": requestId,
    "x-hydratrace-signature": signHydraTraceRequest(secret, timestamp, requestId, body),
  };
}
