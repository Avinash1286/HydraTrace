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
  pathDisplayLimit?: number;
  pathCountLimit?: number;
  maxDepth?: number;
  offset?: number;
  limit?: number;
}

export interface BlastRadiusResult {
  incidentId: StableId;
  generatedAt: number;
  query: {
    at?: number;
    environments: readonly string[];
    includeDevelopment: boolean;
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
  events: readonly TimelineEvent[];
}
