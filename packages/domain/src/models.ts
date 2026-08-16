import type { StableId } from "./ids.js";

export type Ecosystem = "npm";
export type LockfileType = "package-lock" | "pnpm-lock";
export type DependencyKind = "production" | "development" | "optional" | "peer";

export enum ReachabilityLevel {
  NotPresent = 0,
  Installed = 1,
  StaticReachable = 2,
  TestObserved = 3,
  RuntimeObserved = 4,
  UnknownDynamicBehavior = 5,
}

export interface FactProvenance {
  sourceType: LockfileType | "osv" | "deployment-manifest" | "manual";
  sourceRef: string;
  sourceSha256: string;
  repositoryId: string;
  commitSha: string;
  importRunId: StableId;
  observedAt: number;
  parserVersion: string;
  confidence: number;
}

export interface NormalizedPackage {
  id: StableId;
  ecosystem: Ecosystem;
  name: string;
  normalizedName: string;
}

export interface NormalizedPackageVersion {
  id: StableId;
  packageId: StableId;
  name: string;
  normalizedName: string;
  ecosystem: Ecosystem;
  version: string;
  deprecated?: boolean;
  integrity?: string;
  resolved?: string;
  provenance: FactProvenance;
}

export interface NormalizedResolution {
  id: StableId;
  snapshotId: StableId;
  packageVersionId: StableId;
  packageName: string;
  version: string;
  sourceKey: string;
  installPath: string;
  root: boolean;
  direct: boolean;
  dev: boolean;
  optional: boolean;
  peer: boolean;
  integrity?: string;
  resolved?: string;
  provenance: FactProvenance;
}

export interface NormalizedResolutionEdge {
  id: StableId;
  snapshotId: StableId;
  fromResolutionId: StableId;
  toResolutionId: StableId;
  dependencyName: string;
  specifier?: string;
  kind: DependencyKind;
  provenance: FactProvenance;
}

export interface ParserWarning {
  code:
    | "INVALID_ENTRY"
    | "MISSING_VERSION"
    | "UNRESOLVED_DEPENDENCY"
    | "UNSUPPORTED_LINK"
    | "AMBIGUOUS_RESOLUTION";
  message: string;
  sourceKey?: string;
  dependencyName?: string;
}

export interface NormalizedSnapshot {
  snapshot: {
    id: StableId;
    ecosystem: Ecosystem;
    lockfileType: LockfileType;
    contentHash: string;
    repositoryId: string;
    commitSha: string;
    sourceRef: string;
    parserVersion: string;
    createdAt: number;
    validUntil?: number;
  };
  packages: NormalizedPackageVersion[];
  resolutions: NormalizedResolution[];
  edges: NormalizedResolutionEdge[];
  warnings: ParserWarning[];
}

export interface LockfileParserOptions {
  repositoryId: string;
  commitSha: string;
  sourceRef: string;
  observedAt: number;
  parserVersion?: string;
  importRunId?: StableId;
  rootPackage?: {
    name: string;
    version: string;
  };
}

export interface DeploymentManifest {
  schemaVersion: 1;
  organizationId: string;
  repositoryId: string;
  serviceId: string;
  deploymentId: StableId;
  environment: string;
  criticality: "production" | "staging" | "development" | "unknown";
  commitSha: string;
  lockfile: string;
  lockfileSha256: string;
  startedAt: number;
  endedAt: number | null;
}

export interface OsvPackageQuery {
  ecosystem: "npm";
  name: string;
  version: string;
}

export interface OsvAdvisorySummary {
  id: string;
  aliases: string[];
  summary: string;
  severity: Array<{ type: string; score: string }>;
  published?: string;
  modified?: string;
  withdrawn?: string;
  affected: unknown[];
  references: Array<{ type: string; url: string }>;
  source: "osv";
}
