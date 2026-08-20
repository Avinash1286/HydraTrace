import {
  normalizeNpmPackageName,
  sha256Hex,
  type OsvAdvisorySummary,
  type OsvPackageQuery,
} from "@hydratrace/domain";
import type { ResponseCache } from "./cache.js";

interface OsvBatchVulnerabilityReference {
  id: string;
  modified?: string;
}

interface OsvBatchResult {
  vulns?: OsvBatchVulnerabilityReference[];
  next_page_token?: string;
}

interface OsvBatchResponse {
  results: OsvBatchResult[];
}

interface OsvRecord {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: Array<{ type: string; score: string }>;
  published?: string;
  modified?: string;
  withdrawn?: string;
  affected?: unknown[];
  references?: Array<{ type: string; url: string }>;
}

export interface OsvExactQueryResult {
  query: OsvPackageQuery;
  advisoryIds: string[];
  advisories: OsvAdvisorySummary[];
  provenance: {
    source: "osv";
    matchType: "exact-package-version";
    queryUrl: string;
    advisoryUrls: string[];
  };
}

export interface OsvClientOptions {
  baseUrl?: string;
  cache: ResponseCache;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  cacheTtlMs?: number;
  maxBatchSize?: number;
}

export class OsvClient {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly maxBatchSize: number;

  public constructor(private readonly options: OsvClientOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.osv.dev").replace(/\/$/, "");
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60 * 1_000;
    this.maxBatchSize = options.maxBatchSize ?? 1_000;
  }

  public async queryExactPackages(
    uncheckedQueries: readonly OsvPackageQuery[],
  ): Promise<OsvExactQueryResult[]> {
    const queries = uncheckedQueries.map((query) => ({
      ecosystem: "npm" as const,
      name: normalizeNpmPackageName(query.name),
      version: query.version.trim(),
    }));
    for (const query of queries) {
      if (query.version.length === 0) throw new Error(`Missing exact version for ${query.name}`);
    }

    const advisoryIdsByIndex = queries.map(() => new Set<string>());
    for (let offset = 0; offset < queries.length; offset += this.maxBatchSize) {
      const batch = queries.slice(offset, offset + this.maxBatchSize);
      const batchIds = await this.queryBatchWithPagination(batch);
      batchIds.forEach((ids, index) => {
        for (const id of ids) advisoryIdsByIndex[offset + index]?.add(id);
      });
    }

    const uniqueAdvisoryIds = [
      ...new Set(advisoryIdsByIndex.flatMap((ids) => [...ids])),
    ].sort();
    const advisoryEntries = await Promise.all(
      uniqueAdvisoryIds.map(async (id) => [id, await this.getAdvisory(id)] as const),
    );
    const advisoryById = new Map(advisoryEntries);

    return queries.map((query, index) => {
      const advisoryIds = [...(advisoryIdsByIndex[index] ?? [])].sort();
      return {
        query,
        advisoryIds,
        advisories: advisoryIds.flatMap((id) => {
          const advisory = advisoryById.get(id);
          return advisory === undefined ? [] : [advisory];
        }),
        provenance: {
          source: "osv",
          matchType: "exact-package-version",
          queryUrl: `${this.baseUrl}/v1/querybatch`,
          advisoryUrls: advisoryIds.map(
            (id) => `${this.baseUrl}/v1/vulns/${encodeURIComponent(id)}`,
          ),
        },
      };
    });
  }

  public async getAdvisory(id: string): Promise<OsvAdvisorySummary> {
    const record = await this.cachedJson<OsvRecord>(
      "osv-advisory",
      `GET:/v1/vulns/${id}`,
      `${this.baseUrl}/v1/vulns/${encodeURIComponent(id)}`,
      { method: "GET", headers: { accept: "application/json" } },
    );
    if (record.id !== id) throw new Error(`OSV returned ${record.id} when ${id} was requested`);
    return normalizeAdvisory(record);
  }

  private async queryBatchWithPagination(
    queries: readonly OsvPackageQuery[],
  ): Promise<Array<Set<string>>> {
    const advisoryIds = queries.map(() => new Set<string>());
    let pending = queries.map((query, originalIndex) => ({ query, originalIndex }));
    const pageTokens = new Map<number, string>();

    while (pending.length > 0) {
      const requestBody = {
        queries: pending.map(({ query, originalIndex }) => ({
          package: { ecosystem: "npm", name: query.name },
          version: query.version,
          ...(pageTokens.get(originalIndex) === undefined
            ? {}
            : { page_token: pageTokens.get(originalIndex) }),
        })),
      };
      const serializedBody = JSON.stringify(requestBody);
      const response = await this.cachedJson<OsvBatchResponse>(
        "osv-querybatch",
        `POST:/v1/querybatch:${sha256Hex(serializedBody)}`,
        `${this.baseUrl}/v1/querybatch`,
        {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: serializedBody,
        },
      );
      if (!Array.isArray(response.results) || response.results.length !== pending.length) {
        throw new Error("OSV querybatch response ordering/count did not match the request");
      }

      const nextPending: typeof pending = [];
      response.results.forEach((result, pendingIndex) => {
        const request = pending[pendingIndex];
        if (request === undefined) return;
        for (const vulnerability of result.vulns ?? []) {
          if (typeof vulnerability.id === "string") {
            advisoryIds[request.originalIndex]?.add(vulnerability.id);
          }
        }
        if (typeof result.next_page_token === "string" && result.next_page_token.length > 0) {
          pageTokens.set(request.originalIndex, result.next_page_token);
          nextPending.push(request);
        }
      });
      pending = nextPending;
    }

    return advisoryIds;
  }

  private async cachedJson<T>(
    namespace: string,
    requestKey: string,
    url: string,
    init: RequestInit,
  ): Promise<T> {
    const now = this.now();
    const cached = await this.options.cache.get<T>(namespace, requestKey, now);
    if (cached !== undefined) return cached.body;

    const response = await this.fetchImplementation(url, {
      ...init,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`OSV ${init.method ?? "GET"} ${url} failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as T;
    const etag = response.headers.get("etag");
    const stored = await this.options.cache.put(namespace, requestKey, {
      fetchedAt: now,
      expiresAt: now + this.cacheTtlMs,
      status: response.status,
      ...(etag === null ? {} : { etag }),
      body,
    });
    return stored.body;
  }
}

function normalizeAdvisory(record: OsvRecord): OsvAdvisorySummary {
  return {
    id: record.id,
    aliases: record.aliases ?? [],
    summary: record.summary ?? record.details ?? "No summary provided",
    severity: record.severity ?? [],
    ...(record.published === undefined ? {} : { published: record.published }),
    ...(record.modified === undefined ? {} : { modified: record.modified }),
    ...(record.withdrawn === undefined ? {} : { withdrawn: record.withdrawn }),
    affected: record.affected ?? [],
    references: record.references ?? [],
    source: "osv",
  };
}
