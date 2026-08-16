import {
  Node,
  Path,
  PathSegment,
  Relationship,
  int,
  isInt,
  type Driver,
  type QueryResult,
} from "neo4j-driver";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HydraDbGraphStore,
  hydraDbConnectionOptionsFromEnv,
} from "./bolt.js";
import { createHydraDbSmokeFixture } from "./smoke.js";

interface CapturedQuery {
  cypher: string;
  parameters: Record<string, unknown>;
}

describe("HydraDbGraphStore v0.1.1 compatibility", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("maps the graph auth token to the official Bolt connection options", () => {
    expect(
      hydraDbConnectionOptionsFromEnv({
        HYDRADB_BOLT_URI: "bolt://127.0.0.1:7687",
        HYDRADB_AUTH_TOKEN: "secret-token",
      }),
    ).toEqual({
      uri: "bolt://127.0.0.1:7687",
      authToken: "secret-token",
      database: "default",
      consistency: "causal",
    });
  });

  it("emits only documented scalar batch forms with lossless integer IDs", async () => {
    const captured: CapturedQuery[] = [];
    const store = new HydraDbGraphStore(fakeDriver(captured), { batchSize: 50 });
    const fixture = createHydraDbSmokeFixture();

    const summary = await store.write(fixture.records);

    expect(summary.nodes.created).toBe(4);
    expect(summary.relationships.created).toBe(3);
    const cypher = captured.map(({ cypher: query }) => query).join("\n");
    expect(cypher).toContain("UNWIND $rows AS row\nMERGE (n {id: row.vertex})");
    expect(cypher).toContain("MERGE (from)-[r:DEPENDS_ON_INSTANCE");
    expect(cypher).toContain(
      "SET r.hydratraceStableId = row.relationship_vertex",
    );
    expect(cypher).toContain(
      "WHERE r.hydratraceStableId = $id0 OR r.hydratraceStableId = $id1",
    );
    expect(cypher).toContain("RETURN r.hydratraceStableId AS id");
    expect(cypher).not.toContain("RETURN r.id AS id");
    expect(cypher).not.toMatch(/\bIN\b|labels\(|properties\(|type\(|\+=/);

    const nodeWrite = captured.find(({ cypher: query }) =>
      query.includes("SET n:Resolution"),
    );
    const rows = nodeWrite?.parameters.rows as
      | Array<Record<string, unknown>>
      | undefined;
    expect(isInt(rows?.[0]?.vertex)).toBe(true);
    expect(rows?.[0]?.vertex?.toString()).toBe(fixture.expectedNodeIds[0]);
    expect(isInt(rows?.[0]?.observedAt)).toBe(true);
  });

  it("uses SPpaths and hydrates canonical IDs from lossless Bolt values", async () => {
    const fixture = createHydraDbSmokeFixture();
    const captured: CapturedQuery[] = [];
    const path = boltPath(
      fixture.expectedNodeIds,
      fixture.expectedRelationshipIds,
    );
    const store = new HydraDbGraphStore(fakeDriver(captured, path));

    const paths = await store.findPaths({
      from: { id: fixture.expectedNodeIds[0]!, label: "Resolution" },
      to: { id: fixture.expectedNodeIds[3]!, label: "Resolution" },
      relationshipType: "DEPENDS_ON_INSTANCE",
      minDepth: 3,
      maxDepth: 3,
      limit: 2,
    });

    expect(paths).toEqual([
      {
        nodeIds: fixture.expectedPath,
        relationshipIds: fixture.expectedRelationshipIds,
      },
    ]);
    const call = captured.at(-1);
    expect(call?.cypher).toContain("CALL algo.SPpaths");
    expect(isInt(call?.parameters.maxLen)).toBe(true);
    expect(isInt(call?.parameters.pathCount)).toBe(true);
    expect(isInt(call?.parameters.resultLimit)).toBe(true);
  });

  it("uses the strong HTTP path API without losing 63-bit IDs", async () => {
    const fixture = createHydraDbSmokeFixture();
    const body = JSON.stringify({
      rows: [[{
        type: "path",
        value: {
          nodes: fixture.expectedNodeIds.map((id) => ({ id: `__${id}__` })),
          relationships: fixture.expectedRelationshipIds.map((id) => ({
            properties: { hydratraceStableId: { Integer: `__${id}__` } },
          })),
        },
      }]],
    }).replace(/"__(\d+)__"/gu, "$1");
    const request = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(body),
    );
    vi.stubGlobal("fetch", request);
    const captured: CapturedQuery[] = [];
    const store = new HydraDbGraphStore(fakeDriver(captured), {
      consistency: "strong",
      strongHttp: {
        url: "http://hydradb.test:8443",
        authToken: "test-token",
        namespace: "development",
      },
    });

    const paths = await store.findPaths({
      from: { id: fixture.expectedNodeIds[0]!, label: "Resolution" },
      to: { id: fixture.expectedNodeIds[3]!, label: "Resolution" },
      relationshipType: "DEPENDS_ON_INSTANCE",
      minDepth: 3,
      maxDepth: 3,
      limit: 2,
    });

    expect(paths).toEqual([{
      nodeIds: fixture.expectedPath,
      relationshipIds: fixture.expectedRelationshipIds,
    }]);
    expect(captured).toHaveLength(0);
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]?.[1]?.body)).toContain(
      '"consistency":"strong"',
    );
  });
});

function fakeDriver(captured: CapturedQuery[], path?: Path): Driver {
  return {
    verifyConnectivity: async () => undefined,
    close: async () => undefined,
    session: () => ({
      run: async (
        cypher: string,
        parameters: Record<string, unknown> = {},
      ): Promise<QueryResult> => {
        captured.push({ cypher, parameters });
        if (cypher.includes("CALL algo.SPpaths") && path !== undefined) {
          return {
            records: [{ get: (key: string) => (key === "path" ? path : undefined) }],
          } as unknown as QueryResult;
        }
        return { records: [] } as unknown as QueryResult;
      },
      close: async () => undefined,
    }),
  } as unknown as Driver;
}

function boltPath(
  nodeIds: readonly string[],
  relationshipIds: readonly string[],
): Path {
  const nodes = nodeIds.map(
    (id) => new Node(int(id), ["Resolution"], {}, id),
  );
  const segments = relationshipIds.map((id, index) => {
    const start = nodes[index];
    const end = nodes[index + 1];
    if (start === undefined || end === undefined) {
      throw new Error("invalid path fixture");
    }
    const relationship = new Relationship(
      int(index + 1),
      start.identity,
      end.identity,
      "DEPENDS_ON_INSTANCE",
      { hydratraceStableId: int(id), id: int(id) },
      String(index + 1),
      start.elementId,
      end.elementId,
    );
    return new PathSegment(start, relationship, end);
  });
  const start = nodes[0];
  const end = nodes.at(-1);
  if (start === undefined || end === undefined) throw new Error("empty path fixture");
  return new Path(start, end, segments);
}
