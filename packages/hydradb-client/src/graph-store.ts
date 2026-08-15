import type { StableId } from "@hydratrace/domain";
import type {
  GraphNodeRecord,
  GraphNodeRef,
  GraphPath,
  GraphRecords,
  GraphRelationshipRecord,
  RelationshipType,
} from "@hydratrace/graph-schema";

export interface WriteCounts {
  created: number;
  existing: number;
  total: number;
}

export interface GraphWriteSummary {
  nodes: WriteCounts;
  relationships: WriteCounts;
}

export type PathDirection = "out" | "in" | "both";

export interface GraphPathQuery {
  from: GraphNodeRef;
  to: GraphNodeRef;
  relationshipType: RelationshipType;
  direction?: PathDirection;
  minDepth?: number;
  maxDepth?: number;
  limit?: number;
}

export interface GraphStore {
  write(records: GraphRecords): Promise<GraphWriteSummary>;
  getNodes(ids: readonly StableId[]): Promise<readonly GraphNodeRecord[]>;
  getRelationships(
    ids: readonly StableId[],
  ): Promise<readonly GraphRelationshipRecord[]>;
  findPaths(query: GraphPathQuery): Promise<readonly GraphPath[]>;
  close(): Promise<void>;
}

export class GraphConflictError extends Error {
  constructor(kind: "node" | "relationship", id: StableId) {
    super(`Conflicting immutable ${kind} record for canonical ID ${id}`);
    this.name = "GraphConflictError";
  }
}

export class MissingGraphEndpointError extends Error {
  constructor(relationshipId: StableId, endpointId: StableId) {
    super(
      `Relationship ${relationshipId} references missing or mislabeled node ${endpointId}`,
    );
    this.name = "MissingGraphEndpointError";
  }
}

export function validatePathQuery(query: GraphPathQuery): Required<
  Pick<GraphPathQuery, "direction" | "minDepth" | "maxDepth" | "limit">
> {
  const direction = query.direction ?? "out";
  const minDepth = query.minDepth ?? 1;
  const maxDepth = query.maxDepth ?? 16;
  const limit = query.limit ?? 100;

  if (!Number.isInteger(minDepth) || minDepth < 0) {
    throw new RangeError("minDepth must be a nonnegative integer");
  }
  if (!Number.isInteger(maxDepth) || maxDepth < minDepth || maxDepth > 16) {
    throw new RangeError(
      "maxDepth must be an integer between minDepth and HydraDB v0.1.1's cap of 16",
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new RangeError("limit must be an integer between 1 and 10000");
  }

  return { direction, minDepth, maxDepth, limit };
}

export function graphRecordsEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Imported provenance describes where a fact was observed, not its canonical
 * identity. Two scans may therefore reuse the same immutable graph record with
 * different observation times/import runs. The first stored provenance is kept.
 */
export function graphRecordsSemanticallyEqual(
  left: unknown,
  right: unknown,
): boolean {
  return canonicalJson(withoutFactProvenance(left)) === canonicalJson(withoutFactProvenance(right));
}

const FACT_PROVENANCE_KEYS = new Set([
  "sourceType",
  "sourceRef",
  "sourceSha256",
  "repositoryId",
  "commitSha",
  "importRunId",
  "observedAt",
  "parserVersion",
  "confidence",
]);

function withoutFactProvenance(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutFactProvenance);
  if (value === null || typeof value !== "object") return value;
  if (
    "label" in value &&
    value.label === "LockfileSnapshot" &&
    "properties" in value &&
    value.properties !== null &&
    typeof value.properties === "object"
  ) {
    const properties = value.properties as Record<string, unknown>;
    return {
      ...value,
      properties: {
        ecosystem: properties.ecosystem,
        lockfileType: properties.lockfileType,
        contentHash: properties.contentHash,
        repositoryId: properties.repositoryId,
        commitSha: properties.commitSha,
      },
    };
  }
  const entries = Object.entries(value);
  const isProvenancedPropertyMap = entries.some(
    ([key]) => key === "sourceType",
  ) && entries.some(([key]) => key === "importRunId");
  return Object.fromEntries(
    entries
      .filter(
        ([key]) => !isProvenancedPropertyMap || !FACT_PROVENANCE_KEYS.has(key),
      )
      .map(([key, child]) => [key, withoutFactProvenance(child)]),
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function writeCounts(created: number, existing: number): WriteCounts {
  return { created, existing, total: created + existing };
}
