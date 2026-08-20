import type {
  DepsDevClient,
  DepsDevGraph,
  NpmRegistryClient,
  NpmVersionMetadata,
  OsvClient,
  OsvExactQueryResult,
} from "@hydratrace/ecosystem-enrichment";
import type {
  NormalizedPackageVersion,
  NormalizedSnapshot,
  OsvAdvisorySummary,
  StableId,
} from "@hydratrace/domain";
import type { GraphStore } from "@hydratrace/hydradb-client";
import type { IncidentCatalog, IncidentRecord } from "@hydratrace/incident-analysis";
import type { PackageIntelligenceCatalog } from "@hydratrace/package-intelligence";
import { persistIncident } from "./graph-catalog.js";
import { persistPackageIntelligence } from "./package-metadata-graph.js";

const SUPPLEMENTAL_PACKAGE_LIMIT = 16;

export interface ScanEnrichmentDependencies {
  graphStore: GraphStore;
  incidentCatalog: IncidentCatalog;
  packageIntelligenceCatalog: PackageIntelligenceCatalog;
  osvClient: Pick<OsvClient, "queryExactPackages">;
  npmRegistryClient?: Pick<NpmRegistryClient, "getVersion">;
  depsDevClient?: Pick<DepsDevClient, "dependencies">;
  onExternalError?: () => void;
}

export interface ScanEnrichmentPackageResult {
  package: {
    ecosystem: "npm";
    name: string;
    version: string;
    packageVersionId: StableId;
  };
  usage: {
    direct: boolean;
    developmentOnly: boolean;
  };
  advisoryStatus: "matched" | "no-known-advisory" | "not-checked";
  advisories: Array<{
    advisory: OsvAdvisorySummary;
    provenance: {
      source: "osv";
      matchType: "exact-package-version";
      query: { ecosystem: "npm"; name: string; version: string };
      queryUrl: string;
      advisoryUrl: string;
      lockfile: NormalizedPackageVersion["provenance"];
    };
    incident?: IncidentRecord;
  }>;
  npm?: NpmVersionMetadata;
  depsDev?: {
    nodes: number;
    edges: number;
    provenance: DepsDevGraph["provenance"];
  };
}

export interface ScanEnrichmentResult {
  status: "disabled" | "complete" | "partial" | "unavailable";
  advisoryCheck: "not-run" | "complete" | "unavailable";
  exactPackageQueries: number;
  advisoryMatches: number;
  incidentsPersisted: number;
  confirmedNoKnownAdvisories: boolean;
  supplemental: {
    eligiblePackages: number;
    attemptedPackages: number;
    packageLimit: number;
  };
  packages: ScanEnrichmentPackageResult[];
  errors: Array<{
    source: "osv" | "npm-registry" | "deps.dev";
    package?: { name: string; version: string };
    message: string;
  }>;
}

/**
 * Enriches only identities parsed from the submitted lockfile. OSV is the
 * advisory source of truth; npm and deps.dev are supplemental and are queried
 * only for exact versions with an OSV match.
 */
