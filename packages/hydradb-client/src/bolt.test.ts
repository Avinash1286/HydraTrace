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

  it("splits an idempotent write batch when HydraDB reaches its fixed runtime limit", async () => {
    const captured: CapturedQuery[] = [];
    const store = new HydraDbGraphStore(fakeDriver(captured, undefined, true), { batchSize: 50 });
    const fixture = createHydraDbSmokeFixture();

    await expect(store.write(fixture.records)).resolves.toMatchObject({
      nodes: { created: 4 },
      relationships: { created: 3 },
    });

    const writeSizes = captured
      .filter(({ cypher }) => cypher.startsWith("UNWIND $rows AS row"))
      .map(({ parameters }) => (parameters.rows as unknown[]).length);
    expect(writeSizes).toContain(4);
    expect(writeSizes).toContain(3);
    expect(writeSizes.filter((size) => size === 1).length).toBeGreaterThan(1);
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

  it.each(["causal", "strong"] as const)(
    "uses the %s HTTP path API without losing 63-bit IDs",
    async (consistency) => {
      const fixture = createHydraDbSmokeFixture();
      const request = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          ndjsonResponse([
            { type: "header", query_id: "path-1", columns: ["path"], read_epoch: 8 },
            {
              type: "row",
              values: [{
                type: "path",
                value: {
                  nodes: fixture.expectedNodeIds.map((id) => ({ id: rawInteger(id) })),
                  relationships: fixture.expectedRelationshipIds.map((id) => ({
                    properties: {
                      hydratraceStableId: { Integer: rawInteger(id) },
                    },
                  })),
                },
              }],
            },
            { type: "summary", bookmark: null, has_more: false },
          ]),
      );
      vi.stubGlobal("fetch", request);
      const captured: CapturedQuery[] = [];
      const store = new HydraDbGraphStore(fakeDriver(captured), {
        consistency,
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
      const init = request.mock.calls[0]?.[1];
      const requestBody = String(init?.body);
      expect(new Headers(init?.headers).get("accept")).toBe("application/x-ndjson");
      expect(requestBody).toContain(`"consistency":"${consistency}"`);
      expect(requestBody).toContain(`"source":${fixture.expectedNodeIds[0]}`);
      expect(requestBody).not.toContain(
        `"source":"${fixture.expectedNodeIds[0]}"`,
      );
    },
  );

  it("rejects a truncated HTTP path stream without a terminal summary", async () => {
    const fixture = createHydraDbSmokeFixture();
    const request = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        ndjsonResponse([
          { type: "header", query_id: "truncated-1", columns: ["path"], read_epoch: 9 },
        ]),
    );
    vi.stubGlobal("fetch", request);
    const captured: CapturedQuery[] = [];
    const store = new HydraDbGraphStore(fakeDriver(captured), {
      strongHttp: {
        url: "http://hydradb.test:8443",
        authToken: "test-token",
        namespace: "development",
      },
    });

    await expect(store.findPaths({
      from: { id: fixture.expectedNodeIds[0]!, label: "Resolution" },
      to: { id: fixture.expectedNodeIds[3]!, label: "Resolution" },
      relationshipType: "DEPENDS_ON_INSTANCE",
      minDepth: 3,
      maxDepth: 3,
      limit: 2,
    })).rejects.toThrow(/without a terminal summary.*possibly truncated/u);
    expect(captured).toHaveLength(0);
  });

  it("serializes concurrent match/get reads across Bolt sessions", async () => {
    const firstRunStarted = deferred();
    const releaseFirstRun = deferred();
    const state = boltConcurrencyState();
    const store = new HydraDbGraphStore(instrumentedDriver(
      state,
      async (call) => {
        if (call === 1) {
          firstRunStarted.resolve();
          await releaseFirstRun.promise;
        }
        return emptyQueryResult();
      },
    ));
    const fixture = createHydraDbSmokeFixture();

    const reads = Promise.all([
      store.matchNodes({ label: "Organization", limit: 1 }),
      store.getNodes([fixture.expectedNodeIds[0]!]),
    ]);
    await firstRunStarted.promise;
    await Promise.resolve();
    const callsWhileFirstRunWasBlocked = state.runCalls;
    releaseFirstRun.resolve();

    await expect(reads).resolves.toEqual([[], []]);
    expect(callsWhileFirstRunWasBlocked).toBe(1);
    expect(state.runCalls).toBeGreaterThan(1);
    expect(state.maxActiveRuns).toBe(1);
    expect(state.maxActiveSessions).toBe(1);
    expect(state.activeRuns).toBe(0);
    expect(state.activeSessions).toBe(0);
    expect(state.closes).toBe(state.sessions);
  });

  it("releases the Bolt serialization queue after a query failure", async () => {
    const firstRunStarted = deferred();
    const releaseFirstRun = deferred();
    const state = boltConcurrencyState();
    const store = new HydraDbGraphStore(instrumentedDriver(
      state,
      async (call) => {
        if (call === 1) {
          firstRunStarted.resolve();
          await releaseFirstRun.promise;
          throw new Error("planned Bolt failure");
        }
        return emptyQueryResult();
      },
    ));

    const failedRead = store.matchNodes({ label: "Organization", limit: 1 });
    const failure = expect(failedRead).rejects.toThrow("planned Bolt failure");
    const nextRead = store.matchNodes({ label: "Environment", limit: 1 });
    await firstRunStarted.promise;
    await Promise.resolve();
    const callsWhileFirstRunWasBlocked = state.runCalls;
    releaseFirstRun.resolve();

    await failure;
    await expect(nextRead).resolves.toEqual([]);
    expect(callsWhileFirstRunWasBlocked).toBe(1);
    expect(state.runCalls).toBe(2);
    expect(state.maxActiveRuns).toBe(1);
    expect(state.maxActiveSessions).toBe(1);
    expect(state.closes).toBe(2);
  });
});

