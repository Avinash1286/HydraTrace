import { describe, expect, it } from "vitest";
import { parseDeploymentManifest } from "./deployment.js";

describe("deployment manifest", () => {
  it("normalizes intervals and derives a stable deployment ID", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      organizationId: "acme",
      repositoryId: "acme/checkout",
      serviceId: "checkout-api",
      environment: "production",
      commitSha: "abc123",
      startedAt: "2026-08-15T09:04:00.000Z",
      endedAt: null,
      lockfile: "package-lock.json",
    });
    const first = parseDeploymentManifest(raw, "a".repeat(64));
    const second = parseDeploymentManifest(raw, "a".repeat(64));

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      criticality: "production",
      startedAt: Date.parse("2026-08-15T09:04:00.000Z"),
      endedAt: null,
    });
  });

  it("rejects a non-positive interval", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      organizationId: "acme",
      repositoryId: "acme/checkout",
      serviceId: "checkout-api",
      environment: "production",
      commitSha: "abc123",
      startedAt: "2026-08-15T09:04:00.000Z",
      endedAt: "2026-08-15T09:04:00.000Z",
      lockfile: "package-lock.json",
    });
    expect(() => parseDeploymentManifest(raw, "a".repeat(64))).toThrow(/later/);
  });
});
