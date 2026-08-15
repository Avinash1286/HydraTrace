import { describe, expect, it, vi } from "vitest";
import { MemoryResponseCache } from "./cache.js";
import { OsvClient } from "./osv.js";

describe("OSV exact-version enrichment", () => {
  it("preserves batch ordering, retrieves full records, and reuses the cache", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/querybatch")) {
        return Response.json({
          results: [
            { vulns: [{ id: "GHSA-test-0001", modified: "2026-08-15T00:00:00Z" }] },
            { vulns: [] },
          ],
        });
      }
      if (url.endsWith("/v1/vulns/GHSA-test-0001")) {
        return Response.json({
          id: "GHSA-test-0001",
          aliases: ["CVE-2026-0001"],
          summary: "Fixture advisory",
          affected: [],
          references: [],
        });
      }
      return new Response("not found", { status: 404 });
    });
    const client = new OsvClient({
      cache: new MemoryResponseCache(),
      fetch: fetchMock,
      now: () => 1_786_700_000_000,
    });
    const queries = [
      { ecosystem: "npm" as const, name: "lodash", version: "4.17.20" },
      { ecosystem: "npm" as const, name: "safe-helper", version: "1.0.0" },
    ];

    const first = await client.queryExactPackages(queries);
    const second = await client.queryExactPackages(queries);

    expect(first[0]?.advisoryIds).toEqual(["GHSA-test-0001"]);
    expect(first[0]?.advisories[0]?.aliases).toEqual(["CVE-2026-0001"]);
    expect(first[1]?.advisories).toEqual([]);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("follows per-query pagination tokens", async () => {
    let batchCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/querybatch")) {
        batchCalls += 1;
        return Response.json(
          batchCalls === 1
            ? { results: [{ vulns: [{ id: "OSV-1" }], next_page_token: "next" }] }
            : { results: [{ vulns: [{ id: "OSV-2" }] }] },
        );
      }
      const id = url.endsWith("OSV-1") ? "OSV-1" : "OSV-2";
      return Response.json({ id, affected: [], references: [] });
    });
    const client = new OsvClient({
      cache: new MemoryResponseCache(),
      fetch: fetchMock,
      now: () => 1,
    });

    const [result] = await client.queryExactPackages([
      { ecosystem: "npm", name: "example", version: "1.0.0" },
    ]);
    expect(result?.advisoryIds).toEqual(["OSV-1", "OSV-2"]);
    expect(batchCalls).toBe(2);
  });
});
