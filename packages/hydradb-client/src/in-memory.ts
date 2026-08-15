import type { StableId } from "@hydratrace/domain";
import type {
  GraphNodeRecord,
  GraphPath,
  GraphRecords,
  GraphRelationshipRecord,
} from "@hydratrace/graph-schema";
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

/** Deterministic reference store used by parser and correctness tests. */
export class InMemoryGraphStore implements GraphStore {
  readonly #nodes = new Map<StableId, GraphNodeRecord>();
  readonly #relationships = new Map<StableId, GraphRelationshipRecord>();

  async write(records: GraphRecords): Promise<GraphWriteSummary> {
    const uniqueNodes = uniqueRecords(records.nodes, "node");
    const uniqueRelationships = uniqueRecords(
      records.relationships,
      "relationship",
    );

    let existingNodes = 0;
    for (const node of uniqueNodes.values()) {
      const existing = this.#nodes.get(node.id);
      if (existing === undefined) continue;
      if (!graphRecordsSemanticallyEqual(existing, node)) {
        throw new GraphConflictError("node", node.id);
      }
      existingNodes += 1;
    }

    const availableNodes = new Map(this.#nodes);
    for (const node of uniqueNodes.values()) availableNodes.set(node.id, node);

    let existingRelationships = 0;
    for (const relationship of uniqueRelationships.values()) {
      assertEndpoint(availableNodes, relationship, "from");
      assertEndpoint(availableNodes, relationship, "to");
      const existing = this.#relationships.get(relationship.id);
      if (existing === undefined) continue;
      if (!graphRecordsSemanticallyEqual(existing, relationship)) {
        throw new GraphConflictError("relationship", relationship.id);
      }
      existingRelationships += 1;
    }

    // Commit only after validating the complete batch, keeping failed writes atomic.
    for (const node of uniqueNodes.values()) {
      if (!this.#nodes.has(node.id)) this.#nodes.set(node.id, cloneRecord(node));
    }
    for (const relationship of uniqueRelationships.values()) {
      if (!this.#relationships.has(relationship.id)) {
        this.#relationships.set(relationship.id, cloneRecord(relationship));
      }
    }

    return {
      nodes: writeCounts(uniqueNodes.size - existingNodes, existingNodes),
      relationships: writeCounts(
        uniqueRelationships.size - existingRelationships,
        existingRelationships,
      ),
    };
  }

  async getNodes(ids: readonly StableId[]): Promise<readonly GraphNodeRecord[]> {
    return ids.flatMap((id) => {
      const node = this.#nodes.get(id);
      return node === undefined ? [] : [cloneRecord(node)];
    });
  }

  async getRelationships(
    ids: readonly StableId[],
  ): Promise<readonly GraphRelationshipRecord[]> {
    return ids.flatMap((id) => {
      const relationship = this.#relationships.get(id);
      return relationship === undefined ? [] : [cloneRecord(relationship)];
    });
  }

  async findPaths(query: GraphPathQuery): Promise<readonly GraphPath[]> {
    const { direction, minDepth, maxDepth, limit } = validatePathQuery(query);
    const from = this.#nodes.get(query.from.id);
    const to = this.#nodes.get(query.to.id);
    if (
      from?.label !== query.from.label ||
      to?.label !== query.to.label
    ) {
      return [];
    }

    const adjacency = new Map<
      StableId,
      Array<{ relationship: GraphRelationshipRecord; next: StableId }>
    >();
    for (const relationship of this.#relationships.values()) {
      if (relationship.type !== query.relationshipType) continue;
      if (direction === "out" || direction === "both") {
        addAdjacent(adjacency, relationship.from.id, relationship.to.id, relationship);
      }
      if (direction === "in" || direction === "both") {
        addAdjacent(adjacency, relationship.to.id, relationship.from.id, relationship);
      }
    }
    for (const edges of adjacency.values()) {
      edges.sort((left, right) =>
        left.relationship.id.localeCompare(right.relationship.id),
      );
    }

    interface PendingPath {
      nodeIds: StableId[];
      relationshipIds: StableId[];
    }
    const pending: PendingPath[] = [
      { nodeIds: [query.from.id], relationshipIds: [] },
    ];
    const paths: GraphPath[] = [];

    while (pending.length > 0 && paths.length < limit) {
      const current = pending.shift();
      if (current === undefined) break;
      const currentNode = current.nodeIds.at(-1);
      if (currentNode === undefined) continue;
      const depth = current.relationshipIds.length;

      if (
        currentNode === query.to.id &&
        depth >= minDepth &&
        depth <= maxDepth
      ) {
        paths.push(current);
      }
      if (depth === maxDepth) continue;

      for (const edge of adjacency.get(currentNode) ?? []) {
        // Bounded simple paths are finite and match the incident evidence semantics.
        if (current.nodeIds.includes(edge.next)) continue;
        pending.push({
          nodeIds: [...current.nodeIds, edge.next],
          relationshipIds: [...current.relationshipIds, edge.relationship.id],
        });
      }
    }

    return paths;
  }

  async close(): Promise<void> {}
}

function uniqueRecords<T extends { id: StableId }>(
  records: readonly T[],
  kind: "node" | "relationship",
): Map<StableId, T> {
  const unique = new Map<StableId, T>();
  for (const record of records) {
    const existing = unique.get(record.id);
    if (
      existing !== undefined &&
      !graphRecordsSemanticallyEqual(existing, record)
    ) {
      throw new GraphConflictError(kind, record.id);
    }
    unique.set(record.id, record);
  }
  return unique;
}

function cloneRecord<T>(record: T): T {
  return structuredClone(record);
}

function assertEndpoint(
  nodes: ReadonlyMap<StableId, GraphNodeRecord>,
  relationship: GraphRelationshipRecord,
  endpoint: "from" | "to",
): void {
  const reference = relationship[endpoint];
  if (nodes.get(reference.id)?.label !== reference.label) {
    throw new MissingGraphEndpointError(relationship.id, reference.id);
  }
}

function addAdjacent(
  adjacency: Map<
    StableId,
    Array<{ relationship: GraphRelationshipRecord; next: StableId }>
  >,
  from: StableId,
  next: StableId,
  relationship: GraphRelationshipRecord,
): void {
  const existing = adjacency.get(from) ?? [];
  existing.push({ relationship, next });
  adjacency.set(from, existing);
}
