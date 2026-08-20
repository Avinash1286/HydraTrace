import { InMemoryGraphStore } from "@hydratrace/hydradb-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEngine } from "../engine.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AI and report incident evidence", () => {
  it("hydrates durable graph evidence after restart, matches visible defaults, and renders deterministic reports", async () => {
    const graphStore = new InMemoryGraphStore();
    const first = buildEngine({ graphStore });
    const seeded = await first.inject({ method: "GET", url: "/v1/demo" });
    expect(seeded.statusCode).toBe(200);
    const incident = seeded.json().incident as { id: string; createdAt: number };
    await first.close();

    let copilotEvidence: Record<string, any> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        prompt: string;
        evidenceRefs: string[];
      };
      copilotEvidence = JSON.parse(
        request.prompt.slice(request.prompt.indexOf("\n") + 1),
      ) as Record<string, any>;
      return Response.json({
        answer: "Checkout is the highest-priority service in the supplied evidence.",
        severity: "high",
        evidenceRefs: request.evidenceRefs.slice(0, 1),
        unknowns: copilotEvidence.unknowns,
        recommendedActions: ["Inspect the cited dependency path."],
      });
    }));

    const restarted = buildEngine({
      graphStore,
      aiEnvironment: {
        AI_GATEWAY_URL: "https://gateway.example.test",
        AI_GATEWAY_SHARED_SECRET: "test-secret-that-is-longer-than-thirty-two-characters",
      },
    });
    const copilot = await restarted.inject({
      method: "POST",
      url: `/v1/incidents/${incident.id}/copilot`,
      body: { question: "Which service should I investigate first?" },
    });
    expect(copilot.statusCode).toBe(200);
    expect(copilot.json()).toMatchObject({
      provider: "hydratrace-ai-gateway",
      grounded: true,
    });
    expect(copilotEvidence).toMatchObject({
      summary: {
        totalAffectedServices: 2,
        totalPaths: 3,
      },
    });
    expect(
      (copilotEvidence!.summary.findings as Array<{ serviceId: string }>).map(
        ({ serviceId }) => serviceId,
      ),
    ).toEqual(["checkout-api", "payment-worker"]);

    const jsonReport = await restarted.inject({
      method: "POST",
      url: `/v1/incidents/${incident.id}/reports`,
      body: { format: "json" },
    });
    expect(jsonReport.statusCode).toBe(200);
    expect(jsonReport.json().blast).toMatchObject({
      generatedAt: incident.createdAt,
      totalAffectedServices: 2,
      totalPaths: 3,
      pathsTruncated: false,
      query: { includeDevelopment: false },
    });

    const markdownRequests = await Promise.all([
      restarted.inject({
        method: "POST",
        url: `/v1/incidents/${incident.id}/reports`,
        body: { format: "markdown" },
      }),
      restarted.inject({
        method: "POST",
        url: `/v1/incidents/${incident.id}/reports`,
        body: { format: "markdown" },
      }),
    ]);
    expect(markdownRequests[0].statusCode).toBe(200);
    expect(markdownRequests[1].statusCode).toBe(200);
    expect(markdownRequests[0].body).toBe(markdownRequests[1].body);
    expect(markdownRequests[0].body).toContain(
      `- Generated: ${new Date(incident.createdAt).toISOString()}`,
    );
    await restarted.close();
  });

  it("refuses Copilot and report output when a finding has more than 100 complete paths", async () => {
    const application = buildEngine({ graphStore: new InMemoryGraphStore() });
    const observedAt = Date.parse("2026-08-20T10:00:00.000Z");
    const scan = await ingest(
      application,
      JSON.stringify(manyPathsLockfile(101)),
      "fixture/path-truncation",
      "paths-commit",
      "path-service",
      observedAt,
    );
    expect(scan.statusCode).toBe(201);
    const incident = await createIncident(
      application,
      ["1.0.0"],
      observedAt,
    );

    for (const [path, body] of [
      [`/v1/incidents/${incident.id}/copilot`, { question: "Explain every path." }],
      [`/v1/incidents/${incident.id}/reports`, { format: "json" }],
    ] as const) {
      const response = await application.inject({ method: "POST", url: path, body });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: "INCIDENT_EVIDENCE_TRUNCATED",
        totalFindings: 1,
        returnedFindings: 1,
        findingsTruncated: false,
        pathsTruncated: true,
        totalPaths: 101,
      });
    }
    await application.close();
  });

  it("refuses Copilot and report output when more than 100 findings would be paginated", async () => {
    const application = buildEngine({ graphStore: new InMemoryGraphStore() });
    const observedAt = Date.parse("2026-08-20T11:00:00.000Z");
    const versions = Array.from({ length: 51 }, (_, index) => `1.0.${index}`);
    const content = JSON.stringify(manyAffectedVersionsLockfile(versions));
    for (const [serviceId, startedAt] of [
      ["service-a", observedAt],
      ["service-b", observedAt + 1],
    ] as const) {
      const scan = await ingest(
        application,
        content,
        "fixture/finding-truncation",
        "findings-commit",
        serviceId,
        startedAt,
      );
      expect(scan.statusCode).toBe(201);
    }
    const incident = await createIncident(application, versions, observedAt);

    const report = await application.inject({
      method: "POST",
      url: `/v1/incidents/${incident.id}/reports`,
      body: { format: "json" },
    });
    expect(report.statusCode).toBe(409);
    expect(report.json()).toMatchObject({
      error: "INCIDENT_EVIDENCE_TRUNCATED",
      totalFindings: 102,
      returnedFindings: 100,
      findingsTruncated: true,
      pathsTruncated: false,
      totalPaths: 102,
    });
    await application.close();
  });
});

