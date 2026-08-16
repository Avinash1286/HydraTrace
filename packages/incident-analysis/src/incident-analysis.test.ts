import {
  parseDeploymentManifest,
  stableIdFromCanonicalKey,
  type DeploymentManifest,
  type NormalizedSnapshot,
} from "@hydratrace/domain";
import { parseLockfile } from "@hydratrace/lockfile-parsers";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeBlastRadius } from "./blast-radius.js";
import { IncidentCatalog } from "./catalog.js";
import { buildExposureTimeline } from "./timeline.js";

interface FixtureRepository {
  repositoryId: string;
  lockfile: string;
}

interface FixtureExpected {
  repositories: FixtureRepository[];
  blastRadiusExpectations: {
    affectedPackage: string;
    affectedVersion: string;
    productionAffectedPathCount: number;
    allEnvironmentAffectedPathCount: number;
  };
}

describe("exact temporal blast radius", () => {
  it("returns the exact production services and complete path count", () => {
    const fixture = loadFixtureCatalog();
    const result = analyzeBlastRadius(fixture.catalog, fixture.incidentId, {}, 1);

    expect(result.totalFindings).toBe(2);
    expect(result.totalAffectedServices).toBe(2);
    expect(result.totalPaths).toBe(
      fixture.expected.blastRadiusExpectations.productionAffectedPathCount,
    );
    expect(result.findings.map(({ serviceId }) => serviceId)).toEqual([
      "checkout-api",
      "payment-worker",
    ]);
    expect(result.findings.flatMap(({ displayedPaths }) => displayedPaths)).toHaveLength(3);
    expect(
      result.findings.flatMap(({ displayedPaths }) =>
        displayedPaths.map((path) =>
          path.nodes.map(({ packageName, version }) => `${packageName}@${version}`),
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        [
          "@acme/checkout-api@1.0.0",
          "checkout-framework@2.0.0",
          "telemetry-core@3.2.0",
          "compromised-helper@1.4.2",
        ],
        [
          "@acme/payment-worker@1.0.0",
          "queue-runtime@4.0.0",
          "telemetry-core@3.2.0",
          "compromised-helper@1.4.2",
        ],
        [
          "@acme/payment-worker@1.0.0",
          "telemetry-core@3.2.0",
          "compromised-helper@1.4.2",
        ],
      ]),
    );
  });

  it("includes development-only paths only when explicitly requested", () => {
    const fixture = loadFixtureCatalog();
    const result = analyzeBlastRadius(fixture.catalog, fixture.incidentId, {
      includeDevelopment: true,
    });

    expect(result.totalFindings).toBe(3);
    expect(result.totalPaths).toBe(
      fixture.expected.blastRadiusExpectations.allEnvironmentAffectedPathCount,
    );
    expect(result.findings.map(({ serviceId }) => serviceId)).toContain(
      "analytics-dashboard",
    );
    expect(
      result.findings.find(({ serviceId }) => serviceId === "analytics-dashboard")
        ?.developmentOnly,
    ).toBe(true);
  });

  it("changes exactly at deployment timestamps", () => {
    const fixture = loadFixtureCatalog();
    const at0903 = analyzeBlastRadius(fixture.catalog, fixture.incidentId, {
      at: Date.parse("2026-08-15T09:03:00.000Z"),
    });
    const at0905 = analyzeBlastRadius(fixture.catalog, fixture.incidentId, {
      at: Date.parse("2026-08-15T09:05:00.000Z"),
    });
    const at0910 = analyzeBlastRadius(fixture.catalog, fixture.incidentId, {
      at: Date.parse("2026-08-15T09:10:00.000Z"),
    });

    expect([at0903.totalFindings, at0903.totalPaths]).toEqual([0, 0]);
    expect([at0905.totalFindings, at0905.totalPaths]).toEqual([1, 1]);
    expect([at0910.totalFindings, at0910.totalPaths]).toEqual([2, 3]);
  });

  it("uses half-open deployment intervals", () => {
    const fixture = loadFixtureCatalog();
    const catalog = new IncidentCatalog();
    const payment = fixture.imports.find(
      ({ deployment }) => deployment.serviceId === "payment-worker",
    );
    if (payment === undefined) throw new Error("payment fixture missing");
    const endedAt = Date.parse("2026-08-15T09:10:00.000Z");
    catalog.registerSnapshot(payment.normalized, {
      ...payment.deployment,
      endedAt,
    });
    const incident = catalog.createIncident(
      {
        ecosystem: "npm",
        packageName: "compromised-helper",
        affectedVersions: ["1.4.2"],
        startsAt: Date.parse("2026-08-15T09:02:00.000Z"),
      },
      0,
    );

    expect(
      analyzeBlastRadius(catalog, incident.id, { at: endedAt - 1 }).totalFindings,
    ).toBe(1);
    expect(analyzeBlastRadius(catalog, incident.id, { at: endedAt }).totalFindings).toBe(
      0,
    );
  });

  it("covers every temporal boundary in the project contract", () => {
    const fixture = loadFixtureCatalog();
    const payment = fixture.imports.find(({ deployment }) => deployment.serviceId === "payment-worker");
    if (payment === undefined) throw new Error("payment fixture missing");
    const start = payment.deployment.startedAt;
    const normalized = structuredClone(payment.normalized);
    normalized.snapshot.createdAt = start - 1_000;

    const analyze = (
      deployments: DeploymentManifest[],
      incidentOverrides: Parameters<IncidentCatalog["createIncident"]>[0] = {
        ecosystem: "npm",
        packageName: "compromised-helper",
        affectedVersions: ["1.4.2"],
      },
      at?: number,
    ) => {
      const catalog = new IncidentCatalog();
      for (const deployment of deployments) catalog.registerSnapshot(normalized, deployment);
      const incident = catalog.createIncident(incidentOverrides, 0);
      return analyzeBlastRadius(catalog, incident.id, at === undefined ? {} : { at });
    };

    const atBoundary = analyze(
      [{ ...payment.deployment, startedAt: start }],
      { ecosystem: "npm", packageName: "compromised-helper", affectedVersions: ["1.4.2"], startsAt: start },
      start,
    );
    expect(atBoundary.totalFindings).toBe(1);

    const endedAtBoundary = analyze(
      [{ ...payment.deployment, startedAt: start - 1_000, endedAt: start }],
      { ecosystem: "npm", packageName: "compromised-helper", affectedVersions: ["1.4.2"], startsAt: start },
      start,
    );
    expect(endedAtBoundary.totalFindings).toBe(0);

    normalized.snapshot.validUntil = start + 2_000;
    expect(analyze([payment.deployment], undefined, start + 1_999).totalFindings).toBe(1);
    expect(analyze([payment.deployment], undefined, start + 2_000).totalFindings).toBe(0);
    delete normalized.snapshot.validUntil;

    expect(analyze(
      [payment.deployment],
      { ecosystem: "npm", packageName: "compromised-helper", affectedVersions: ["1.4.2"], advisoryWithdrawnAt: start + 500 },
      start + 500,
    ).totalFindings).toBe(0);

    expect(analyze([payment.deployment], undefined, start + 86_400_000).totalFindings).toBe(1);

    const secondDeployment = {
      ...payment.deployment,
      deploymentId: stableIdFromCanonicalKey("temporal:second-deployment"),
      startedAt: start + 1_000,
    };
    expect(analyze([payment.deployment, secondDeployment], undefined, start + 1_500).totalFindings).toBe(2);

    const originalEnded = { ...payment.deployment, endedAt: start + 1_000 };
    const rollback = {
      ...payment.deployment,
      deploymentId: stableIdFromCanonicalKey("temporal:rollback"),
      startedAt: start + 10_000,
      endedAt: null,
    };
    const rollbackResult = analyze([originalEnded, rollback], undefined, start + 10_000);
    expect(rollbackResult.totalFindings).toBe(1);
    expect(rollbackResult.findings[0]?.deploymentId).toBe(rollback.deploymentId);
  });

  it("counts all paths while limiting displayed evidence", () => {
    const fixture = loadFixtureCatalog();
    const result = analyzeBlastRadius(fixture.catalog, fixture.incidentId, {
      pathDisplayLimit: 1,
    });
    const payment = result.findings.find(({ serviceId }) => serviceId === "payment-worker");

    expect(payment?.pathCount).toBe(2);
    expect(payment?.displayedPaths).toHaveLength(1);
    expect(payment?.pathsTruncated).toBe(true);
    expect(result.totalPaths).toBe(3);
  });

  it("produces a deterministic exposure timeline", () => {
    const fixture = loadFixtureCatalog();
    const timeline = buildExposureTimeline(fixture.catalog, fixture.incidentId);
    const exposureStarts = timeline.events.filter(
      ({ type }) => type === "EXPOSURE_STARTED",
    );

    expect(exposureStarts.map(({ serviceId }) => serviceId)).toEqual([
      "checkout-api",
      "payment-worker",
    ]);
    expect(exposureStarts.map(({ exposureCountAfter }) => exposureCountAfter)).toEqual([
      1, 2,
    ]);
  });
});

