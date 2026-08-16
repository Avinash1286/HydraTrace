import { describe, expect, it } from "vitest";
import { SignedRequestVerifier, signHydraTraceRequest } from "./signed-jobs.js";

describe("signed Convex/engine requests", () => {
  const secret = "s".repeat(64);
  const now = 1_786_704_000_000;
  const body = JSON.stringify({ jobId: "job-1" });

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
});

