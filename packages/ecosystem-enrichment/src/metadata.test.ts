import { describe, expect, it, vi } from "vitest";
import { MemoryResponseCache } from "./cache.js";
import { DepsDevClient } from "./deps-dev.js";
import { NpmRegistryClient } from "./npm-registry.js";

describe("public ecosystem metadata clients", () => {
  it("normalizes exact npm version metadata and caches it", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      name: "fixture",
      time: { created: "2026-01-01T00:00:00.000Z", "1.2.3": "2026-02-01T00:00:00.000Z" },
      versions: { "1.2.3": { version: "1.2.3", homepage: "https://example.com", repository: { url: "git+https://github.com/example/fixture.git" }, maintainers: [{ name: "Alice", email: "alice@example.com" }], dist: { tarball: "https://registry.npmjs.org/fixture/-/fixture-1.2.3.tgz", integrity: "sha512-test" } } },
    }), { status: 200, headers: { etag: "fixture" } }));
    const client = new NpmRegistryClient({ cache: new MemoryResponseCache(), fetch: fetch as typeof globalThis.fetch, now: () => 10 });
    const first = await client.getVersion("Fixture", "1.2.3");
    const second = await client.getVersion("Fixture", "1.2.3");
    expect(first).toMatchObject({ name: "fixture", version: "1.2.3", repositoryUrl: "git+https://github.com/example/fixture.git", maintainers: [{ name: "Alice", email: "alice@example.com", source: "npm-registry" }] });
    expect(second).toEqual(first); expect(fetch).toHaveBeenCalledOnce();
  });

  it("reads the exact deps.dev dependency graph", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ nodes: [{ versionKey: { system: "NPM", name: "fixture", version: "1.0.0" }, relation: "SELF", errors: [] }], edges: [] }), { status: 200 }));
    const client = new DepsDevClient({ cache: new MemoryResponseCache(), fetch: fetch as typeof globalThis.fetch });
    const graph = await client.dependencies("fixture", "1.0.0");
    expect(graph.nodes).toHaveLength(1); expect(graph.edges).toEqual([]);
  });
});