interface BoltConcurrencyState {
  runCalls: number;
  activeRuns: number;
  maxActiveRuns: number;
  sessions: number;
  activeSessions: number;
  maxActiveSessions: number;
  closes: number;
}

function boltConcurrencyState(): BoltConcurrencyState {
  return {
    runCalls: 0,
    activeRuns: 0,
    maxActiveRuns: 0,
    sessions: 0,
    activeSessions: 0,
    maxActiveSessions: 0,
    closes: 0,
  };
}

function instrumentedDriver(
  state: BoltConcurrencyState,
  execute: (call: number) => Promise<QueryResult>,
): Driver {
  return {
    verifyConnectivity: async () => undefined,
    close: async () => undefined,
    session: () => {
      state.sessions += 1;
      state.activeSessions += 1;
      state.maxActiveSessions = Math.max(
        state.maxActiveSessions,
        state.activeSessions,
      );
      let closed = false;
      return {
        run: async (): Promise<QueryResult> => {
          state.runCalls += 1;
          const call = state.runCalls;
          state.activeRuns += 1;
          state.maxActiveRuns = Math.max(state.maxActiveRuns, state.activeRuns);
          try {
            return await execute(call);
          } finally {
            state.activeRuns -= 1;
          }
        },
        close: async () => {
          if (closed) return;
          closed = true;
          state.closes += 1;
          state.activeSessions -= 1;
        },
      };
    },
  } as unknown as Driver;
}

function emptyQueryResult(): QueryResult {
  return { records: [] } as unknown as QueryResult;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function rawInteger(value: string): string {
  return `__RAW_INTEGER_${value}__`;
}

function ndjsonResponse(lines: readonly unknown[]): Response {
  const body = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
    .replace(/"__RAW_INTEGER_(-?\d+)__"/gu, "$1");
  return new Response(body, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
}

function fakeDriver(
  captured: CapturedQuery[],
  path?: Path,
  failLargeWrites = false,
): Driver {
  return {
    verifyConnectivity: async () => undefined,
    close: async () => undefined,
    session: () => ({
      run: async (
        cypher: string,
        parameters: Record<string, unknown> = {},
      ): Promise<QueryResult> => {
        captured.push({ cypher, parameters });
        if (
          failLargeWrites &&
          cypher.startsWith("UNWIND $rows AS row") &&
          Array.isArray(parameters.rows) &&
          parameters.rows.length > 1
        ) {
          const error = new Error("client_query_runtime exceeded query timeout after 29999 ms; limit is 29999 ms") as Error & { code: string };
          error.code = "Neo.ClientError.Transaction.Terminated";
          throw error;
        }
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
