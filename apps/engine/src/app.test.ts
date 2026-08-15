import { InMemoryGraphStore } from "@hydratrace/hydradb-client";
import { describe, expect, it } from "vitest";
import { buildEngine } from "./engine.js";

describe("engine ingestion API", () => {
  it("ingests an exact lockfile and makes a repeated request idempotent", async () => {
    const application = buildEngine({ graphStore: new InMemoryGraphStore() });
    const body = {
      content: JSON.stringify({
        name: "fixture-app",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "fixture-app",
            version: "1.0.0",
            dependencies: { dependency: "1.0.0" },
          },
          "node_modules/dependency": { version: "1.0.0" },
        },
      }),
      sourceRef: "package-lock.json",
      repositoryId: "fixture/app",
      commitSha: "abc123",
      observedAt: 1,
    };

    const first = await application.inject({ method: "POST", url: "/v1/scans/lockfile", body });
    const second = await application.inject({ method: "POST", url: "/v1/scans/lockfile", body });

    expect(first.statusCode).toBe(201);
    expect(first.json().graphWrite.nodes.created).toBeGreaterThan(0);
    expect(second.statusCode).toBe(201);
    expect(second.json().graphWrite).toMatchObject({
      nodes: { created: 0 },
      relationships: { created: 0 },
    });
    await application.close();
  });

  it("rejects malformed requests", async () => {
    const application = buildEngine({ graphStore: new InMemoryGraphStore() });
    const response = await application.inject({
      method: "POST",
      url: "/v1/scans/lockfile",
      body: { content: "" },
    });
    expect(response.statusCode).toBe(400);
    await application.close();
  });

  it("rejects a deployment that does not belong to the snapshot", async () => {
    const application = buildEngine({ graphStore: new InMemoryGraphStore() });
    const response = await application.inject({
      method: "POST",
      url: "/v1/scans/lockfile",
      body: {
        content: JSON.stringify({
          name: "fixture-app",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: { "": { name: "fixture-app", version: "1.0.0" } },
        }),
        sourceRef: "package-lock.json",
        repositoryId: "fixture/app",
        commitSha: "abc123",
        observedAt: 1,
        deploymentManifest: JSON.stringify({
          schemaVersion: 1,
          organizationId: "fixture",
          repositoryId: "another/repository",
          serviceId: "app",
          environment: "production",
          commitSha: "abc123",
          startedAt: "2026-08-15T09:00:00.000Z",
          endedAt: null,
          lockfile: "package-lock.json",
        }),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/repositoryId/);
    await application.close();
  });
});