export async function enrichScan(
  normalized: NormalizedSnapshot,
  dependencies: ScanEnrichmentDependencies,
  options: { enabled: boolean; incidentCreatedAt: number },
): Promise<ScanEnrichmentResult> {
  const packages = exactPackages(normalized);
  if (!options.enabled) {
    return baseResult("disabled", "not-run", packages);
  }

  let osvResults: OsvExactQueryResult[];
  try {
    osvResults = await dependencies.osvClient.queryExactPackages(
      packages.map(({ package: value }) => ({
        ecosystem: "npm",
        name: value.name,
        version: value.version,
      })),
    );
    assertExactOsvResults(packages, osvResults);
  } catch (error) {
    dependencies.onExternalError?.();
    const result = baseResult("unavailable", "unavailable", packages);
    result.errors.push({ source: "osv", message: errorMessage(error) });
    return result;
  }

  const byKey = new Map(
    osvResults.map((result) => [packageKey(result.query.name, result.query.version), result]),
  );
  const supplementalEligible = packages.filter((value) => {
    const result = byKey.get(packageKey(value.package.name, value.package.version))!;
    return result.advisories.length > 0;
  });
  // Supplemental sources do not establish vulnerability truth. Bound and
  // parallelize them so a large advisory result cannot serialize unbounded
  // npm/deps.dev latency into the scan request.
  const supplementalRequests = new Map(
    supplementalEligible.slice(0, SUPPLEMENTAL_PACKAGE_LIMIT).map((value) => {
      const identity = value.package;
      return [
        packageKey(identity.name, identity.version),
        Promise.all([
          supplemental(
            "npm-registry",
            identity,
            dependencies.npmRegistryClient?.getVersion(identity.name, identity.version),
            dependencies.onExternalError,
          ),
          supplemental(
            "deps.dev",
            identity,
            dependencies.depsDevClient?.dependencies(identity.name, identity.version),
            dependencies.onExternalError,
          ),
        ]),
      ] as const;
    }),
  );
  const outputPackages: ScanEnrichmentPackageResult[] = [];
  const errors: ScanEnrichmentResult["errors"] = [];
  let packageMetadataChanged = false;

  for (const exactPackage of packages) {
    const key = packageKey(exactPackage.package.name, exactPackage.package.version);
    const osvResult = byKey.get(key)!;
    const advisoryIds = new Set(osvResult.advisoryIds);
    const advisories = osvResult.advisories
      .filter((advisory) => advisoryIds.has(advisory.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    const packageResult: ScanEnrichmentPackageResult = {
      package: exactPackage.package,
      usage: exactPackage.usage,
      advisoryStatus: advisories.length === 0 ? "no-known-advisory" : "matched",
      advisories: [],
    };

    let npmMetadata: NpmVersionMetadata | undefined;
    if (advisories.length > 0) {
      const [npm = {}, depsDev = {}] =
        await supplementalRequests.get(key) ?? [];
      if (npm.error !== undefined) errors.push(npm.error);
      if (depsDev.error !== undefined) errors.push(depsDev.error);
      if (npm.value !== undefined) {
        npmMetadata = npm.value;
        packageResult.npm = npmMetadata;
        dependencies.packageIntelligenceCatalog.register({
          name: npmMetadata.name,
          version: npmMetadata.version,
          maintainers: npmMetadata.maintainers,
          ...(npmMetadata.homepage === undefined ? {} : { homepage: npmMetadata.homepage }),
          ...(npmMetadata.repositoryUrl === undefined
            ? {}
            : { repositoryUrl: npmMetadata.repositoryUrl }),
          ...(npmMetadata.tarballUrl === undefined ? {} : { tarballUrl: npmMetadata.tarballUrl }),
          ...(npmMetadata.publishedAt === undefined ? {} : { publishedAt: npmMetadata.publishedAt }),
          ...(npmMetadata.createdAt === undefined ? {} : { createdAt: npmMetadata.createdAt }),
        });
        packageMetadataChanged = true;
      }
      if (depsDev.value !== undefined) {
        packageResult.depsDev = {
          nodes: depsDev.value.nodes.length,
          edges: depsDev.value.edges.length,
          provenance: depsDev.value.provenance,
        };
      }
    }

    for (const advisory of advisories) {
      const advisoryIndex = osvResult.advisoryIds.indexOf(advisory.id);
      const publishedAt = timestamp(advisory.published);
      const withdrawnAt = timestamp(advisory.withdrawn);
      const severityScore = numericSeverityScore(advisory);
      const incident = dependencies.incidentCatalog.createIncident(
        {
          ecosystem: "npm",
          packageName: exactPackage.package.name,
          affectedVersions: [exactPackage.package.version],
          advisoryId: advisory.id,
          source: "osv",
          windowSource: "osv-exact-package-version",
          windowConfidence: 1,
          ...(publishedAt === undefined ? {} : { advisoryPublishedAt: publishedAt }),
          ...(withdrawnAt === undefined ? {} : { advisoryWithdrawnAt: withdrawnAt }),
          ...(npmMetadata?.publishedAt === undefined
            ? {}
            : { packagePublishedAt: npmMetadata.publishedAt }),
          ...(severityScore === undefined ? {} : { severityScore }),
        },
        options.incidentCreatedAt,
      );
      await persistIncident(dependencies.graphStore, incident);
      packageResult.advisories.push({
        advisory,
        provenance: {
          source: "osv",
          matchType: "exact-package-version",
          query: structuredClone(osvResult.query),
          queryUrl: osvResult.provenance.queryUrl,
          advisoryUrl:
            osvResult.provenance.advisoryUrls[advisoryIndex] ??
            `${osvResult.provenance.queryUrl.replace(/\/v1\/querybatch$/u, "")}/v1/vulns/${encodeURIComponent(advisory.id)}`,
          lockfile: structuredClone(exactPackage.provenance),
        },
        incident,
      });
    }
    outputPackages.push(packageResult);
  }

  if (packageMetadataChanged) {
    await persistPackageIntelligence(
      dependencies.graphStore,
      dependencies.packageIntelligenceCatalog,
    );
  }
  const advisoryMatches = outputPackages.reduce(
    (total, value) => total + value.advisories.length,
    0,
  );
  return {
    status: errors.length === 0 ? "complete" : "partial",
    advisoryCheck: "complete",
    exactPackageQueries: packages.length,
    advisoryMatches,
    incidentsPersisted: advisoryMatches,
    confirmedNoKnownAdvisories: advisoryMatches === 0,
    supplemental: {
      eligiblePackages: supplementalEligible.length,
      attemptedPackages: supplementalRequests.size,
      packageLimit: SUPPLEMENTAL_PACKAGE_LIMIT,
    },
    packages: outputPackages,
    errors,
  };
}

function exactPackages(normalized: NormalizedSnapshot): Array<
  Pick<ScanEnrichmentPackageResult, "package" | "usage"> & {
    provenance: NormalizedPackageVersion["provenance"];
  }
> {
  return normalized.packages
    .map((value) => {
      const resolutions = normalized.resolutions.filter(
        ({ packageVersionId }) => packageVersionId === value.id,
      );
      return {
        package: {
          ecosystem: "npm" as const,
          name: value.normalizedName,
          version: value.version,
          packageVersionId: value.id,
        },
        usage: {
          direct: resolutions.some(({ direct }) => direct),
          developmentOnly:
            resolutions.length > 0 && resolutions.every(({ dev }) => dev),
        },
        provenance: value.provenance,
      };
    })
    .sort((left, right) =>
      left.package.name.localeCompare(right.package.name) ||
      left.package.version.localeCompare(right.package.version));
}

function assertExactOsvResults(
  packages: ReturnType<typeof exactPackages>,
  results: readonly OsvExactQueryResult[],
): void {
  if (results.length !== packages.length) {
    throw new Error("OSV result count did not match the exact package query count");
  }
  for (let index = 0; index < packages.length; index += 1) {
    const expected = packages[index]!.package;
    const actual = results[index]!.query;
    if (
      actual.ecosystem !== "npm" ||
      actual.name !== expected.name ||
      actual.version !== expected.version
    ) {
      throw new Error(
        `OSV result identity mismatch at index ${index}; refusing advisory association`,
      );
    }
    const advisoryIds = new Set(results[index]!.advisoryIds);
    const advisoryRecordIds = new Set(results[index]!.advisories.map(({ id }) => id));
    if (
      advisoryIds.size !== results[index]!.advisoryIds.length ||
      advisoryRecordIds.size !== results[index]!.advisories.length ||
      advisoryIds.size !== advisoryRecordIds.size ||
      [...advisoryIds].some((id) => !advisoryRecordIds.has(id))
    ) {
      throw new Error(
        "OSV advisory records did not exactly match the querybatch advisory IDs",
      );
    }
  }
}

function baseResult(
  status: "disabled" | "unavailable",
  advisoryCheck: "not-run" | "unavailable",
  packages: ReturnType<typeof exactPackages>,
): ScanEnrichmentResult {
  return {
    status,
    advisoryCheck,
    exactPackageQueries: status === "disabled" ? 0 : packages.length,
    advisoryMatches: 0,
    incidentsPersisted: 0,
    confirmedNoKnownAdvisories: false,
    supplemental: {
      eligiblePackages: 0,
      attemptedPackages: 0,
      packageLimit: SUPPLEMENTAL_PACKAGE_LIMIT,
    },
    packages: packages.map(({ provenance: _provenance, ...value }) => ({
      ...value,
      advisoryStatus: "not-checked",
      advisories: [],
    })),
    errors: [],
  };
}

async function supplemental<T>(
  source: "npm-registry" | "deps.dev",
  packageIdentity: { name: string; version: string },
  request: Promise<T> | undefined,
  onExternalError: (() => void) | undefined,
): Promise<{
  value?: T;
  error?: ScanEnrichmentResult["errors"][number];
}> {
  if (request === undefined) return {};
  try {
    return { value: await request };
  } catch (error) {
    onExternalError?.();
    return {
      error: {
        source,
        package: { name: packageIdentity.name, version: packageIdentity.version },
        message: errorMessage(error),
      },
    };
  }
}

function packageKey(name: string, version: string): string {
  return `${name}\0${version}`;
}

function timestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function numericSeverityScore(advisory: OsvAdvisorySummary): number | undefined {
  for (const { score } of advisory.severity) {
    const normalized = score.trim();
    if (/^\d+(?:\.\d+)?$/u.test(normalized)) {
      const numeric = Number(normalized);
      if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 10) {
        return numeric / 10;
      }
    }
    const cvssV3 = cvssV3BaseScore(normalized);
    if (cvssV3 !== undefined) return Math.round(cvssV3 * 10) / 100;
  }
  return undefined;
}

function cvssV3BaseScore(vector: string): number | undefined {
  const parts = vector.split("/");
  if (parts[0] !== "CVSS:3.0" && parts[0] !== "CVSS:3.1") return undefined;
  const metrics = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const [key, value, ...extra] = part.split(":");
    if (
      key === undefined ||
      value === undefined ||
      extra.length > 0 ||
      metrics.has(key)
    ) return undefined;
    metrics.set(key, value);
  }
  const scope = metrics.get("S");
  if (scope !== "U" && scope !== "C") return undefined;
  const attackVector = metricWeight(metrics, "AV", { N: 0.85, A: 0.62, L: 0.55, P: 0.2 });
  const attackComplexity = metricWeight(metrics, "AC", { L: 0.77, H: 0.44 });
  const privilegesRequired = metricWeight(
    metrics,
    "PR",
    scope === "C" ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 },
  );
  const userInteraction = metricWeight(metrics, "UI", { N: 0.85, R: 0.62 });
  const confidentiality = metricWeight(metrics, "C", { H: 0.56, L: 0.22, N: 0 });
  const integrity = metricWeight(metrics, "I", { H: 0.56, L: 0.22, N: 0 });
  const availability = metricWeight(metrics, "A", { H: 0.56, L: 0.22, N: 0 });
  const weights = [
    attackVector,
    attackComplexity,
    privilegesRequired,
    userInteraction,
    confidentiality,
    integrity,
    availability,
  ];
  if (weights.some((value) => value === undefined)) return undefined;

  const impact = 1 -
    (1 - confidentiality!) *
    (1 - integrity!) *
    (1 - availability!);
  const impactSubScore = scope === "U"
    ? 6.42 * impact
    : 7.52 * (impact - 0.029) - 3.25 * (impact - 0.02) ** 15;
  if (impactSubScore <= 0) return 0;
  const exploitability =
    8.22 * attackVector! * attackComplexity! * privilegesRequired! * userInteraction!;
  const raw = scope === "U"
    ? Math.min(impactSubScore + exploitability, 10)
    : Math.min(1.08 * (impactSubScore + exploitability), 10);
  return Math.ceil((raw - Number.EPSILON) * 10) / 10;
}

function metricWeight<K extends string>(
  metrics: ReadonlyMap<string, string>,
  key: string,
  weights: Readonly<Record<K, number>>,
): number | undefined {
  const value = metrics.get(key) as K | undefined;
  return value === undefined ? undefined : weights[value];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown enrichment error";
}
