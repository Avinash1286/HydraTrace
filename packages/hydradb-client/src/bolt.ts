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
  type GraphStore,
  type GraphWriteSummary,
  MissingGraphEndpointError,
  validatePathQuery,
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
  // Stable graph IDs can use the full nonnegative signed 63-bit range.
  return createDriver(options.uri, token);
}

/**
 * Bolt adapter restricted to HydraDB v0.1.1's documented OpenCypher subset.
 * It uses scalar SET clauses, directed one-hop relationship patterns, explicit
 * property projections, lossless integer IDs, and the native SPpaths procedure.
 */
export class HydraDbGraphStore implements GraphStore {
  readonly #driver: Driver;
  readonly #database: string | undefined;
  readonly #batchSize: number;
  readonly #consistency: "causal" | "strong";
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
    // HydraDB v0.1.1's parser rejects long OR chains; ten IDs stays within
    // its expression-depth ceiling while retaining bounded batching.
    this.#batchSize = options.batchSize ?? 10;
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

  async findPaths(query: GraphPathQuery): Promise<readonly GraphPath[]> {
    const { direction, minDepth, maxDepth, limit } = validatePathQuery(query);
    const relDirection =
      direction === "out" ? "outgoing" : direction === "in" ? "incoming" : "both";
    if (this.#consistency === "strong") {
      return this.#findPathsStrongHttp(
        query,
        relDirection,
        minDepth,
        maxDepth,
        limit,
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
      for (const batch of batches(group.records, this.#batchSize)) {
        const setters = group.keys.map((key) => `n.${key} = row.${key}`);
        const cypher = [
          "UNWIND $rows AS row",
          "MERGE (n {id: row.vertex})",
          `SET n:${group.discriminator}${setters.length === 0 ? "" : `, ${setters.join(", ")}`}`,
        ].join("\n");
        await this.#run(cypher, {
          rows: batch.map((node) => ({
            vertex: databaseId(node.id),
            ...selectedProperties(node.properties, group.keys),
          })),
        });
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
      for (const batch of batches(group.records, this.#batchSize)) {
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
        await this.#run(cypher, {
          rows: batch.map((relationship) => ({
            source_vertex: databaseId(relationship.from.id),
            destination_vertex: databaseId(relationship.to.id),
            relationship_vertex: databaseId(relationship.id),
            ...selectedProperties(relationship.properties, group.keys),
          })),
        });
      }
    }
  }

  async #run(
    cypher: string,
    parameters: Record<string, unknown>,
    access: "read" | "write" = "write",
  ): Promise<QueryResult> {
    const session = this.#driver.session(
      this.#database === undefined ? {} : { database: this.#database },
    );
    try {
      return await session.run(cypher, parameters, {
        // HydraDB v0.1.1 permits strong consistency only for reads. Strong
        // path reads use the HTTP implementation below because its Bolt path
        // response is not decoded correctly by neo4j-driver 6.
        metadata: {
          "hydradb.consistency": "causal",
        },
      });
    } finally {
      await session.close();
    }
  }

  async #findPathsStrongHttp(
    query: GraphPathQuery,
    relDirection: "outgoing" | "incoming" | "both",
    minDepth: number,
    maxDepth: number,
    limit: number,
  ): Promise<readonly GraphPath[]> {
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
          authorization: `Bearer ${http.authToken}`,
          "content-type": "application/json",
          "x-graph-namespace": http.namespace,
        },
        body: JSON.stringify({
          cell_id: http.cellId,
          consistency: "strong",
          query: [
            "CALL algo.SPpaths({",
            `sourceNode: ${query.from.id},`,
            `targetNode: ${query.to.id},`,
            `relTypes: ['${query.relationshipType}'],`,
            `maxLen: ${maxDepth},`,
            `relDirection: '${relDirection}',`,
            `pathCount: ${limit},`,
            `resultLimit: ${limit}`,
            "}) YIELD path RETURN path",
          ].join(" "),
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `HydraDB strong path query failed with HTTP ${response.status}: ${body.slice(0, 500)}`,
      );
    }
    return parseStrongHttpPaths(body, minDepth, maxDepth);
  }
}

function parseStrongHttpPaths(
  body: string,
  minDepth: number,
  maxDepth: number,
): readonly GraphPath[] {
  // JSON has no 64-bit integer type. Quote only long integer tokens before
  // parsing so canonical HydraTrace IDs never pass through an IEEE-754 number.
  const lossless = body.replace(
    /([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/gu,
    '$1"$2"',
  );
  const payload = JSON.parse(lossless) as {
    rows?: Array<
      Array<{
        type?: string;
        value?: {
          nodes?: Array<{ id?: string | number }>;
          relationships?: Array<{
            properties?: {
              hydratraceStableId?: { Integer?: string | number };
              id?: { Integer?: string | number };
            };
          }>;
        };
      }>
    >;
  };
  const paths: GraphPath[] = [];
  for (const row of payload.rows ?? []) {
    const cell = row[0];
    if (cell?.type !== "path" || cell.value === undefined) continue;
    const nodeIds = (cell.value.nodes ?? []).map((node) =>
      stableIdText(node.id, "HTTP path node id"),
    );
    const relationshipIds = (cell.value.relationships ?? []).map(
      (relationship) =>
        stableIdText(
          relationship.properties?.hydratraceStableId?.Integer ??
            relationship.properties?.id?.Integer,
          "HTTP path relationship canonical id",
        ),
    );
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
  IncidentWindow: ["startsAt", "endsAt", "source", "confidence"],
  Maintainer: ["username", "emailHash", "emailDomain"],
  Infrastructure: ["type", "value"],
  SourceModule: ["filePath", "language", "contentHash"],
  EntryPoint: ["type", "command"],
  RuntimeObservation: ["runId", "observedAt", "source"],
  Evidence: ["type", "sourceRef", "sha256", "parserVersion"],
  RemediationCandidate: ["fromVersion", "toVersion", "cost"],
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
