import { normalizeNpmPackageName } from "@hydratrace/domain";
import type { ResponseCache } from "./cache.js";

export interface DepsDevDependencyNode {
  versionKey: { system: string; name: string; version: string };
  relation: string;
  errors: readonly string[];
}

export interface DepsDevGraph {
  nodes: readonly DepsDevDependencyNode[];
  edges: readonly { fromNode: number; toNode: number; requirement: string }[];
  provenance: {
    source: "deps.dev";
    matchType: "exact-package-version";
    dependenciesUrl: string;
  };
}

export interface DepsDevClientOptions {
  cache: ResponseCache;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  cacheTtlMs?: number;
}

export class DepsDevClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #ttl: number;

  public constructor(private readonly options: DepsDevClientOptions) {
    this.#baseUrl = (options.baseUrl ?? "https://api.deps.dev/v3").replace(/\/$/u, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#ttl = options.cacheTtlMs ?? 24 * 60 * 60 * 1_000;
  }

  public async dependencies(name: string, version: string): Promise<DepsDevGraph> {
    const packageName = normalizeNpmPackageName(name);
    const exactVersion = version.trim();
    if (!exactVersion) throw new Error("Exact deps.dev version is required");
    const key = `${packageName}@${exactVersion}`;
    const url = `${this.#baseUrl}/systems/npm/packages/${encodeURIComponent(packageName)}/versions/${encodeURIComponent(exactVersion)}:dependencies`;
    const provenance = {
      source: "deps.dev" as const,
      matchType: "exact-package-version" as const,
      dependenciesUrl: url,
    };
    const now = this.#now();
    const cached = await this.options.cache.get<Partial<DepsDevGraph>>(
      "deps-dev",
      key,
      now,
    );
    if (cached !== undefined) {
      return {
        nodes: Array.isArray(cached.body.nodes) ? cached.body.nodes : [],
        edges: Array.isArray(cached.body.edges) ? cached.body.edges : [],
        provenance,
      };
    }
    const response = await this.#fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`deps.dev returned ${response.status} for ${key}`);
    const value = await response.json() as Partial<DepsDevGraph>;
    const body: DepsDevGraph = {
      nodes: Array.isArray(value.nodes) ? value.nodes : [],
      edges: Array.isArray(value.edges) ? value.edges : [],
      provenance,
    };
    await this.options.cache.put("deps-dev", key, {
      fetchedAt: now,
      expiresAt: now + this.#ttl,
      status: response.status,
      body,
    });
    return body;
  }
}
