import { normalizeNpmPackageName } from "@hydratrace/domain";
import type { ResponseCache } from "./cache.js";

export interface NpmVersionMetadata {
  name: string;
  version: string;
  deprecated?: string;
  homepage?: string;
  repositoryUrl?: string;
  tarballUrl?: string;
  integrity?: string;
  maintainers: readonly { name?: string; email?: string; source: "npm-registry" }[];
  publishedAt?: number;
  createdAt?: number;
  provenance: {
    source: "npm-registry";
    matchType: "exact-package-version";
    packageUrl: string;
  };
}

export interface NpmAvailableVersion {
  name: string;
  version: string;
  deprecated?: string;
  provenance: {
    source: "npm-registry";
    matchType: "exact-package-version";
    packageUrl: string;
  };
}
export interface NpmRegistryClientOptions { cache: ResponseCache; baseUrl?: string; fetch?: typeof globalThis.fetch; now?: () => number; cacheTtlMs?: number; }

export class NpmRegistryClient {
  readonly #baseUrl: string; readonly #fetch: typeof globalThis.fetch; readonly #now: () => number; readonly #ttl: number;
  constructor(private readonly options: NpmRegistryClientOptions) { this.#baseUrl = (options.baseUrl ?? "https://registry.npmjs.org").replace(/\/$/u, ""); this.#fetch = options.fetch ?? globalThis.fetch; this.#now = options.now ?? Date.now; this.#ttl = options.cacheTtlMs ?? 24 * 60 * 60 * 1_000; }
  async getVersion(name: string, version: string): Promise<NpmVersionMetadata> {
    const packageName = normalizeNpmPackageName(name); const exactVersion = version.trim(); if (exactVersion.length === 0) throw new Error("Exact npm version is required");
    const record = await this.#json<Packument>(packageName);
    const release = record.versions?.[exactVersion]; if (release === undefined) throw new Error(`${packageName}@${exactVersion} was not found in npm registry metadata`);
    return {
      name: packageName, version: exactVersion,
      ...(typeof release.deprecated === "string" ? { deprecated: release.deprecated } : {}),
      ...(typeof release.homepage === "string" ? { homepage: release.homepage } : {}),
      ...(repositoryUrl(release.repository ?? record.repository) === undefined ? {} : { repositoryUrl: repositoryUrl(release.repository ?? record.repository)! }),
      ...(typeof release.dist?.tarball === "string" ? { tarballUrl: release.dist.tarball } : {}),
      ...(typeof release.dist?.integrity === "string" ? { integrity: release.dist.integrity } : {}),
      maintainers: (release.maintainers ?? record.maintainers ?? []).map((maintainer) => ({ ...(typeof maintainer.name === "string" ? { name: maintainer.name } : {}), ...(typeof maintainer.email === "string" ? { email: maintainer.email } : {}), source: "npm-registry" as const })),
      ...(parseTime(record.time?.[exactVersion]) === undefined ? {} : { publishedAt: parseTime(record.time?.[exactVersion])! }),
      ...(parseTime(record.time?.created) === undefined ? {} : { createdAt: parseTime(record.time?.created)! }),
      provenance: {
        source: "npm-registry",
        matchType: "exact-package-version",
        packageUrl: `${this.#baseUrl}/${encodeURIComponent(packageName)}`,
      },
    };
  }

  /**
   * Returns only versions that are explicitly present in the npm packument.
   * Candidate selection must never infer that a semver exists from its shape.
   */
  async listVersions(name: string): Promise<NpmAvailableVersion[]> {
    const packageName = normalizeNpmPackageName(name);
    const record = await this.#json<Packument>(packageName);
    const packageUrl = `${this.#baseUrl}/${encodeURIComponent(packageName)}`;
    return Object.entries(record.versions ?? {})
      .map(([version, release]) => ({
        name: packageName,
        version,
        ...(typeof release.deprecated === "string" ? { deprecated: release.deprecated } : {}),
        provenance: {
          source: "npm-registry" as const,
          matchType: "exact-package-version" as const,
          packageUrl,
        },
      }))
      .sort((left, right) => left.version.localeCompare(right.version));
  }
  async #json<T>(packageName: string): Promise<T> { const key = `GET:${packageName}`; const now = this.#now(); const cached = await this.options.cache.get<T>("npm-registry", key, now); if (cached !== undefined) return cached.body; const response = await this.#fetch(`${this.#baseUrl}/${encodeURIComponent(packageName)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) }); if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${packageName}`); const body = await response.json() as T; await this.options.cache.put("npm-registry", key, { fetchedAt: now, expiresAt: now + this.#ttl, status: response.status, ...(response.headers.get("etag") === null ? {} : { etag: response.headers.get("etag")! }), body }); return body; }
}

interface Human { name?: unknown; email?: unknown; }
interface VersionRecord { deprecated?: unknown; homepage?: unknown; repository?: unknown; dist?: { tarball?: unknown; integrity?: unknown }; maintainers?: Human[]; }
interface Packument { versions?: Record<string, VersionRecord>; time?: Record<string, string>; maintainers?: Human[]; repository?: unknown; }
function repositoryUrl(value: unknown): string | undefined { if (typeof value === "string") return value; if (value !== null && typeof value === "object" && "url" in value && typeof value.url === "string") return value.url; return undefined; }
function parseTime(value: string | undefined): number | undefined { if (value === undefined) return undefined; const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined; }
