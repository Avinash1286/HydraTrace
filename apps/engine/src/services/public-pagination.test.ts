import {
  canonicalKeys,
  stableIdFromCanonicalKey,
  type DeploymentManifest,
  type StableId,
} from "@hydratrace/domain";
import { InMemoryGraphStore } from "@hydratrace/hydradb-client";
import { IncidentCatalog } from "@hydratrace/incident-analysis";
import { describe, expect, it } from "vitest";
import { buildEngine } from "../engine.js";

describe("bounded public read pagination", () => {
  it("paginates timelines, finding pages, and nested dependency paths", async () => {
    const application = buildEngine({ graphStore: new InMemoryGraphStore() });
    const seeded = await application.inject({ method: "POST", url: "/v1/demo/reset" });
    const incidentId = seeded.json().incident.id as string;

    const timeline = await application.inject({
      method: "GET",
      url: `/v1/incidents/${incidentId}/timeline?offset=1&limit=2`,
    });
    expect(timeline.statusCode, timeline.body).toBe(200);
    expect(timeline.json()).toMatchObject({
      totalEvents: 19,
      totalEventsExact: true,
      eventsTruncated: true,
      sourceFindingCount: 2,
      consideredFindingCount: 2,
      sourceFindingsTruncated: false,
      page: {
        total: 19,
        offset: 1,
        limit: 2,
        returned: 2,
        hasPrevious: true,
        hasMore: true,
        truncated: true,
      },
    });
    expect(timeline.json().events).toHaveLength(2);

    const paths = await application.inject({
      method: "GET",
      url: `/v1/incidents/${incidentId}/paths?offset=1&limit=1&pathOffset=1&pathLimit=1`,
    });
    expect(paths.statusCode, paths.body).toBe(200);
    expect(paths.json()).toMatchObject({
      totalFindings: 2,
      page: { total: 2, offset: 1, limit: 1, returned: 1, truncated: true },
      findings: [{
        serviceId: "payment-worker",
        pathCount: 2,
        pathCountTruncated: false,
        pathPage: { total: 2, offset: 1, limit: 1, returned: 1, truncated: true },
      }],
    });
    expect(paths.json().findings[0].displayedPaths).toHaveLength(1);

    const findingId = paths.json().findings[0].findingId as string;
    const finding = await application.inject({
      method: "GET",
      url: `/v1/incidents/${incidentId}/findings/${findingId}?offset=1&limit=1`,
    });
    expect(finding.statusCode, finding.body).toBe(200);
    expect(finding.json()).toMatchObject({
      finding: { findingId, pathCount: 2, pathCountTruncated: false },
      pathPage: { total: 2, offset: 1, limit: 1, returned: 1, truncated: true },
      pathCountTruncated: false,
    });
    expect(finding.json().finding.displayedPaths).toHaveLength(1);

    for (const url of [
      `/v1/incidents/${incidentId}/timeline?limit=101`,
      `/v1/incidents/${incidentId}/paths?pathOffset=9999&pathLimit=2`,
      `/v1/incidents/${incidentId}/findings/${findingId}?offset=9999&limit=2`,
    ]) {
      const invalid = await application.inject({ method: "GET", url });
      expect(invalid.statusCode, `${url}: ${invalid.body}`).toBe(400);
    }
    await application.close();
  });

  it("retrieves an exact finding beyond the first 100 without widening the response page", async () => {
    const graphStore = new InMemoryGraphStore();
    const catalog = new IncidentCatalog();
    const application = buildEngine({ graphStore, incidentCatalog: catalog });
    const seeded = await application.inject({ method: "POST", url: "/v1/demo/reset" });
    const incidentId = seeded.json().incident.id as StableId;
    const entry = catalog.entries().find(({ deployments }) =>
      deployments.some(({ serviceId }) => serviceId === "payment-worker"));
    expect(entry).toBeDefined();
    const base = entry!.deployments.find(({ serviceId }) => serviceId === "payment-worker")!;

    for (let index = 0; index < 99; index += 1) {
      catalog.registerSnapshot(entry!.normalized, clonedDeployment(base, `aa-service-${String(index).padStart(3, "0")}`));
    }
    const targetDeployment = clonedDeployment(base, "zz-target-service");
    catalog.registerSnapshot(entry!.normalized, targetDeployment);
    const affectedPackageVersionId = entry!.normalized.packages.find(({ normalizedName, version }) =>
      normalizedName === "compromised-helper" && version === "1.4.2")!.id;
    const targetFindingId = stableIdFromCanonicalKey(
      `finding:${incidentId}:${targetDeployment.deploymentId}:${affectedPackageVersionId}`,
    );

    const firstPage = await application.inject({
      method: "GET",
      url: `/v1/incidents/${incidentId}/blast-radius?limit=100`,
    });
    expect(firstPage.json().totalFindings).toBeGreaterThan(100);
    expect(firstPage.json().findings.map(({ findingId }: { findingId: string }) => findingId))
      .not.toContain(targetFindingId);

    const target = await application.inject({
      method: "GET",
      url: `/v1/incidents/${incidentId}/findings/${targetFindingId}?limit=1`,
    });
    expect(target.statusCode, target.body).toBe(200);
    expect(target.json()).toMatchObject({
      finding: { findingId: targetFindingId, serviceId: "zz-target-service" },
      pathPage: { limit: 1, returned: 1 },
    });

    await application.close();
  });

  it("paginates package neighborhoods, maintainers, and similar-name relations", async () => {
    const application = buildEngine({ graphStore: new InMemoryGraphStore() });
    const metadata = await application.inject({
      method: "POST",
      url: "/v1/package-metadata",
      payload: [
        {
          name: "pagination-source",
          version: "1.0.0",
          maintainers: [
            { name: "One", email: "one@example.test" },
            { name: "Two", email: "two@example.test" },
            { name: "Three", email: "three@example.test" },
          ],
          repositoryUrl: "https://example.test/shared/repository",
        },
        {
          name: "pagination-sourc3",
          version: "1.0.0",
          maintainers: [{ name: "One", email: "one@example.test" }],
          repositoryUrl: "https://example.test/shared/repository",
        },
        {
          name: "pagination-sourc4",
          version: "1.0.0",
          maintainers: [{ name: "Two", email: "two@example.test" }],
          repositoryUrl: "https://example.test/shared/repository",
        },
      ],
    });
    expect(metadata.statusCode, metadata.body).toBe(201);

    const packageId = stableIdFromCanonicalKey(canonicalKeys.package("npm", "pagination-source"));
    const maintainers = await application.inject({
      method: "GET",
      url: `/v1/packages/${packageId}/maintainers?version=1.0.0&offset=1&limit=1`,
    });
    expect(maintainers.json()).toMatchObject({
      totalMaintainers: 3,
      maintainersTruncated: true,
      page: { total: 3, offset: 1, limit: 1, returned: 1, truncated: true },
    });
    expect(maintainers.json().maintainers).toHaveLength(1);

    const neighborhood = await application.inject({
      method: "GET",
      url: "/v1/packages/pagination-source/1.0.0/neighborhood?offset=1&limit=2",
    });
    expect(neighborhood.statusCode, neighborhood.body).toBe(200);
    expect(neighborhood.json().totalRelations).toBeGreaterThan(2);
    expect(neighborhood.json()).toMatchObject({
      relationsTruncated: true,
      page: { offset: 1, limit: 2, returned: 2, truncated: true },
    });
    expect(neighborhood.json().relations).toHaveLength(2);

    const similar = await application.inject({
      method: "GET",
      url: `/v1/packages/${packageId}/similar-names?version=1.0.0&limit=1`,
    });
    expect(similar.statusCode, similar.body).toBe(200);
    expect(similar.json()).toMatchObject({
      totalRelations: 2,
      relationsTruncated: true,
      page: { total: 2, offset: 0, limit: 1, returned: 1, hasMore: true },
    });

    const invalid = await application.inject({
      method: "GET",
      url: "/v1/packages/pagination-source/1.0.0/maintainers?limit=101",
    });
    expect(invalid.statusCode).toBe(400);
    await application.close();
  });

  it("paginates reachability evidence while deriving level from the complete bounded set", async () => {
    const application = buildEngine({ graphStore: new InMemoryGraphStore() });
    const seeded = await application.inject({ method: "POST", url: "/v1/demo/reset" });
    const payment = seeded.json().blastRadius.findings.find(
      ({ serviceId }: { serviceId: string }) => serviceId === "payment-worker",
    );
    const accepted = await application.inject({
      method: "POST",
      url: "/v1/reachability/runtime",
      payload: {
        runId: "pagination-runtime-observation",
        startedAt: Date.parse("2026-08-15T09:30:00.000Z"),
        command: "pnpm test",
        kind: "runtime",
        snapshotId: payment.snapshotId,
        deploymentId: payment.deploymentId,
        packages: [{
          name: payment.affectedPackageName,
          version: payment.affectedVersion,
          firstLoadedAt: Date.parse("2026-08-15T09:30:01.000Z"),
          loadCount: 1,
        }],
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(201);

    const evidence = await application.inject({
      method: "GET",
      url: `/v1/snapshots/${payment.snapshotId}/packages/${payment.affectedPackageName}/${payment.affectedVersion}/reachability?offset=1&limit=1`,
    });
    expect(evidence.statusCode, evidence.body).toBe(200);
    expect(evidence.json()).toMatchObject({
      level: 4,
      totalEvidence: 2,
      evidenceTruncated: true,
      page: { total: 2, offset: 1, limit: 1, returned: 1, truncated: true },
    });
    expect(evidence.json().evidence).toHaveLength(1);

    const invalid = await application.inject({
      method: "GET",
      url: `/v1/snapshots/${payment.snapshotId}/packages/${payment.affectedPackageName}/${payment.affectedVersion}/reachability?limit=101`,
    });
    expect(invalid.statusCode).toBe(400);
    await application.close();
  });
});

function clonedDeployment(
  base: DeploymentManifest,
  serviceId: string,
): DeploymentManifest {
  return {
    ...base,
    serviceId,
    deploymentId: stableIdFromCanonicalKey(`pagination-deployment:${serviceId}`),
  };
}