function loadFixtureCatalog(): {
  catalog: IncidentCatalog;
  incidentId: ReturnType<IncidentCatalog["createIncident"]>["id"];
  expected: FixtureExpected;
  imports: Array<{ normalized: NormalizedSnapshot; deployment: DeploymentManifest }>;
} {
  const fixtureRoot = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
  const expected = JSON.parse(
    readFileSync(new URL("../../../fixtures/expected-results/acme-commerce.normalized.json", import.meta.url), "utf8"),
  ) as FixtureExpected;
  const incidentFixture = JSON.parse(
    readFileSync(new URL("../../../fixtures/incidents/npm-compromised-helper-2026-08.json", import.meta.url), "utf8"),
  ) as {
    packageName: string;
    affectedVersions: string[];
    startsAt: string;
    endsAt: string | null;
  };
  const catalog = new IncidentCatalog();
  const imports: Array<{
    normalized: NormalizedSnapshot;
    deployment: DeploymentManifest;
  }> = [];

  for (const repository of expected.repositories) {
    const lockfilePath = `${fixtureRoot}/${repository.lockfile}`;
    const directory = lockfilePath.replace(/[\\/][^\\/]+$/, "");
    const deploymentPath = `${directory}/hydratrace-deployment.json`;
    const content = readFileSync(lockfilePath, "utf8");
    const deploymentContent = readFileSync(deploymentPath, "utf8");
    const deploymentInput = JSON.parse(deploymentContent) as {
      commitSha: string;
      startedAt: string;
    };
    const normalized = parseLockfile(content, {
      repositoryId: repository.repositoryId,
      commitSha: deploymentInput.commitSha,
      sourceRef: basename(lockfilePath),
      observedAt: Date.parse(deploymentInput.startedAt),
    });
    const deployment = parseDeploymentManifest(
      deploymentContent,
      normalized.snapshot.contentHash,
    );
    catalog.registerSnapshot(normalized, deployment);
    imports.push({ normalized, deployment });
  }

  const incident = catalog.createIncident(
    {
      ecosystem: "npm",
      packageName: incidentFixture.packageName,
      affectedVersions: incidentFixture.affectedVersions,
      startsAt: Date.parse(incidentFixture.startsAt),
      ...(incidentFixture.endsAt === null
        ? {}
        : { endsAt: Date.parse(incidentFixture.endsAt) }),
    },
    0,
  );
  return { catalog, incidentId: incident.id, expected, imports };
}
