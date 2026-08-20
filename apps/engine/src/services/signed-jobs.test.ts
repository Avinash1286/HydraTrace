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

  it("rejects an unsigned dispatch before execution", async () => {
    const execute = vi.fn();
    const application = Fastify();
    await application.register(rawBody, { field: "rawBody", global: false, encoding: false, runFirst: true });
    registerSignedJobRoutes(application, execute, secret, new MemoryJobStatusStore());
    const response = await application.inject({
      method: "POST",
      url: "/v1/internal/jobs/dispatch",
      body: {
        jobId: "job-unsigned",
        idempotencyKey: "a".repeat(64),
        callbackUrl: "https://convex.example.test/callbacks/progress",
        scan: {
          content: "{}",
          sourceRef: "package-lock.json",
          repositoryId: "fixture/unsigned",
          commitSha: "abc123",
          observedAt: 1,
        },
      },
    });
    expect(response.statusCode, response.body).toBe(401);
    expect(response.json()).toMatchObject({ error: "INVALID_SIGNATURE" });
    expect(execute).not.toHaveBeenCalled();
    await application.close();
  });

  it("sends a signed acknowledgement before serialized progress callbacks", async () => {
    process.env.VERCEL = "1";
    const stages: string[] = [];
    let callbacksInFlight = 0;
    let maximumCallbacksInFlight = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      callbacksInFlight += 1;
      maximumCallbacksInFlight = Math.max(maximumCallbacksInFlight, callbacksInFlight);
      const callbackBody = String(init?.body);
      const callback = JSON.parse(callbackBody) as { stage: string };
      const headers = new Headers(init?.headers);
      const timestamp = headers.get("x-hydratrace-timestamp");
      const requestId = headers.get("x-hydratrace-request-id");
      expect(timestamp).not.toBeNull();
      expect(requestId).not.toBeNull();
      expect(headers.get("x-hydratrace-signature")).toBe(
        signHydraTraceRequest(secret, timestamp!, requestId!, callbackBody),
      );
      stages.push(callback.stage);
      await Promise.resolve();
      callbacksInFlight -= 1;
      return new Response(null, { status: 204 });
    }));
    const application = Fastify();
    await application.register(rawBody, { field: "rawBody", global: false, encoding: false, runFirst: true });
    registerSignedJobRoutes(application, async (_scan, progress) => {
      progress("ACQUIRING", "Acquiring immutable input");
      progress("PARSING", "Parsing dependency graph");
      return { graphWrite: { nodes: { created: 1 }, relationships: { created: 1 } } };
    }, secret, new MemoryJobStatusStore());
    await application.ready();

    const dispatchBody = JSON.stringify({
      jobId: "job-callback-order",
      idempotencyKey: "c".repeat(64),
      callbackUrl: "https://convex.example.test/callbacks/progress",
      scan: {
        content: "{\"lockfileVersion\":3,\"packages\":{}}",
        sourceRef: "package-lock.json",
        repositoryId: "fixture/callback-order",
        commitSha: "abc123",
        observedAt: 1,
      },
    });
    const dispatched = await application.inject({
      method: "POST",
      url: "/v1/internal/jobs/dispatch",
      payload: dispatchBody,
      headers: signedHeaders(secret, dispatchBody, "dispatch:callback-order"),
    });

    expect(dispatched.statusCode, dispatched.body).toBe(202);
    expect(stages).toEqual(["ACKNOWLEDGED", "ACQUIRING", "PARSING", "COMPLETE"]);
    expect(maximumCallbacksInFlight).toBe(1);
    await application.close();
  });

  it("replays an interrupted checkpoint and persists completion when callbacks are lost", async () => {
    process.env.VERCEL = "1";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("callback connection lost")));
    const store = new MemoryJobStatusStore();
    const idempotencyKey = "d".repeat(64);
    let dispatchedStaticOrigin: string | undefined;
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
    registerSignedJobRoutes(application, async (scan, progress) => {
      executions += 1;
      dispatchedStaticOrigin = scan.staticAnalysis?.origin;
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
        staticAnalysis: {
          origin: "precomputed",
          entrypoints: ["src/index.ts"],
          files: [{ path: "src/index.ts", source: "import 'fixture'" }],
        },
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
    expect(dispatchedStaticOrigin).toBe("precomputed");
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
