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
    const root = await application.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.json()).toMatchObject({ service: "HydraTrace Engine", status: "ok" });
    await application.close();
  });

  it("tracks an idempotent scan workflow and its progress events", async () => {
    const application = buildEngine({ graphStore: new InMemoryGraphStore() });
    const body = {
      content: JSON.stringify({
        name: "workflow-app",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: { "": { name: "workflow-app", version: "1.0.0" } },
      }),
      sourceRef: "package-lock.json",
      repositoryId: "fixture/workflow",
      commitSha: "workflow1",
      observedAt: 1,
    };
    const first = await application.inject({ method: "POST", url: "/v1/scans", body });
    const second = await application.inject({ method: "POST", url: "/v1/scans", body });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ scanId: first.json().scanId, stage: "COMPLETE" });
    const events = await application.inject({
      method: "GET",
      url: `/v1/scans/${first.json().scanId}/events`,
    });
    expect(events.json().events.map(({ stage }: { stage: string }) => stage)).toEqual([
      "QUEUED",
      "ACQUIRING",
      "PARSING",
      "WRITING_GRAPH",
      "WAITING_FOR_INDEX",
      "ANALYZING",
      "COMPLETE",
    ]);
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

  it("creates an incident and returns its exact temporal path", async () => {
    const application = buildEngine({ graphStore: new InMemoryGraphStore() });
    const startedAt = Date.parse("2026-08-15T09:04:00.000Z");
    const scan = await application.inject({
      method: "POST",
      url: "/v1/scans/lockfile",
      body: {
        content: JSON.stringify({
          name: "fixture-app",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: {
            "": {
              name: "fixture-app",
              version: "1.0.0",
              dependencies: { "compromised-helper": "1.4.2" },
            },
            "node_modules/compromised-helper": { version: "1.4.2" },
          },
        }),
        sourceRef: "package-lock.json",
        repositoryId: "fixture/app",
        commitSha: "abc123",
        observedAt: startedAt,
        deploymentManifest: JSON.stringify({
          schemaVersion: 1,
          organizationId: "fixture",
          repositoryId: "fixture/app",
          serviceId: "app",
          environment: "production",
          commitSha: "abc123",
          startedAt: "2026-08-15T09:04:00.000Z",
          endedAt: null,
          lockfile: "package-lock.json",
        }),
      },
    });
    expect(scan.statusCode).toBe(201);

    const created = await application.inject({
      method: "POST",
      url: "/v1/incidents",
      body: {
        ecosystem: "npm",
        packageName: "compromised-helper",
        affectedVersions: ["1.4.2"],
        startsAt: Date.parse("2026-08-15T09:02:00.000Z"),
      },
    });
    expect(created.statusCode).toBe(201);
    const incidentId = created.json().incident.id as string;
    const blast = await application.inject({
      method: "GET",
      url: `/v1/incidents/${incidentId}/blast-radius?at=${startedAt}`,
    });
    expect(blast.statusCode).toBe(200);
    expect(blast.json()).toMatchObject({
      totalFindings: 1,
      totalPaths: 1,
      findings: [
        {
          serviceId: "app",
          affectedVersion: "1.4.2",
          direct: true,
          developmentOnly: false,
          pathCount: 1,
        },
      ],
    });
    expect(blast.json().findings[0].displayedPaths[0].nodes).toHaveLength(2);

    const snapshotId = scan.json().snapshot.id as string;
    const staticAnalysis = await application.inject({
      method: "POST",
      url: "/v1/reachability/static",
      body: {
        snapshotId,
        repositoryId: "fixture/app",
        commitSha: "abc123",
        observedAt: startedAt + 1,
        entrypoints: ["src/server.ts"],
        files: [{
          path: "src/server.ts",
          source: 'import helper from "compromised-helper"; helper();',
        }],
      },
    });
    expect(staticAnalysis.statusCode).toBe(201);
    expect(staticAnalysis.json().evidence[0].level).toBe(2);
    const staticBlast = await application.inject({
      method: "GET",
      url: `/v1/incidents/${incidentId}/blast-radius?at=${startedAt}`,
    });
    expect(staticBlast.json().findings[0].reachability).toBe(2);

    const runtime = await application.inject({
      method: "POST",
      url: "/v1/reachability/runtime",
      body: {
        runId: "prod-1",
        startedAt: startedAt + 2,
        command: "node server.js",
        kind: "runtime",
        snapshotId,
        deploymentId: scan.json().deployment.deploymentId,
        packages: [{
          name: "compromised-helper",
          version: "1.4.2",
          firstLoadedAt: startedAt + 3,
          loadCount: 4,
        }],
      },
    });
    expect(runtime.statusCode).toBe(201);
    const runtimeBlast = await application.inject({
      method: "GET",
      url: `/v1/incidents/${incidentId}/blast-radius?at=${startedAt}`,
    });
    expect(runtimeBlast.json().findings[0]).toMatchObject({
      reachability: 4,
      reachabilityEvidence: expect.arrayContaining([
        expect.objectContaining({ source: "runtime-trace" }),
      ]),
    });

    const pathId = runtimeBlast.json().findings[0].displayedPaths[0].pathId as string;
    const remediation = await application.inject({
      method: "POST",
      url: `/v1/incidents/${incidentId}/remediations`,
      body: {
        candidates: [{
          dependencyName: "compromised-helper",
          fromVersion: "1.4.2",
          toVersion: "1.4.3",
          semverImpact: "patch",
          eliminatedPathIds: [pathId],
          affectedServices: ["app"],
          verification: "PROPOSED",
        }],
      },
    });
    expect(remediation.statusCode).toBe(201);
    expect(remediation.json()).toMatchObject({
      solution: { exact: true, uncoveredPathIds: [] },
      status: "PROPOSED",
      verification: { passed: false },
    });
    const failedVerification = await application.inject({
      method: "POST",
      url: `/v1/remediations/${remediation.json().runId}/verify`,
      body: { snapshotId },
    });
    expect(failedVerification.json()).toMatchObject({
      status: "FAILED",
      verification: { passed: false, remainingPathCount: 1 },
    });

    const safeScan = await application.inject({
      method: "POST",
      url: "/v1/scans/lockfile",
      body: {
        content: JSON.stringify({
          name: "fixture-app",
          version: "1.0.1",
          lockfileVersion: 3,
          packages: {
            "": {
              name: "fixture-app",
              version: "1.0.1",
              dependencies: { "compromised-helper": "1.4.3" },
            },
            "node_modules/compromised-helper": { version: "1.4.3" },
          },
        }),
        sourceRef: "package-lock.json",
        repositoryId: "fixture/app",
        commitSha: "fixed456",
        observedAt: startedAt + 10,
      },
    });
    const weakVerification = await application.inject({
      method: "POST",
      url: `/v1/remediations/${remediation.json().runId}/verify`,
      body: { snapshotId: safeScan.json().snapshot.id },
    });
    expect(weakVerification.json()).toMatchObject({
      status: "INCONCLUSIVE",
      verification: {
        level: "REFERENCE_GRAPH",
        passed: false,
        remainingPathCount: 0,
      },
    });

    const copilot = await application.inject({
      method: "POST",
      url: `/v1/incidents/${incidentId}/copilot`,
      body: { question: "Which service should I investigate first?" },
    });
    expect(copilot.statusCode).toBe(200);
    expect(copilot.json()).toMatchObject({
      provider: "deterministic-template",
      grounded: true,
      severity: "high",
    });
    expect(copilot.json().evidenceRefs.length).toBeGreaterThan(0);
    const report = await application.inject({
      method: "POST",
      url: `/v1/incidents/${incidentId}/reports`,
      body: { format: "sarif" },
    });
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({ version: "2.1.0" });

    const timeline = await application.inject({
      method: "GET",
      url: `/v1/incidents/${incidentId}/timeline`,
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "DEPLOYMENT_STARTED", serviceId: "app" }),
        expect.objectContaining({ type: "EXPOSURE_STARTED", serviceId: "app" }),
      ]),
    );
    await application.close();
  });
});