function manyPathsLockfile(pathCount: number): Record<string, unknown> {
  const rootDependencies: Record<string, string> = {};
  const packages: Record<string, unknown> = {
    "": {
      name: "path-fixture",
      version: "1.0.0",
      dependencies: rootDependencies,
    },
    "node_modules/affected-package": { version: "1.0.0" },
  };
  for (let index = 0; index < pathCount; index += 1) {
    const name = `bridge-${index}`;
    rootDependencies[name] = "1.0.0";
    packages[`node_modules/${name}`] = {
      version: "1.0.0",
      dependencies: { "affected-package": "1.0.0" },
    };
  }
  return {
    name: "path-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages,
  };
}

function manyAffectedVersionsLockfile(
  versions: readonly string[],
): Record<string, unknown> {
  const rootDependencies: Record<string, string> = {};
  const packages: Record<string, unknown> = {
    "": {
      name: "finding-fixture",
      version: "1.0.0",
      dependencies: rootDependencies,
    },
  };
  versions.forEach((version, index) => {
    const holder = `holder-${index}`;
    rootDependencies[holder] = "1.0.0";
    packages[`node_modules/${holder}`] = {
      version: "1.0.0",
      dependencies: { "affected-package": version },
    };
    packages[`node_modules/${holder}/node_modules/affected-package`] = { version };
  });
  return {
    name: "finding-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages,
  };
}

async function ingest(
  application: ReturnType<typeof buildEngine>,
  content: string,
  repositoryId: string,
  commitSha: string,
  serviceId: string,
  observedAt: number,
) {
  return application.inject({
    method: "POST",
    url: "/v1/scans/lockfile",
    body: {
      content,
      sourceRef: "package-lock.json",
      repositoryId,
      commitSha,
      observedAt,
      deploymentManifest: JSON.stringify({
        schemaVersion: 1,
        organizationId: "fixture",
        repositoryId,
        serviceId,
        environment: "production",
        commitSha,
        startedAt: new Date(observedAt).toISOString(),
        endedAt: null,
        lockfile: "package-lock.json",
      }),
    },
  });
}

async function createIncident(
  application: ReturnType<typeof buildEngine>,
  affectedVersions: readonly string[],
  startsAt: number,
): Promise<{ id: string }> {
  const response = await application.inject({
    method: "POST",
    url: "/v1/incidents",
    body: {
      ecosystem: "npm",
      packageName: "affected-package",
      affectedVersions,
      environments: ["production"],
      startsAt,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().incident as { id: string };
}
