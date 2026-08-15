import type { StableId } from "@hydratrace/domain";
import type {
  NodeLabel,
  NodePropertiesByLabel,
  RelationshipEndpoints,
  RelationshipPropertiesByType,
  RelationshipType,
} from "./schema.js";

export type GraphNodeRecord<L extends NodeLabel = NodeLabel> = {
  [K in L]: {
    id: StableId;
    label: K;
    properties: Readonly<NodePropertiesByLabel[K]>;
  };
}[L];

export interface GraphNodeRef<L extends NodeLabel = NodeLabel> {
  id: StableId;
  label: L;
}

export type GraphRelationshipRecord<
  T extends RelationshipType = RelationshipType,
> = {
  [K in T]: {
    id: StableId;
    type: K;
    from: GraphNodeRef<RelationshipEndpoints[K]["from"]>;
    to: GraphNodeRef<RelationshipEndpoints[K]["to"]>;
    properties: Readonly<RelationshipPropertiesByType[K]>;
  };
}[T];

export interface GraphRecords {
  nodes: readonly GraphNodeRecord[];
  relationships: readonly GraphRelationshipRecord[];
}

export interface GraphPath {
  nodeIds: readonly StableId[];
  relationshipIds: readonly StableId[];
}
