import { InMemoryGraphStore } from "@hydratrace/hydradb-client";
import { canonicalKeys, stableIdFromCanonicalKey } from "@hydratrace/domain";
import { describe, expect, it, vi } from "vitest";
import { buildEngine } from "./engine.js";
import { signHydraTraceRequest } from "./services/signed-jobs.js";

describe("engine ingestion API", () => {
  it("accepts a signed durable dispatch and reports its idempotent status", async () => {
    const secret = "j".repeat(64);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const application = buildEngine({ graphStore: new InMemoryGraphStore(), jobSharedSecret: secret });
    const idempotencyKey = "a".repeat(64);
    const body = JSON.stringify({
      jobId: "convex-job-123",
      idempotencyKey,
      callbackUrl: "https://example.test/callbacks/progress",
      scan: {
        content: JSON.stringify({
          name: "dispatched-app",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: { "": { name: "dispatched-app", version: "1.0.0" } },
        }),
        sourceRef: "package-lock.json",
        repositoryId: "fixture/dispatched",
        commitSha: "dispatch1",
        observedAt: 1,
      },
    });
    const timestamp = String(Date.now());
    const requestId = "dispatch-request-123";
    const dispatched = await application.inject({
      method: "POST",
      url: "/v1/internal/jobs/dispatch",
      headers: {
        "content-type": "application/json",
        "x-hydratrace-timestamp": timestamp,
        "x-hydratrace-request-id": requestId,
        "x-hydratrace-signature": signHydraTraceRequest(secret, timestamp, requestId, body),
      },
      payload: body,
    });
    expect(dispatched.statusCode, dispatched.body).toBe(202);

    let status: ReturnType<typeof JSON.parse> = {};
    for (let attempt = 0; attempt < 20 && status.state !== "COMPLETE"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const statusTimestamp = String(Date.now());
      const statusRequestId = `status-request-${attempt}`;
      const response = await application.inject({
        method: "GET",
        url: `/v1/internal/jobs/${idempotencyKey}`,
        headers: {
          "x-hydratrace-timestamp": statusTimestamp,
          "x-hydratrace-request-id": statusRequestId,
          "x-hydratrace-signature": signHydraTraceRequest(secret, statusTimestamp, statusRequestId, ""),
        },
      });
      status = response.json();
    }
    expect(status).toMatchObject({ state: "COMPLETE", idempotencyKey });
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit | undefined)?.body)) as { stage: string })
      .map(({ stage }) => stage)).toEqual([
        "ACQUIRING",
        "PARSING",
        "ENRICHING",
        "WRITING_GRAPH",
        "INDEXING",
        "WAITING_FOR_INDEX",
        "ANALYZING",
        "COMPLETE",
      ]);
    await application.close();
    fetchMock.mockRestore();
  });

  it("resets the complete historical Acme demo deterministically", async () => {
    const graphStore = new InMemoryGraphStore();
    const application = buildEngine({ graphStore });
    const first = await application.inject({ method: "POST", url: "/v1/demo/reset" });
    const second = await application.inject({ method: "POST", url: "/v1/demo/reset" });
    const candidates = await application.inject({
      method: "GET",
      url: `/v1/incidents/${first.json().incident.id}/remediations/candidates`,
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      status: "ready",
      fictional: true,
      snapshots: expect.arrayContaining([
        expect.objectContaining({ repositoryId: "acme-commerce/checkout-api" }),
        expect.objectContaining({ repositoryId: "acme-commerce/payment-worker" }),
        expect.objectContaining({ repositoryId: "acme-commerce/analytics-dashboard" }),
      ]),
      blastRadius: {
        totalAffectedServices: 2,
        findings: expect.arrayContaining([
          expect.objectContaining({ serviceId: "checkout-api", reachability: 2 }),
          expect.objectContaining({ serviceId: "payment-worker", reachability: 3 }),
        ]),
      },
    });
    expect(first.json().timeline.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "EXPOSURE_STARTED", serviceId: "checkout-api" }),
      expect.objectContaining({ type: "EXPOSURE_ENDED", serviceId: "checkout-api" }),
      expect.objectContaining({ type: "EXPOSURE_ENDED", serviceId: "payment-worker" }),
      expect.objectContaining({ type: "STATIC_REACHABILITY_DETECTED", serviceId: "checkout-api" }),
      expect.objectContaining({ type: "RUNTIME_OBSERVATION_RECORDED", serviceId: "payment-worker" }),
      expect.objectContaining({ type: "FIXED_SNAPSHOT_DEPLOYED", serviceId: "checkout-api" }),
      expect.objectContaining({ type: "FINAL_EXPOSURE_PATH_REMOVED" }),
    ]));
    expect(second.json().graphWrite).toEqual({ nodesCreated: 0, relationshipsCreated: 0 });
    const supersedes = await graphStore.matchRelationships({
      type: "SUPERSEDES",
      limit: 100,
    });
    expect(supersedes).toHaveLength(4);
    expect(candidates.statusCode).toBe(200);
    expect(candidates.json().candidates.length).toBeGreaterThanOrEqual(2);
    await application.close();
  });

  it("reconstructs incident topology from the graph after an engine restart", async () => {
    const graphStore = new InMemoryGraphStore();
    const firstEngine = buildEngine({ graphStore });
    const seeded = await firstEngine.inject({ method: "POST", url: "/v1/demo/reset" });
    const incidentId = seeded.json().incident.id as string;
    await firstEngine.close();

    const restartedEngine = buildEngine({ graphStore });
    const blast = await restartedEngine.inject({
      method: "GET",
      url: `/v1/incidents/${incidentId}/blast-radius`,
    });
    const timeline = await restartedEngine.inject({
      method: "GET",
      url: `/v1/incidents/${incidentId}/timeline`,
    });
    const packageId = stableIdFromCanonicalKey(canonicalKeys.package("npm", "compromised-helper"));
    const similarNames = await restartedEngine.inject({
      method: "GET",
      url: `/v1/packages/${packageId}/similar-names?version=1.4.2`,
    });

    expect(blast.statusCode).toBe(200);
    expect(blast.json()).toMatchObject({
      totalAffectedServices: 2,
      findings: expect.arrayContaining([
        expect.objectContaining({ serviceId: "checkout-api", affectedVersion: "1.4.2", reachability: 2 }),
        expect.objectContaining({ serviceId: "payment-worker", affectedVersion: "1.4.2", reachability: 3 }),
      ]),
    });
    expect(timeline.json().events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "EXPOSURE_ENDED", serviceId: "checkout-api" }),
      expect.objectContaining({ type: "EXPOSURE_ENDED", serviceId: "payment-worker" }),
    ]));
    expect(similarNames.statusCode).toBe(200);
    expect(similarNames.json().relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "SIMILAR_NAME",
        target: expect.objectContaining({ name: "compromised-he1per" }),
        indicatorOnly: true,
      }),
    ]));
    await restartedEngine.close();
  });

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
      "ENRICHING",
      "WRITING_GRAPH",
      "INDEXING",
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
    const graphStore = new InMemoryGraphStore();
    const application = buildEngine({ graphStore });
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
    const restarted = buildEngine({ graphStore });
    const durableRemediation = await restarted.inject({
      method: "GET",
      url: `/v1/remediations/${remediation.json().runId}`,
    });
    expect(durableRemediation.statusCode).toBe(200);
    expect(durableRemediation.json()).toMatchObject({
      runId: remediation.json().runId,
      status: "INCONCLUSIVE",
      verification: { remainingPathCount: 0, passed: false },
    });
    await restarted.close();
  });
});
