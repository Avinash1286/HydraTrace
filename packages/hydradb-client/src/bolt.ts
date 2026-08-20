import { readFileSync } from "node:fs";
import type { StableId } from "@hydratrace/domain";
import {
  NODE_LABELS,
  RELATIONSHIP_ENDPOINT_LABELS,
  RELATIONSHIP_TYPES,
  isNodeLabel,
  isRelationshipType,
  type GraphNodeRecord,
  type GraphPath,
  type GraphRecords,
  type GraphRelationshipRecord,
  type NodeLabel,
  type NodePropertiesByLabel,
  type RelationshipPropertiesByType,
  type RelationshipType,
} from "@hydratrace/graph-schema";
import {
  auth,
  driver as createDriver,
  int,
  isInt,
  isPath,
  type Driver,
  type QueryResult,
} from "neo4j-driver";
import {
  GraphConflictError,
  graphRecordsSemanticallyEqual,
  type GraphPathQuery,
  type GraphNodeQuery,
  type GraphRelationshipQuery,
  type GraphStore,
  type GraphWriteSummary,
  MissingGraphEndpointError,
  validatePathQuery,
  validateGraphQueryLimit,
  writeCounts,
} from "./graph-store.js";

export interface HydraDbConnectionOptions {
  uri: string;
  httpUrl?: string;
  authToken?: string;
  database?: string;
  namespace?: string;
  graphId?: string;
  cellId?: string;
  batchSize?: number;
  consistency?: "causal" | "strong";
}

// HydraDB v0.1.1 reserves `id` as the relationship's internal identity when
// writing, but its row-query executor cannot project or predicate on `r.id`.
// Mirror the canonical ID into ordinary relationship metadata for lossless,
// batched reads while retaining `id` for MERGE identity and path hydration.
const RELATIONSHIP_STABLE_ID_PROPERTY = "hydratraceStableId";

export function hydraDbConnectionOptionsFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): HydraDbConnectionOptions {
  const uri = environment.HYDRADB_BOLT_URI?.trim();
  if (uri === undefined || uri === "") {
    throw new Error("HYDRADB_BOLT_URI is required for a HydraDB connection");
  }
  let authToken = (
    environment.HYDRADB_AUTH_TOKEN ?? environment.HYDRADB_PASSWORD
  )?.trim();
  const authTokenFile = environment.HYDRADB_AUTH_TOKEN_FILE?.trim();
  if ((authToken === undefined || authToken === "") && authTokenFile) {
    try {
      authToken = readFileSync(authTokenFile, "utf8").trim();
    } catch (error) {
      throw new Error(
        `Could not read HYDRADB_AUTH_TOKEN_FILE: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (authToken === undefined || authToken === "") {
    throw new Error("HYDRADB_AUTH_TOKEN is required for a HydraDB Bolt connection");
  }
  const database = environment.HYDRADB_DATABASE?.trim() || "default";
  const rawConsistency = environment.HYDRADB_CONSISTENCY?.trim() || "causal";
  if (rawConsistency !== "causal" && rawConsistency !== "strong") {
    throw new Error("HYDRADB_CONSISTENCY must be either causal or strong");
  }
  return {
    uri,
    authToken,
    database,
    consistency: rawConsistency,
    ...(environment.HYDRADB_HTTP_URL?.trim()
      ? { httpUrl: environment.HYDRADB_HTTP_URL.trim() }
      : {}),
    ...(environment.HYDRADB_NAMESPACE?.trim()
      ? { namespace: environment.HYDRADB_NAMESPACE.trim() }
      : {}),
    ...(environment.HYDRADB_GRAPH_ID?.trim()
      ? { graphId: environment.HYDRADB_GRAPH_ID.trim() }
      : {}),
    ...(environment.HYDRADB_CELL_ID?.trim()
      ? { cellId: environment.HYDRADB_CELL_ID.trim() }
      : {}),
  };
}

export function createHydraDbDriver(options: HydraDbConnectionOptions): Driver {
  // HydraDB v0.1.1 maps Bolt auth to basic auth with principal `neo4j` and
  // the graph auth token as the credential (the HTTP API uses Bearer instead).
  const token = options.authToken
    ? auth.basic("neo4j", options.authToken)
    : undefined;
  // neo4j-driver 5.27 is intentionally pinned: later drivers use the Bolt
  // manifest handshake, whose fragmented response is incompatible with this
  // HydraDB release. Stable IDs also require lossless signed 63-bit integers.
  return createDriver(options.uri, token);
}

/**
 * HydraDB v0.1.1 adapter restricted to its documented OpenCypher subset.
 * Bolt handles scalar reads and writes; configured path reads use the HTTP
 * query stream for deterministic completion and lossless integer handling.
 */
export class HydraDbGraphStore implements GraphStore {
  readonly #driver: Driver;
  readonly #database: string | undefined;
  readonly #batchSize: number;
  readonly #consistency: "causal" | "strong";
  #boltQueryTail: Promise<void> = Promise.resolve();
  readonly #strongHttp:
    | {
        url: string;
        authToken: string;
        namespace: string;
        graphId: string;
        cellId: string;
      }
    | undefined;

  constructor(
    driver: Driver,
    options: {
      database?: string;
      batchSize?: number;
      consistency?: "causal" | "strong";
      strongHttp?: {
        url: string;
        authToken: string;
        namespace?: string;
        graphId?: string;
        cellId?: string;
      };
    } = {},
  ) {
    this.#driver = driver;
    this.#database = options.database;
    // HydraDB v0.1.1 has both a shallow expression ceiling and a fixed 29,999ms
    // query runtime. Four records keeps cold object-store reads/writes bounded;
    // timed-out idempotent writes are split further below.
    this.#batchSize = options.batchSize ?? 4;
    this.#consistency = options.consistency ?? "causal";
    this.#strongHttp = options.strongHttp === undefined
      ? undefined
      : {
          url: options.strongHttp.url.replace(/\/$/u, ""),
          authToken: options.strongHttp.authToken,
          namespace: options.strongHttp.namespace ?? "default",
          graphId: options.strongHttp.graphId ?? "default",
          cellId: options.strongHttp.cellId ?? "cell-0",
        };
    if (!Number.isInteger(this.#batchSize) || this.#batchSize < 1) {
      throw new RangeError("batchSize must be a positive integer");
    }
  }

  static connect(options: HydraDbConnectionOptions): HydraDbGraphStore {
    return new HydraDbGraphStore(createHydraDbDriver(options), {
      ...(options.database === undefined ? {} : { database: options.database }),
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      ...(options.consistency === undefined
        ? {}
        : { consistency: options.consistency }),
      ...(options.httpUrl === undefined || options.authToken === undefined
        ? {}
        : {
            strongHttp: {
              url: options.httpUrl,
              authToken: options.authToken,
              ...(options.namespace === undefined
                ? {}
                : { namespace: options.namespace }),
              ...(options.graphId === undefined ? {} : { graphId: options.graphId }),
              ...(options.cellId === undefined ? {} : { cellId: options.cellId }),
            },
          }),
    });
  }

  async verifyConnectivity(): Promise<void> {
    await this.#driver.verifyConnectivity();
  }

  async write(records: GraphRecords): Promise<GraphWriteSummary> {
    const nodes = deduplicate(records.nodes, "node");
    const relationships = deduplicate(records.relationships, "relationship");
    const requiredNodes = new Map<StableId, NodeLabel>();
    for (const node of nodes.values()) requiredNodes.set(node.id, node.label);
    for (const relationship of relationships.values()) {
      for (const endpoint of [relationship.from, relationship.to]) {
        const knownLabel = requiredNodes.get(endpoint.id);
        if (knownLabel !== undefined && knownLabel !== endpoint.label) {
          throw new MissingGraphEndpointError(relationship.id, endpoint.id);
        }
        requiredNodes.set(endpoint.id, endpoint.label);
      }
    }

    const storedNodes: GraphNodeRecord[] = [];
    for (const label of NODE_LABELS) {
      const ids = [...requiredNodes]
        .filter(([, knownLabel]) => knownLabel === label)
        .map(([id]) => id);
      for (const batch of batches(ids, this.#batchSize)) {
        storedNodes.push(...(await this.#readNodes(label, batch)));
      }
    }
    const storedNodesById = new Map(storedNodes.map((node) => [node.id, node]));
    for (const node of nodes.values()) {
      const existing = storedNodesById.get(node.id);
      if (
        existing !== undefined &&
        !graphRecordsSemanticallyEqual(existing, node)
      ) {
        throw new GraphConflictError("node", node.id);
      }
    }

    const availableNodes = new Map(storedNodesById);
    for (const node of nodes.values()) availableNodes.set(node.id, node);
    for (const relationship of relationships.values()) {
      for (const endpoint of [relationship.from, relationship.to]) {
        if (availableNodes.get(endpoint.id)?.label !== endpoint.label) {
          throw new MissingGraphEndpointError(relationship.id, endpoint.id);
        }
      }
    }

    const storedRelationships: GraphRelationshipRecord[] = [];
    const relationshipGroups = new Map<
      string,
      {
        type: RelationshipType;
        fromLabel: NodeLabel;
        toLabel: NodeLabel;
        ids: StableId[];
      }
    >();
    for (const relationship of relationships.values()) {
      const key = `${relationship.type}|${relationship.from.label}|${relationship.to.label}`;
      const group = relationshipGroups.get(key) ?? {
        type: relationship.type,
        fromLabel: relationship.from.label,
        toLabel: relationship.to.label,
        ids: [],
      };
      group.ids.push(relationship.id);
      relationshipGroups.set(key, group);
    }
    for (const group of relationshipGroups.values()) {
      for (const batch of batches(group.ids, this.#batchSize)) {
        storedRelationships.push(
          ...(await this.#readRelationships(
            group.type,
            group.fromLabel,
            group.toLabel,
            batch,
          )),
        );
      }
    }
    const storedRelationshipsById = new Map(
      storedRelationships.map((relationship) => [relationship.id, relationship]),
    );
    for (const relationship of relationships.values()) {
      const existing = storedRelationshipsById.get(relationship.id);
      if (
        existing !== undefined &&
        !graphRecordsSemanticallyEqual(existing, relationship)
      ) {
        throw new GraphConflictError("relationship", relationship.id);
      }
    }

    const newNodes = [...nodes.values()].filter(
      (node) => !storedNodesById.has(node.id),
    );
    const newRelationships = [...relationships.values()].filter(
      (relationship) => !storedRelationshipsById.has(relationship.id),
    );
    await this.#upsertNodes(newNodes);
    await this.#upsertRelationships(newRelationships);

    return {
      nodes: writeCounts(newNodes.length, nodes.size - newNodes.length),
      relationships: writeCounts(
        newRelationships.length,
        relationships.size - newRelationships.length,
      ),
    };
  }

  async getNodes(ids: readonly StableId[]): Promise<readonly GraphNodeRecord[]> {
    if (ids.length === 0) return [];
    const uniqueIds = [...new Set(ids)];
    const nodes: GraphNodeRecord[] = [];
    for (const label of NODE_LABELS) {
      for (const batch of batches(uniqueIds, this.#batchSize)) {
        nodes.push(...(await this.#readNodes(label, batch)));
      }
    }
    return orderByRequestedIds(nodes, ids);
  }

  async getRelationships(
    ids: readonly StableId[],
  ): Promise<readonly GraphRelationshipRecord[]> {
    if (ids.length === 0) return [];
    const uniqueIds = [...new Set(ids)];
    const relationships: GraphRelationshipRecord[] = [];
    for (const type of RELATIONSHIP_TYPES) {
      const endpoints = RELATIONSHIP_ENDPOINT_LABELS[type];
      for (const fromLabel of endpoints.from) {
        for (const toLabel of endpoints.to) {
          for (const batch of batches(uniqueIds, this.#batchSize)) {
            relationships.push(
              ...(await this.#readRelationships(
                type,
                fromLabel,
                toLabel,
                batch,
              )),
            );
          }
        }
      }
    }
    return orderByRequestedIds(relationships, ids);
  }

  async matchNodes(query: GraphNodeQuery): Promise<readonly GraphNodeRecord[]> {
    const limit = validateGraphQueryLimit(query.limit);
    const keys = NODE_PROPERTY_KEYS[query.label];
    const equals = Object.entries(query.equals ?? {});
    const allowed = new Set<string>(keys);
    for (const [key, value] of equals) {
      if (!allowed.has(key)) throw new Error(`Unsupported ${query.label} query property ${key}`);
      assertHydraDbPropertyValue(value, key);
    }
    const parameters = Object.fromEntries(equals.map(([key, value], index) => [
      `q${index}`,
      databasePropertyValue(value),
    ]));
    const where = equals.length === 0
      ? []
      : [`WHERE ${equals.map(([key], index) => `n.${key} = $q${index}`).join(" AND ")}`];
    const result = await this.#run([
      `MATCH (n:${query.label})`,
      ...where,
      `RETURN n.id AS id${propertyProjection("n", keys)}`,
      `LIMIT ${limit}`,
    ].join("\n"), parameters, "read");
    return result.records.map((record) => ({
      id: stableIdValue(record.get("id"), "node id"),
      label: query.label,
      properties: projectedProperties(record, keys),
    }) as unknown as GraphNodeRecord);
  }

  async matchRelationships(
    query: GraphRelationshipQuery,
  ): Promise<readonly GraphRelationshipRecord[]> {
    const limit = validateGraphQueryLimit(query.limit);
    const endpoints = RELATIONSHIP_ENDPOINT_LABELS[query.type];
    const fromLabels = query.from === undefined ? endpoints.from : [query.from.label];
    const toLabels = query.to === undefined ? endpoints.to : [query.to.label];
    if (query.from !== undefined && !endpoints.from.includes(query.from.label as never)) return [];
    if (query.to !== undefined && !endpoints.to.includes(query.to.label as never)) return [];
    const records: GraphRelationshipRecord[] = [];
    for (const fromLabel of fromLabels) {
      for (const toLabel of toLabels) {
        const keys = RELATIONSHIP_PROPERTY_KEYS[query.type];
        const predicates: string[] = [];
        const parameters: Record<string, unknown> = {};
        const allowed = new Set<string>(keys);
        for (const [key, value] of Object.entries(query.equals ?? {})) {
          if (!allowed.has(key)) throw new Error(`Unsupported ${query.type} query property ${key}`);
          assertHydraDbPropertyValue(value, key);
          const parameter = `q${Object.keys(parameters).length}`;
          predicates.push(`r.${key} = $${parameter}`);
          parameters[parameter] = databasePropertyValue(value);
        }
        if (query.from !== undefined) {
          predicates.push("from.id = $fromId");
          parameters.fromId = databaseId(query.from.id);
        }
        if (query.to !== undefined) {
          predicates.push("to.id = $toId");
          parameters.toId = databaseId(query.to.id);
        }
        const result = await this.#run([
          `MATCH (from:${fromLabel})-[r:${query.type}]->(to:${toLabel})`,
          ...(predicates.length === 0 ? [] : [`WHERE ${predicates.join(" AND ")}`]),
          `RETURN r.${RELATIONSHIP_STABLE_ID_PROPERTY} AS id, from.id AS fromId, to.id AS toId${propertyProjection("r", keys)}`,
          `LIMIT ${Math.max(1, limit - records.length)}`,
        ].join("\n"), parameters, "read");
        records.push(...result.records.map((record) => ({
          id: stableIdValue(record.get("id"), "relationship id"),
          type: query.type,
          from: { id: stableIdValue(record.get("fromId"), "from node id"), label: fromLabel },
          to: { id: stableIdValue(record.get("toId"), "to node id"), label: toLabel },
          properties: projectedProperties(record, keys),
        }) as unknown as GraphRelationshipRecord));
        if (records.length >= limit) return records.slice(0, limit);
      }
    }
    return records;
  }

  async findPaths(query: GraphPathQuery): Promise<readonly GraphPath[]> {
    const { direction, minDepth, maxDepth, limit } = validatePathQuery(query);
    const relDirection =
      direction === "out" ? "outgoing" : direction === "in" ? "incoming" : "both";
    if (this.#strongHttp !== undefined) {
      return this.#findPathsHttp(
        query,
        relDirection,
        minDepth,
        maxDepth,
        limit,
        this.#consistency,
      );
    }
    const cypher = [
      "CALL algo.SPpaths({",
      "  sourceNode: $source,",
      "  targetNode: $target,",
      `  relTypes: ['${query.relationshipType}'],`,
      "  maxLen: $maxLen,",
      "  relDirection: $relDirection,",
      "  pathCount: $pathCount,",
      "  resultLimit: $resultLimit",
      "}) YIELD path RETURN path",
    ].join("\n");
    const result = await this.#run(
      cypher,
      {
        source: databaseId(query.from.id),
        target: databaseId(query.to.id),
        maxLen: int(maxDepth),
        relDirection,
        pathCount: int(limit),
        resultLimit: int(limit),
      },
      "read",
    );

    const paths: GraphPath[] = [];
    for (const record of result.records) {
      const hydrated = record.get("path");
      if (!isPath(hydrated)) {
        throw new TypeError("HydraDB SPpaths returned an invalid Bolt path value");
      }
      if (hydrated.length < minDepth || hydrated.length > maxDepth) continue;
      const nodeIds: StableId[] = [
        stableIdValue(hydrated.start.identity, "path start node id"),
      ];
      const relationshipIds: StableId[] = [];
      for (const segment of hydrated.segments) {
        const relationshipStableId =
          segment.relationship.properties[RELATIONSHIP_STABLE_ID_PROPERTY] ??
          segment.relationship.properties.id;
        relationshipIds.push(
          stableIdValue(
            relationshipStableId,
            "path relationship canonical id metadata",
          ),
        );
        nodeIds.push(stableIdValue(segment.end.identity, "path node id"));
      }
      paths.push({ nodeIds, relationshipIds });
    }
    return paths;
  }

  async close(): Promise<void> {
    await this.#driver.close();
  }

  async #readNodes(
    label: NodeLabel,
    ids: readonly StableId[],
  ): Promise<GraphNodeRecord[]> {
    const keys = NODE_PROPERTY_KEYS[label];
    const result = await this.#run(
      [
        `MATCH (n:${label})`,
        whereIds("n.id", ids.length),
        `RETURN n.id AS id${propertyProjection("n", keys)}`,
      ].join("\n"),
      idParameters(ids),
      "read",
    );
    return result.records.map((record) => ({
      id: stableIdValue(record.get("id"), "node id"),
      label,
      properties: projectedProperties(record, keys),
    }) as unknown as GraphNodeRecord);
  }

  async #readRelationships(
    type: RelationshipType,
    fromLabel: NodeLabel,
    toLabel: NodeLabel,
    ids: readonly StableId[],
  ): Promise<GraphRelationshipRecord[]> {
    const keys = RELATIONSHIP_PROPERTY_KEYS[type];
    const result = await this.#run(
      [
        `MATCH (from:${fromLabel})-[r:${type}]->(to:${toLabel})`,
        whereIds(`r.${RELATIONSHIP_STABLE_ID_PROPERTY}`, ids.length),
        `RETURN r.${RELATIONSHIP_STABLE_ID_PROPERTY} AS id, from.id AS fromId, to.id AS toId${propertyProjection("r", keys)}`,
      ].join("\n"),
      idParameters(ids),
      "read",
    );
    return result.records.map((record) => ({
      id: stableIdValue(record.get("id"), "relationship id"),
      type,
      from: {
        id: stableIdValue(record.get("fromId"), "from node id"),
        label: fromLabel,
      },
      to: {
        id: stableIdValue(record.get("toId"), "to node id"),
        label: toLabel,
      },
      properties: projectedProperties(record, keys),
    }) as unknown as GraphRelationshipRecord);
  }

  async #upsertNodes(nodes: readonly GraphNodeRecord[]): Promise<void> {
    const groups = groupByPropertyShape(nodes, (node) => node.label);
    for (const group of groups.values()) {
      const writeBatch = async (batch: readonly GraphNodeRecord[]): Promise<void> => {
        const setters = group.keys.map((key) => `n.${key} = row.${key}`);
        const cypher = [
          "UNWIND $rows AS row",
          "MERGE (n {id: row.vertex})",
          `SET n:${group.discriminator}${setters.length === 0 ? "" : `, ${setters.join(", ")}`}`,
        ].join("\n");
        try {
          await this.#run(cypher, {
            rows: batch.map((node) => ({
              vertex: databaseId(node.id),
              ...selectedProperties(node.properties, group.keys),
            })),
          });
        } catch (error) {
          if (!isHydraDbRuntimeTimeout(error) || batch.length === 1) throw error;
          const middle = Math.ceil(batch.length / 2);
          await writeBatch(batch.slice(0, middle));
          await writeBatch(batch.slice(middle));
        }
      };
      for (const batch of batches(group.records, this.#batchSize)) {
        await writeBatch(batch);
      }
    }
  }

  async #upsertRelationships(
    relationships: readonly GraphRelationshipRecord[],
  ): Promise<void> {
    const groups = groupByPropertyShape(
      relationships,
      (relationship) =>
        `${relationship.type}|${relationship.from.label}|${relationship.to.label}`,
    );
    for (const group of groups.values()) {
      const [type, fromLabel, toLabel] = group.discriminator.split("|") as [
        RelationshipType,
        NodeLabel,
        NodeLabel,
      ];
      const writeBatch = async (batch: readonly GraphRelationshipRecord[]): Promise<void> => {
        const setters = [
          `r.${RELATIONSHIP_STABLE_ID_PROPERTY} = row.relationship_vertex`,
          ...group.keys.map((key) => `r.${key} = row.${key}`),
        ];
        const cypher = [
          "UNWIND $rows AS row",
          `MATCH (from:${fromLabel} {id: row.source_vertex}), (to:${toLabel} {id: row.destination_vertex})`,
          `MERGE (from)-[r:${type} {id: row.relationship_vertex}]->(to)`,
          `SET ${setters.join(", ")}`,
        ].join("\n");
        try {
          await this.#run(cypher, {
            rows: batch.map((relationship) => ({
              source_vertex: databaseId(relationship.from.id),
              destination_vertex: databaseId(relationship.to.id),
              relationship_vertex: databaseId(relationship.id),
              ...selectedProperties(relationship.properties, group.keys),
            })),
          });
        } catch (error) {
          if (!isHydraDbRuntimeTimeout(error) || batch.length === 1) throw error;
          const middle = Math.ceil(batch.length / 2);
          await writeBatch(batch.slice(0, middle));
          await writeBatch(batch.slice(middle));
        }
      };
      for (const batch of batches(group.records, this.#batchSize)) {
        await writeBatch(batch);
      }
    }
  }

  async #run(
    cypher: string,
    parameters: Record<string, unknown>,
    access: "read" | "write" = "write",
  ): Promise<QueryResult> {
    const previous = this.#boltQueryTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#boltQueryTail = previous.then(() => current);
    await previous;
    try {
      const session = this.#driver.session(
        this.#database === undefined ? {} : { database: this.#database },
      );
      try {
        return await session.run(cypher, parameters, {
          // HydraDB v0.1.1 permits strong consistency only for reads. Bolt
          // fallback reads and writes stay causal; configured path reads use
          // the HTTP transport below.
          metadata: {
            "hydradb.consistency": "causal",
          },
        });
      } finally {
        await session.close();
      }
    } finally {
      // Query failures and session-close failures must never strand the next
      // caller behind this store's serialization barrier.
      release();
    }
  }

  async #findPathsHttp(
    query: GraphPathQuery,
    relDirection: "outgoing" | "incoming" | "both",
    minDepth: number,
    maxDepth: number,
    limit: number,
    consistency: "causal" | "strong",
  ): Promise<readonly GraphPath[]> {
    const result = await this.#queryHttp(
      [
        "CALL algo.SPpaths({",
        "  sourceNode: $source,",
        "  targetNode: $target,",
        `  relTypes: ['${query.relationshipType}'],`,
        "  maxLen: $maxLen,",
        "  relDirection: $relDirection,",
        "  pathCount: $pathCount,",
        "  resultLimit: $resultLimit",
        "}) YIELD path RETURN path",
      ].join("\n"),
      {
        source: databaseId(query.from.id),
        target: databaseId(query.to.id),
        maxLen: int(maxDepth),
        relDirection,
        pathCount: int(limit),
        resultLimit: int(limit),
      },
      consistency,
    );
    return parseHttpPaths(result, minDepth, maxDepth);
  }

  async #queryHttp(
    cypher: string,
    parameters: Record<string, unknown>,
    consistency: "causal" | "strong",
  ): Promise<HttpQueryResult> {
    const http = this.#strongHttp;
    if (http === undefined) {
      throw new Error(
        "HYDRADB_HTTP_URL and HYDRADB_AUTH_TOKEN are required for strong HydraDB reads",
      );
    }
    const response = await fetch(
      `${http.url}/v1/graphs/${encodeURIComponent(http.graphId)}/query`,
      {
        method: "POST",
        headers: {
          accept: "application/x-ndjson",
          authorization: `Bearer ${http.authToken}`,
          "content-type": "application/json",
          "x-graph-namespace": http.namespace,
        },
        body: stringifyHttpRequest({
          cell_id: http.cellId,
          consistency,
          page_size: 256,
          parameters,
          query: cypher,
          timeout_ms: 30_000,
        }),
        signal: AbortSignal.timeout(35_000),
      },
    );
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `HydraDB ${consistency} HTTP query failed with HTTP ${response.status}: ${body.slice(0, 500)}`,
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/x-ndjson")) {
      throw new Error(
        `HydraDB ${consistency} HTTP query returned unexpected content type ${contentType || "(missing)"}`,
      );
    }
    return parseHttpQueryResult(body, consistency);
  }
}

interface HttpQueryResult {
  columns: string[];
  rows: unknown[][];
}

type JsonObject = Record<string, unknown>;

function stringifyHttpRequest(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (!isInt(current)) return current;
    const integer = current.toString();
    if (!/^-?\d+$/u.test(integer)) {
      throw new TypeError("HydraDB HTTP parameter contained an invalid integer");
    }
    // HydraDB accepts the full signed/unsigned 63-bit range. Raw JSON keeps
    // the parameter numeric without first rounding it through IEEE-754.
    return (JSON as typeof JSON & {
      rawJSON(text: string): unknown;
    }).rawJSON(integer);
  });
}

function parseHttpQueryResult(
  body: string,
  consistency: "causal" | "strong",
): HttpQueryResult {
  const lines = body.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new Error(`HydraDB ${consistency} HTTP query returned an empty NDJSON stream`);
  }
  let columns: string[] | undefined;
  let summarySeen = false;
  const rows: unknown[][] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const entry = asJsonObject(parseLosslessJson(line, index + 1, consistency));
    if (entry === undefined || typeof entry.type !== "string") {
      throw new Error(
        `HydraDB ${consistency} HTTP query returned an invalid NDJSON line ${index + 1}`,
      );
    }
    if (summarySeen) {
      throw new Error(
        `HydraDB ${consistency} HTTP query returned data after its terminal summary`,
      );
    }
    if (entry.type === "header") {
      if (columns !== undefined || index !== 0 || !Array.isArray(entry.columns)) {
        throw new Error(`HydraDB ${consistency} HTTP query returned an invalid NDJSON header`);
      }
      if (!entry.columns.every((column) => typeof column === "string")) {
        throw new Error(`HydraDB ${consistency} HTTP query returned invalid column names`);
      }
      columns = [...entry.columns] as string[];
      if (new Set(columns).size !== columns.length) {
        throw new Error(`HydraDB ${consistency} HTTP query returned duplicate column names`);
      }
      continue;
    }
    if (entry.type === "row") {
      if (columns === undefined || !Array.isArray(entry.values)) {
        throw new Error(`HydraDB ${consistency} HTTP query returned a row before its header`);
      }
      if (entry.values.length !== columns.length) {
        throw new Error(
          `HydraDB ${consistency} HTTP query returned a row with the wrong column count`,
        );
      }
      rows.push(entry.values);
      continue;
    }
    if (entry.type === "summary") {
      if (
        columns === undefined ||
        entry.has_more !== false ||
        index !== lines.length - 1
      ) {
        throw new Error(
          `HydraDB ${consistency} HTTP query returned an invalid terminal summary`,
        );
      }
      summarySeen = true;
      continue;
    }
    if (entry.type === "error") {
      const code = typeof entry.code === "string" ? entry.code : "unknown_error";
      const message = typeof entry.message === "string"
        ? entry.message
        : "HydraDB terminated the HTTP query stream";
      throw new Error(`HydraDB ${consistency} HTTP query failed (${code}): ${message}`);
    }
    throw new Error(
      `HydraDB ${consistency} HTTP query returned unknown NDJSON type ${entry.type}`,
    );
  }
  if (columns === undefined) {
    throw new Error(`HydraDB ${consistency} HTTP query omitted its NDJSON header`);
  }
  if (!summarySeen) {
    throw new Error(
      `HydraDB ${consistency} HTTP query ended without a terminal summary; refusing a possibly truncated result`,
    );
  }
  return { columns, rows };
}

function parseLosslessJson(
  line: string,
  lineNumber: number,
  consistency: "causal" | "strong",
): unknown {
  try {
    const parseWithSource = JSON.parse as (
      text: string,
      reviver: (
        key: string,
        value: unknown,
        context: { source?: string } | undefined,
      ) => unknown,
    ) => unknown;
    return parseWithSource(line, (_key, value, context) =>
      typeof value === "number" &&
        typeof context?.source === "string" &&
        /^-?\d{16,}$/u.test(context.source)
        ? context.source
        : value
    );
  } catch {
    throw new Error(
      `HydraDB ${consistency} HTTP query returned malformed JSON on line ${lineNumber}`,
    );
  }
}

function asJsonObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function parseHttpPaths(
  result: HttpQueryResult,
  minDepth: number,
  maxDepth: number,
): readonly GraphPath[] {
  const pathIndex = result.columns.indexOf("path");
  if (pathIndex < 0) throw new TypeError("HydraDB HTTP path query omitted path column");
  const paths: GraphPath[] = [];
  for (const row of result.rows) {
    const cell = asJsonObject(row[pathIndex]);
    if (cell?.type !== "path") {
      throw new TypeError("HydraDB HTTP path query returned an invalid path value");
    }
    const value = asJsonObject(cell.value);
    if (value === undefined) {
      throw new TypeError("HydraDB HTTP path query returned an invalid path value");
    }
    const nodes = Array.isArray(value.nodes) ? value.nodes : [];
    const relationships = Array.isArray(value.relationships) ? value.relationships : [];
    const nodeIds = nodes.map((node) =>
      stableIdText(
        asJsonObject(node)?.id as string | number | undefined,
        "HTTP path node id",
      ),
    );
    const relationshipIds = relationships.map((relationship) => {
      const properties = asJsonObject(asJsonObject(relationship)?.properties);
      const stable = asJsonObject(properties?.hydratraceStableId) ??
        asJsonObject(properties?.id);
      return stableIdText(
        stable?.Integer as string | number | undefined,
        "HTTP path relationship canonical id",
      );
    });
    if (
      relationshipIds.length >= minDepth &&
      relationshipIds.length <= maxDepth &&
      nodeIds.length === relationshipIds.length + 1
    ) {
      paths.push({ nodeIds, relationshipIds });
    }
  }
  return paths;
}

function stableIdText(
  value: string | number | undefined,
  context: string,
): StableId {
  if (value === undefined) throw new TypeError(`HydraDB omitted ${context}`);
  const text = String(value);
  if (!/^\d+$/u.test(text)) throw new TypeError(`HydraDB returned invalid ${context}`);
  return text as StableId;
}

const PROVENANCE_KEYS = [
  "sourceType",
  "sourceRef",
  "sourceSha256",
  "repositoryId",
  "commitSha",
  "importRunId",
  "observedAt",
  "parserVersion",
  "confidence",
] as const;

const NODE_PROPERTY_KEYS = {
  Organization: ["name"],
  Repository: ["url", "defaultBranch"],
  Service: ["name", "repositoryId"],
  Commit: ["sha", "committedAt"],
  Environment: ["name", "criticality"],
  Deployment: ["startedAt", "endedAt", "status"],
  LockfileSnapshot: [
    "ecosystem",
    "lockfileType",
    "contentHash",
    "sha256",
    "repositoryId",
    "commitSha",
    "sourceRef",
    "parserVersion",
    "createdAt",
    "validUntil",
  ],
  Resolution: [
    "snapshotId",
    "packageVersionId",
    "packageName",
    "version",
    "sourceKey",
    "installPath",
    "root",
    "direct",
    "dev",
    "optional",
    "peer",
    "integrity",
    "resolved",
    ...PROVENANCE_KEYS,
  ],
  Package: ["ecosystem", "name", "normalizedName"],
  PackageVersion: [
    "packageId",
    "ecosystem",
    "name",
    "normalizedName",
    "version",
    "deprecated",
    "publishedAt",
  ],
  Advisory: ["summary", "severity", "publishedAt", "modifiedAt"],
  IncidentWindow: [
    "startsAt",
    "endsAt",
    "source",
    "confidence",
    "ecosystem",
    "packageName",
    "normalizedPackageName",
    "affectedVersionsJson",
    "environmentsJson",
    "advisoryId",
    "advisoryPublishedAt",
    "advisoryWithdrawnAt",
    "packagePublishedAt",
    "windowSource",
    "severityScore",
    "trustContextScore",
    "createdAt",
  ],
  Maintainer: ["username", "emailHash", "emailDomain"],
  Infrastructure: ["type", "value"],
  SourceModule: ["filePath", "language", "contentHash"],
  EntryPoint: ["type", "command"],
  RuntimeObservation: [
    "runId", "observedAt", "source", "snapshotId", "deploymentId",
    "packageName", "version", "command", "loadCount",
  ],
  Evidence: [
    "type", "sourceRef", "sha256", "parserVersion", "snapshotId",
    "packageName", "version", "level", "observedAt", "evidenceRefsJson", "detailsJson",
  ],
  RemediationCandidate: ["fromVersion", "toVersion", "cost"],
  RemediationRun: ["incidentId", "createdAt", "beforePathIdsJson", "solutionJson", "status"],
  RemediationVerification: [
    "runId", "createdAt", "level", "snapshotIdsJson", "remainingPathCount",
    "passed", "message", "status",
  ],
} as const satisfies {
  [L in NodeLabel]: readonly (keyof NodePropertiesByLabel[L] & string)[];
};

const RELATIONSHIP_PROPERTY_KEYS = {
  OWNS: [],
  CONTAINS_SERVICE: [],
  HAS_COMMIT: [],
  HAS_DEPLOYMENT: [],
  RUNS_COMMIT: [],
  IN_ENVIRONMENT: [],
  USES_SNAPSHOT: [],
  CONTAINS: PROVENANCE_KEYS,
  SUPERSEDES: [],
  INSTANCE_OF: PROVENANCE_KEYS,
  DEPENDS_ON_INSTANCE: [
    "dependencyName",
    "specifier",
    "kind",
    ...PROVENANCE_KEYS,
  ],
  VERSION_OF: PROVENANCE_KEYS,
  DECLARES_DEPENDENCY: ["dependencyName", "specifier"],
  RESOLVES_PUBLICLY_TO: [],
  AFFECTED_BY: [],
  ACTIVE_DURING: [],
  PUBLISHED_BY: [],
  BUILT_FROM: [],
  USES_INFRASTRUCTURE: [],
  SIMILAR_NAME_TO: ["reason", "score"],
  REACHES: [],
  IMPORTS_MODULE: [],
  BELONGS_TO: [],
  LOADED: [],
  SUPPORTS: [],
} as const satisfies {
  [T in RelationshipType]: readonly (
    keyof RelationshipPropertiesByType[T] & string
  )[];
};

type PropertyRecord = Readonly<Record<string, unknown>>;

function deduplicate<T extends { id: StableId }>(
  records: readonly T[],
  kind: "node" | "relationship",
): Map<StableId, T> {
  const result = new Map<StableId, T>();
  for (const record of records) {
    const existing = result.get(record.id);
    if (
      existing !== undefined &&
      !graphRecordsSemanticallyEqual(existing, record)
    ) {
      throw new GraphConflictError(kind, record.id);
    }
    result.set(record.id, record);
  }
  return result;
}

function groupByPropertyShape<T extends { properties: object }>(
  records: readonly T[],
  discriminatorFor: (record: T) => string,
): Map<string, { discriminator: string; keys: string[]; records: T[] }> {
  const groups = new Map<
    string,
    { discriminator: string; keys: string[]; records: T[] }
  >();
  for (const record of records) {
    const discriminator = discriminatorFor(record);
    const allowed = allowedPropertyKeys(discriminator);
    const keys = Object.entries(record.properties)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => {
        if (!allowed.has(key)) {
          throw new Error(`Unsupported HydraDB graph property ${key}`);
        }
        assertHydraDbPropertyValue(value, key);
        return key;
      })
      .sort();
    const groupKey = `${discriminator}|${keys.join(",")}`;
    const group = groups.get(groupKey) ?? { discriminator, keys, records: [] };
    group.records.push(record);
    groups.set(groupKey, group);
  }
  return groups;
}

function allowedPropertyKeys(discriminator: string): ReadonlySet<string> {
  if (isNodeLabel(discriminator)) {
    return new Set(NODE_PROPERTY_KEYS[discriminator]);
  }
  const type = discriminator.split("|")[0];
  if (type !== undefined && isRelationshipType(type)) {
    return new Set(RELATIONSHIP_PROPERTY_KEYS[type]);
  }
  throw new Error(`Unsupported graph record discriminator ${discriminator}`);
}

function assertHydraDbPropertyValue(value: unknown, key: string): void {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new TypeError(
      `HydraDB v0.1.1 property ${key} must be a string, number, or boolean`,
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(`HydraDB property ${key} must be finite`);
  }
}

function selectedProperties(
  properties: object,
  keys: readonly string[],
): Record<string, unknown> {
  const source = properties as PropertyRecord;
  return Object.fromEntries(
    keys.map((key) => [key, databasePropertyValue(source[key])]),
  );
}

function databasePropertyValue(value: unknown): unknown {
  // neo4j-driver encodes plain JavaScript numbers as Float64. Preserve integer
  // graph fields (timestamps, counts, enum ranks) as PackStream integers.
  return typeof value === "number" && Number.isInteger(value) ? int(value) : value;
}

function whereIds(property: string, count: number): string {
  if (count < 1) throw new Error("A HydraDB ID read batch must not be empty");
  return `WHERE ${Array.from(
    { length: count },
    (_, index) => `${property} = $id${index}`,
  ).join(" OR ")}`;
}

function idParameters(ids: readonly StableId[]): Record<string, unknown> {
  return Object.fromEntries(
    ids.map((id, index) => [`id${index}`, databaseId(id)]),
  );
}

function propertyProjection(binding: string, keys: readonly string[]): string {
  return keys.map((key, index) => `, ${binding}.${key} AS p${index}`).join("");
}

function projectedProperties(
  record: QueryResult["records"][number],
  keys: readonly string[],
): Record<string, string | number | boolean> {
  const properties: Record<string, string | number | boolean> = {};
  keys.forEach((key, index) => {
    const value = normalizeValue(record.get(`p${index}`));
    if (value === null || value === undefined) return;
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new TypeError(`HydraDB returned invalid scalar property ${key}`);
    }
    properties[key] = value;
  });
  return properties;
}

function databaseId(id: StableId): ReturnType<typeof int> {
  return int(id);
}

function stableIdValue(value: unknown, field: string): StableId {
  if (isInt(value)) {
    const rendered = value.toString();
    if (!/^\d+$/.test(rendered)) {
      throw new TypeError(`HydraDB returned an invalid ${field}`);
    }
    return rendered as StableId;
  }
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    !/^\d+$/.test(String(value))
  ) {
    throw new TypeError(`HydraDB returned an invalid ${field}`);
  }
  return String(value) as StableId;
}

function normalizeValue(value: unknown): unknown {
  if (isInt(value)) {
    return value.inSafeRange() ? value.toNumber() : value.toString();
  }
  return value;
}

function orderByRequestedIds<T extends { id: StableId }>(
  records: readonly T[],
  ids: readonly StableId[],
): T[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  return ids.flatMap((id) => {
    const record = byId.get(id);
    return record === undefined ? [] : [record];
  });
}

function* batches<T>(records: readonly T[], batchSize: number): Generator<T[]> {
  for (let index = 0; index < records.length; index += batchSize) {
    yield records.slice(index, index + batchSize);
  }
}

function isHydraDbRuntimeTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String((error as Error & { code?: unknown }).code ?? "") : "";
  return code === "Neo.ClientError.Transaction.Terminated" ||
    /client_query_runtime exceeded query timeout|query timeout after 29999 ms/iu.test(error.message);
}
