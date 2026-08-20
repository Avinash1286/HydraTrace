import {
  DepsDevClient,
  MemoryResponseCache,
  NpmRegistryClient,
  OsvClient,
} from "@hydratrace/ecosystem-enrichment";
import { InMemoryGraphStore } from "@hydratrace/hydradb-client";
import { describe, expect, it, vi } from "vitest";
import { buildEngine } from "../engine.js";

describe("scan advisory enrichment", () => {
  it("associates and persists only official OSV exact-version matches", async () => {
    const clients = officialClientFixtures(new Map([
      [
        exactKey("affected-helper", "1.2.3"),
        advisory("GHSA-fixture-0001", "affected-helper", "1.2.3"),
      ],
    ]));
    const application = buildEngine({
      graphStore: new InMemoryGraphStore(),
      ...clients.dependencies,
      scanEnrichmentEnabled: true,
    });
    const response = await application.inject({
      method: "POST",
      url: "/v1/scans",
      body: scanBody(packageLock({
        dependencies: { "affected-helper": "1.2.3", "safe-helper": "2.0.0" },
        packages: {
          "node_modules/affected-helper": { version: "1.2.3" },
          "node_modules/safe-helper": { version: "2.0.0" },
        },
      })),
    });

    expect(response.statusCode, response.body).toBe(201);
    const enrichment = response.json().result.enrichment;
    expect(enrichment).toMatchObject({
      status: "complete",
      advisoryCheck: "complete",
      advisoryMatches: 1,
      incidentsPersisted: 1,
      confirmedNoKnownAdvisories: false,
      supplemental: { eligiblePackages: 1, attemptedPackages: 1, packageLimit: 16 },
    });
    expect(enrichment.packages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        package: expect.objectContaining({ name: "affected-helper", version: "1.2.3" }),
        usage: { direct: true, developmentOnly: false },
        advisoryStatus: "matched",
        advisories: [expect.objectContaining({
          advisory: expect.objectContaining({ id: "GHSA-fixture-0001", source: "osv" }),
          provenance: expect.objectContaining({
            source: "osv",
            matchType: "exact-package-version",
            query: { ecosystem: "npm", name: "affected-helper", version: "1.2.3" },
            queryUrl: "https://api.osv.dev/v1/querybatch",
            advisoryUrl: "https://api.osv.dev/v1/vulns/GHSA-fixture-0001",
          }),
          incident: expect.objectContaining({
            advisoryId: "GHSA-fixture-0001",
            affectedVersions: ["1.2.3"],
            source: "osv",
            packagePublishedAt: Date.parse("2026-01-02T00:00:00.000Z"),
            severityScore: 0.98,
          }),
        })],
      }),
      expect.objectContaining({
        package: expect.objectContaining({ name: "safe-helper", version: "2.0.0" }),
        advisoryStatus: "no-known-advisory",
        advisories: [],
      }),
    ]));
    expect(response.json().result.analysis).toMatchObject({
      incidentsDiscovered: 1,
      incidentsAnalyzed: 1,
      truncated: false,
      incidents: [expect.objectContaining({
        incidentId: enrichment.packages
          .find((value: { package: { name: string } }) => value.package.name === "affected-helper")
          .advisories[0].incident.id,
        totalPaths: 0,
      })],
    });
    const incidents = await application.inject({ method: "GET", url: "/v1/incidents" });
    expect(incidents.json()).toMatchObject({
      total: 1,
      incidents: [expect.objectContaining({
        advisoryId: "GHSA-fixture-0001",
        packageName: "affected-helper",
        affectedVersions: ["1.2.3"],
      })],
    });
    expect(clients.npmFetch).toHaveBeenCalledOnce();
    expect(clients.depsDevFetch).toHaveBeenCalledOnce();
    const osvQuery = JSON.parse(
      String(clients.osvFetch.mock.calls[0]?.[1]?.body),
    ) as { queries: Array<{ package: { ecosystem: string; name: string }; version: string }> };
    expect(osvQuery.queries).toEqual(expect.arrayContaining([
      {
        package: { ecosystem: "npm", name: "affected-helper" },
        version: "1.2.3",
      },
      {
        package: { ecosystem: "npm", name: "safe-helper" },
        version: "2.0.0",
      },
    ]));
    expect(String(clients.depsDevFetch.mock.calls[0]?.[0])).toContain(
      "/packages/affected-helper/versions/1.2.3:dependencies",
    );
    await application.close();
  });

  it("reports a confirmed safe negative only after a successful exact OSV query", async () => {
    const clients = officialClientFixtures(new Map());
    const application = buildEngine({
      graphStore: new InMemoryGraphStore(),
      ...clients.dependencies,
      scanEnrichmentEnabled: true,
    });
    const response = await application.inject({
      method: "POST",
      url: "/v1/scans",
      body: scanBody(packageLock()),
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().result.enrichment).toMatchObject({
      status: "complete",
      advisoryCheck: "complete",
      advisoryMatches: 0,
      incidentsPersisted: 0,
      confirmedNoKnownAdvisories: true,
      packages: [expect.objectContaining({
        package: expect.objectContaining({ name: "fixture-app", version: "1.0.0" }),
        advisoryStatus: "no-known-advisory",
      })],
    });
    expect(clients.npmFetch).not.toHaveBeenCalled();
    expect(clients.depsDevFetch).not.toHaveBeenCalled();
    const incidents = await application.inject({ method: "GET", url: "/v1/incidents" });
    expect(incidents.json().total).toBe(0);
    await application.close();
  });

  it("persists dev-only advisory truth while keeping it out of the default blast radius", async () => {
    const clients = officialClientFixtures(new Map([
      [
        exactKey("dev-only-helper", "9.9.9"),
        advisory("OSV-DEV-ONLY", "dev-only-helper", "9.9.9"),
      ],
    ]));
    const application = buildEngine({
      graphStore: new InMemoryGraphStore(),
      ...clients.dependencies,
      scanEnrichmentEnabled: true,
    });
    const response = await application.inject({
      method: "POST",
      url: "/v1/scans",
      body: {
        ...scanBody(packageLock({
          devDependencies: { "dev-only-helper": "9.9.9" },
          packages: {
            "node_modules/dev-only-helper": { version: "9.9.9", dev: true },
          },
        })),
        environment: "production",
        organizationId: "fixture",
        serviceId: "dev-app",
        deploymentStartedAt: 1_786_700_000_000,
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    const matched = response.json().result.enrichment.packages.find(
      (value: { package: { name: string } }) => value.package.name === "dev-only-helper",
    );
    expect(matched).toMatchObject({
      package: { ecosystem: "npm", name: "dev-only-helper", version: "9.9.9" },
      usage: { direct: true, developmentOnly: true },
      advisoryStatus: "matched",
    });
    const incidentId = matched.advisories[0].incident.id as string;
    const defaultBlast = await application.inject({
      method: "GET",
      url: `/v1/incidents/${incidentId}/blast-radius`,
    });
    const devBlast = await application.inject({
      method: "GET",
      url: `/v1/incidents/${incidentId}/blast-radius?includeDevelopment=true`,
    });
    expect(defaultBlast.json()).toMatchObject({ totalFindings: 0, totalPaths: 0 });
    expect(devBlast.json()).toMatchObject({
      totalFindings: 1,
      findings: [expect.objectContaining({
        affectedPackageName: "dev-only-helper",
        affectedVersion: "9.9.9",
        developmentOnly: true,
      })],
    });
    await application.close();
  });

  it("does not misreport an OSV outage as a safe negative", async () => {
    const cache = new MemoryResponseCache();
    const osvClient = new OsvClient({
      cache,
      fetch: vi.fn(async () => new Response("unavailable", { status: 503 })),
    });
    const application = buildEngine({
      graphStore: new InMemoryGraphStore(),
      osvClient,
      scanEnrichmentEnabled: true,
    });
    const response = await application.inject({
      method: "POST",
      url: "/v1/scans",
      body: scanBody(packageLock()),
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().result.enrichment).toMatchObject({
      status: "unavailable",
      advisoryCheck: "unavailable",
      confirmedNoKnownAdvisories: false,
      advisoryMatches: 0,
      packages: [expect.objectContaining({ advisoryStatus: "not-checked" })],
      errors: [expect.objectContaining({ source: "osv" })],
    });
    await application.close();
  });
});

function officialClientFixtures(advisories: Map<string, Record<string, unknown>>) {
  const osvFetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/querybatch")) {
      const body = JSON.parse(String(init?.body)) as {
        queries: Array<{ package: { name: string }; version: string }>;
      };
      return Response.json({
        results: body.queries.map((query) => {
          const record = advisories.get(`${query.package.name}\0${query.version}`);
          return record === undefined ? { vulns: [] } : { vulns: [{ id: record.id }] };
        }),
      });
    }
    const id = decodeURIComponent(url.split("/").at(-1)!);
    const record = [...advisories.values()].find((value) => value.id === id);
    return record === undefined
      ? new Response("not found", { status: 404 })
      : Response.json(record);
  });
  const npmFetch = vi.fn<typeof fetch>(async (input) => {
    const name = decodeURIComponent(new URL(String(input)).pathname.slice(1));
    const version = name === "dev-only-helper" ? "9.9.9" : "1.2.3";
    return Response.json({
      name,
      time: {
        created: "2026-01-01T00:00:00.000Z",
        [version]: "2026-01-02T00:00:00.000Z",
      },
      versions: {
        [version]: {
          name,
          version,
          maintainers: [{ name: "Fixture Maintainer" }],
          repository: { url: `https://github.com/fixture/${name}` },
          dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` },
        },
      },
    });
  });
  const depsDevFetch = vi.fn<typeof fetch>(async (input) => {
    const parts = new URL(String(input)).pathname.split("/");
    const name = decodeURIComponent(parts[5]!);
    const version = decodeURIComponent(parts[7]!.replace(/:dependencies$/u, ""));
    return Response.json({
      nodes: [{
        versionKey: { system: "NPM", name, version },
        relation: "SELF",
        errors: [],
      }],
      edges: [],
    });
  });
  const cache = new MemoryResponseCache();
  return {
    dependencies: {
      osvClient: new OsvClient({ cache, fetch: osvFetch }),
      npmRegistryClient: new NpmRegistryClient({ cache, fetch: npmFetch }),
      depsDevClient: new DepsDevClient({ cache, fetch: depsDevFetch }),
    },
    osvFetch,
    npmFetch,
    depsDevFetch,
  };
}

function advisory(id: string, name: string, version: string): Record<string, unknown> {
  return {
    id,
    aliases: ["CVE-2026-0001"],
    summary: "Official fixture advisory",
    published: "2026-02-01T00:00:00.000Z",
    severity: [{
      type: "CVSS_V3",
      score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
    }],
    affected: [{
      package: { ecosystem: "npm", name },
      versions: [version],
    }],
    references: [{ type: "ADVISORY", url: `https://osv.dev/vulnerability/${id}` }],
  };
}

function scanBody(content: string): Record<string, unknown> {
  return {
    mode: "lockfile",
    content,
    sourceRef: "package-lock.json",
    repositoryId: "fixture/enrichment",
    commitSha: "enrichment-commit",
    observedAt: 1_786_700_000_000,
  };
}

function packageLock(overrides: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packages?: Record<string, Record<string, unknown>>;
} = {}): string {
  return JSON.stringify({
    name: "fixture-app",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "fixture-app",
        version: "1.0.0",
        ...(overrides.dependencies === undefined
          ? {}
          : { dependencies: overrides.dependencies }),
        ...(overrides.devDependencies === undefined
          ? {}
          : { devDependencies: overrides.devDependencies }),
      },
      ...overrides.packages,
    },
  });
}

function exactKey(name: string, version: string): string {
  return `${name}\0${version}`;
}
