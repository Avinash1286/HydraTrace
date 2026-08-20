import { ReachabilityLevel } from "@hydratrace/domain";
import { InMemoryGraphStore } from "@hydratrace/hydradb-client";
import { analyzeBlastRadius, IncidentCatalog } from "@hydratrace/incident-analysis";
import { afterEach, describe, expect, it } from "vitest";
import { ingestLockfile } from "./ingestion.js";
import { persistScanReachability } from "./scan-reachability.js";
import type { ScanWorkflowInput } from "./scans.js";

describe("scan-integrated reachability", () => {
  const stores: InMemoryGraphStore[] = [];
  afterEach(async () => Promise.all(stores.splice(0).map(async (store) => store.close())));

  it("attaches INSTALLED_ONLY, STATIC_REACHABLE, and UNKNOWN_DYNAMIC evidence to incident findings", async () => {
    const store = new InMemoryGraphStore();
    stores.push(store);
    const catalog = new IncidentCatalog();
    const cases = [
      {
        serviceId: "installed-only",
        source: "export const healthy = true;",
        expected: ReachabilityLevel.Installed,
      },
      {
        serviceId: "static-reachable",
        source: 'import helper from "compromised-helper/subpath"; helper();',
        expected: ReachabilityLevel.StaticReachable,
      },
      {
        serviceId: "unknown-dynamic",
        source: "const selected = process.env.HELPER; require(selected);",
        expected: ReachabilityLevel.UnknownDynamicBehavior,
      },
    ] as const;

    for (const [index, fixture] of cases.entries()) {
      const repositoryId = `fixture/${fixture.serviceId}`;
      const commitSha = `commit-${index}`;
      const observedAt = 1_786_777_200_000 + index;
      const input: ScanWorkflowInput = {
        content: packageLock(),
        sourceRef: "package-lock.json",
        repositoryId,
        commitSha,
        observedAt,
        deploymentManifest: JSON.stringify({
          schemaVersion: 1,
          organizationId: "fixture",
          repositoryId,
          serviceId: fixture.serviceId,
          environment: "production",
          commitSha,
          startedAt: new Date(observedAt).toISOString(),
          endedAt: null,
          lockfile: "package-lock.json",
        }),
        staticAnalysis: {
          origin: "archive",
          entrypoints: ["src/server.ts"],
          files: [{ path: "src/server.ts", source: fixture.source }],
        },
      };
      const ingested = await ingestLockfile(store, {
        content: input.content,
        deploymentManifest: input.deploymentManifest!,
        options: {
          sourceRef: input.sourceRef,
          repositoryId,
          commitSha,
          observedAt,
        },
      });
      catalog.registerSnapshot(ingested.normalized, ingested.deployment);
      const summary = await persistScanReachability(
        store,
        catalog,
        input,
        ingested.normalized.snapshot.id,
      );
      expect(summary.staticAnalysis).toMatchObject({
        analyzedFiles: 1,
        unknownDynamicBehavior: fixture.expected === ReachabilityLevel.UnknownDynamicBehavior,
      });
    }

    const incident = catalog.createIncident({
      ecosystem: "npm",
      packageName: "compromised-helper",
      affectedVersions: ["1.4.2"],
      startsAt: 1_786_777_100_000,
      environments: ["production"],
    });
    const blast = analyzeBlastRadius(catalog, incident.id, { limit: 10 });
    const reachabilityByService = Object.fromEntries(
      blast.findings.map(({ serviceId, reachability }) => [serviceId, reachability]),
    );
    expect(reachabilityByService).toEqual({
      "installed-only": ReachabilityLevel.Installed,
      "static-reachable": ReachabilityLevel.StaticReachable,
      "unknown-dynamic": ReachabilityLevel.UnknownDynamicBehavior,
    });
    expect(blast.findings.find(({ serviceId }) => serviceId === "installed-only")?.reachabilityEvidence).toEqual([]);
    expect(blast.findings.find(({ serviceId }) => serviceId === "static-reachable")?.reachabilityEvidence)
      .toEqual([expect.objectContaining({ source: "static", level: ReachabilityLevel.StaticReachable })]);
    expect(blast.findings.find(({ serviceId }) => serviceId === "unknown-dynamic")?.reachabilityEvidence)
      .toEqual([expect.objectContaining({ source: "dynamic-unknown", level: ReachabilityLevel.UnknownDynamicBehavior })]);
  });

  it("binds a supplied runtime trace to the newly-created snapshot", async () => {
    const store = new InMemoryGraphStore();
    stores.push(store);
    const catalog = new IncidentCatalog();
    const observedAt = 1_786_777_200_000;
    const input: ScanWorkflowInput = {
      content: packageLock(),
      sourceRef: "package-lock.json",
      repositoryId: "fixture/runtime-observed",
      commitSha: "runtime-commit",
      observedAt,
      deploymentManifest: JSON.stringify({
        schemaVersion: 1,
        organizationId: "fixture",
        repositoryId: "fixture/runtime-observed",
        serviceId: "runtime-observed",
        environment: "production",
        commitSha: "runtime-commit",
        startedAt: new Date(observedAt).toISOString(),
        endedAt: null,
        lockfile: "package-lock.json",
      }),
      runtimeTrace: {
        runId: "runtime-fixture-1",
        startedAt: observedAt + 1,
        command: "node src/server.js",
        kind: "runtime",
        packages: [{
          name: "compromised-helper",
          version: "1.4.2",
          firstLoadedAt: observedAt + 2,
          loadCount: 3,
        }],
      },
    };
    const ingested = await ingestLockfile(store, {
      content: input.content,
      deploymentManifest: input.deploymentManifest!,
      options: {
        sourceRef: input.sourceRef,
        repositoryId: input.repositoryId,
        commitSha: input.commitSha,
        observedAt,
      },
    });
    catalog.registerSnapshot(ingested.normalized, ingested.deployment);
    const summary = await persistScanReachability(
      store,
      catalog,
      input,
      ingested.normalized.snapshot.id,
    );
    expect(summary).toMatchObject({
      evidenceAccepted: 1,
      runtimeTrace: { kind: "runtime", packageObservations: 1, evidenceAccepted: 1 },
    });
    const incident = catalog.createIncident({
      ecosystem: "npm",
      packageName: "compromised-helper",
      affectedVersions: ["1.4.2"],
      startsAt: observedAt - 1,
    });
    expect(analyzeBlastRadius(catalog, incident.id).findings[0]).toMatchObject({
      reachability: ReachabilityLevel.RuntimeObserved,
      reachabilityEvidence: [expect.objectContaining({ source: "runtime-trace" })],
    });
  });
});

function packageLock(): string {
  return JSON.stringify({
    name: "fixture-app",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "fixture-app",
        version: "1.0.0",
        dependencies: { "compromised-helper": "1.4.2" },
      },
      "node_modules/compromised-helper": {
        version: "1.4.2",
      },
    },
  });
}
