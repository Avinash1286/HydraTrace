import type {
  DeploymentManifest,
  NormalizedSnapshot,
  ReachabilityLevel,
  StableId,
} from "@hydratrace/domain";
import type { ReachabilityEvidence } from "@hydratrace/reachability";

export interface IncidentInput {
  ecosystem: "npm";
  packageName: string;
  affectedVersions: readonly string[];
  advisoryId?: string;
  advisoryPublishedAt?: number;
  advisoryWithdrawnAt?: number;
  packagePublishedAt?: number;
  startsAt?: number;
  endsAt?: number;
  environments?: readonly string[];
  source?: "manual" | "osv" | "both";
  windowSource?: string;
  windowConfidence?: number;
  severityScore?: number;
  trustContextScore?: number;
}

export interface IncidentRecord {
  id: StableId;
  ecosystem: "npm";
  packageName: string;
  normalizedPackageName: string;
  affectedVersions: readonly string[];
  advisoryId?: string;
  advisoryPublishedAt?: number;
  advisoryWithdrawnAt?: number;
  packagePublishedAt?: number;
  startsAt?: number;
  endsAt?: number;
  environments: readonly string[];
  source: "manual" | "osv" | "both";
  windowSource: string;
  windowConfidence: number;
  severityScore: number;
  trustContextScore: number;
  createdAt: number;
}

export interface CatalogEntry {
  normalized: NormalizedSnapshot;
  deployments: readonly DeploymentManifest[];
}

export interface EvidencePathNode {
  resolutionId: StableId;
  packageVersionId: StableId;
  packageName: string;
  version: string;
  sourceKey: string;
  root: boolean;
  direct: boolean;
  dev: boolean;
  optional: boolean;
  peer: boolean;
}

export interface EvidencePath {
  pathId: StableId;
  snapshotId: StableId;
  resolutionIds: readonly StableId[];
  relationshipIds: readonly StableId[];
  dependencyKinds: readonly string[];
  nodes: readonly EvidencePathNode[];
  direct: boolean;
  developmentOnly: boolean;
  evidenceRefs: readonly string[];
}

export interface BlastRadiusFinding {
  findingId: StableId;
  serviceId: string;
  deploymentId: StableId;
  repositoryId: string;
  commitSha: string;
  lockfileSourceRef: string;
  lockfileSha256: string;
  environment: string;
  criticality: DeploymentManifest["criticality"];
  snapshotId: StableId;
  affectedPackageVersionId: StableId;
  affectedPackageName: string;
  affectedVersion: string;
  advisoryId?: string;
  incidentSource: "manual" | "osv" | "both";
  windowSource: string;
  firstExposedAt: number;
  lastExposedAt: number | null;
  direct: boolean;
  developmentOnly: boolean;
  pathCount: number;
  /** True when the traversal cap prevents pathCount from being exact. */
  pathCountTruncated: boolean;
  displayedPaths: readonly EvidencePath[];
  pathsTruncated: boolean;
  reachability: ReachabilityLevel;
  reachabilityEvidence: readonly ReachabilityEvidence[];
  evidenceRefs: readonly string[];
  confidence: number;
  unknowns: readonly string[];
  risk: RiskScore;
}

export interface RiskScoreComponent {
  name: "severity" | "environment" | "reachability" | "exposureBreadth" | "incidentTiming" | "trustContext";
  raw: number;
  weight: number;
  contribution: number;
}

export interface RiskScore {
  score: number;
  label: "Critical" | "High" | "Medium" | "Low";
  components: readonly RiskScoreComponent[];
}

export interface BlastRadiusQuery {
  at?: number;
  environments?: readonly string[];
  includeDevelopment?: boolean;
  /** Internal/public projection offset for the displayed path window. */
  pathOffset?: number;
  pathDisplayLimit?: number;
  pathCountLimit?: number;
  maxDepth?: number;
  offset?: number;
  limit?: number;
  /** Internal exact-finding selector used by the bounded finding detail route. */
  findingId?: StableId;
}

/**
 * A dependency path already traversed by the configured graph store. Keeping
 * this transport-shaped type independent of a particular database lets the
 * in-memory store remain the deterministic reference implementation.
 */
export interface TraversedDependencyPath {
  nodeIds: readonly StableId[];
  relationshipIds: readonly StableId[];
}

export interface TraversedDependencyPathSet {
  paths: readonly TraversedDependencyPath[];
  truncated: boolean;
}

export interface BlastRadiusPathLookupInput {
  snapshotId: StableId;
  affectedPackageVersionId: StableId;
  targetResolutionIds: ReadonlySet<StableId>;
}

export type BlastRadiusPathLookup = (
  input: BlastRadiusPathLookupInput,
) => TraversedDependencyPathSet | undefined;

export interface BlastRadiusResult {
  incidentId: StableId;
  generatedAt: number;
  query: {
    at?: number;
    environments: readonly string[];
    includeDevelopment: boolean;
    pathOffset: number;
    pathDisplayLimit: number;
    pathCountLimit: number;
    maxDepth: number;
  };
  totalFindings: number;
  totalAffectedServices: number;
  totalAffectedDeployments: number;
  totalPaths: number;
  pathsTruncated: boolean;
  offset: number;
  limit: number;
  findings: readonly BlastRadiusFinding[];
}

export type TimelineEventType =
  | "PACKAGE_VERSION_PUBLISHED"
  | "ADVISORY_PUBLISHED"
  | "ADVISORY_WITHDRAWN"
  | "INCIDENT_STARTED"
  | "SNAPSHOT_CREATED"
  | "DEPLOYMENT_STARTED"
  | "EXPOSURE_STARTED"
  | "DEPLOYMENT_ENDED"
  | "EXPOSURE_ENDED"
  | "STATIC_REACHABILITY_DETECTED"
  | "RUNTIME_OBSERVATION_RECORDED"
  | "FIXED_SNAPSHOT_CREATED"
  | "FIXED_SNAPSHOT_DEPLOYED"
  | "FINAL_EXPOSURE_PATH_REMOVED"
  | "INCIDENT_ENDED";

export interface TimelineEvent {
  eventId: StableId;
  type: TimelineEventType;
  at: number;
  serviceId?: string;
  deploymentId?: StableId;
  snapshotId?: StableId;
  affectedVersion?: string;
  exposureCountAfter: number;
  evidenceRefs: readonly string[];
}

export interface ExposureTimeline {
  incidentId: StableId;
  startsAt: number | null;
  endsAt: number | null;
  sourceFindingCount: number;
  consideredFindingCount: number;
  sourceFindingsTruncated: boolean;
  events: readonly TimelineEvent[];
}
