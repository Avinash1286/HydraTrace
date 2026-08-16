import type { DependencyKind, FactProvenance, StableId } from "@hydratrace/domain";

export const NODE_LABELS = [
  "Organization",
  "Repository",
  "Service",
  "Commit",
  "Environment",
  "Deployment",
  "LockfileSnapshot",
  "Resolution",
  "Package",
  "PackageVersion",
  "Advisory",
  "IncidentWindow",
  "Maintainer",
  "Infrastructure",
  "SourceModule",
  "EntryPoint",
  "RuntimeObservation",
  "Evidence",
  "RemediationCandidate",
  "RemediationRun",
  "RemediationVerification",
] as const;

export type NodeLabel = (typeof NODE_LABELS)[number];

export const RELATIONSHIP_TYPES = [
  "OWNS",
  "CONTAINS_SERVICE",
  "HAS_COMMIT",
  "HAS_DEPLOYMENT",
  "RUNS_COMMIT",
  "IN_ENVIRONMENT",
  "USES_SNAPSHOT",
  "CONTAINS",
  "SUPERSEDES",
  "INSTANCE_OF",
  "DEPENDS_ON_INSTANCE",
  "VERSION_OF",
  "DECLARES_DEPENDENCY",
  "RESOLVES_PUBLICLY_TO",
  "AFFECTED_BY",
  "ACTIVE_DURING",
  "PUBLISHED_BY",
  "BUILT_FROM",
  "USES_INFRASTRUCTURE",
  "SIMILAR_NAME_TO",
  "REACHES",
  "IMPORTS_MODULE",
  "BELONGS_TO",
  "LOADED",
  "SUPPORTS",
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export type GraphPropertyPrimitive = string | number | boolean;
export type GraphPropertyValue =
  | GraphPropertyPrimitive
  | readonly GraphPropertyPrimitive[];

export interface ProvenanceProperties {
  sourceType: FactProvenance["sourceType"];
  sourceRef: string;
  sourceSha256: string;
  repositoryId: string;
  commitSha: string;
  importRunId: StableId;
  observedAt: number;
  parserVersion: string;
  confidence: number;
}

type EmptyProperties = Record<string, never>;

export interface NodePropertiesByLabel {
  Organization: { name: string };
  Repository: { url: string; defaultBranch?: string };
  Service: { name: string; repositoryId: string };
  Commit: { sha: string; committedAt?: number };
  Environment: { name: string; criticality: string };
  Deployment: {
    startedAt: number;
    endedAt?: number;
    status: string;
  };
  LockfileSnapshot: {
    ecosystem: "npm";
    lockfileType: "package-lock" | "pnpm-lock";
    contentHash: string;
    sha256: string;
    repositoryId: string;
    commitSha: string;
    sourceRef: string;
    parserVersion: string;
    createdAt: number;
    validUntil?: number;
  };
  Resolution: ProvenanceProperties & {
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
  };
  Package: {
    ecosystem: "npm";
    name: string;
    normalizedName: string;
  };
  PackageVersion: {
    packageId: StableId;
    ecosystem: "npm";
    name: string;
    normalizedName: string;
    version: string;
    deprecated?: boolean;
    publishedAt?: number;
  };
  Advisory: {
    summary: string;
    severity: string;
    publishedAt?: number;
    modifiedAt?: number;
  };
  IncidentWindow: {
    startsAt?: number;
    endsAt?: number;
    source: string;
    confidence: number;
    ecosystem: "npm";
    packageName: string;
    normalizedPackageName: string;
    affectedVersionsJson: string;
    environmentsJson: string;
    advisoryId?: string;
    advisoryPublishedAt?: number;
    advisoryWithdrawnAt?: number;
    packagePublishedAt?: number;
    windowSource: string;
    severityScore: number;
    trustContextScore: number;
    createdAt: number;
  };
  Maintainer: { username: string; emailHash?: string; emailDomain?: string };
  Infrastructure: { type: string; value: string };
  SourceModule: { filePath: string; language: string; contentHash: string };
  EntryPoint: { type: string; command: string };
  RuntimeObservation: {
    runId: string;
    observedAt: number;
    source: string;
    snapshotId: StableId;
    deploymentId?: StableId;
    packageName: string;
    version: string;
    command: string;
    loadCount: number;
  };
  Evidence: {
    type: string;
    sourceRef: string;
    sha256: string;
    parserVersion: string;
    snapshotId: StableId;
    packageName: string;
    version?: string;
    level: number;
    observedAt: number;
    evidenceRefsJson: string;
    detailsJson: string;
  };
  RemediationCandidate: { fromVersion: string; toVersion: string; cost: number };
  RemediationRun: {
    incidentId: StableId;
    createdAt: number;
    beforePathIdsJson: string;
    solutionJson: string;
    status: string;
  };
  RemediationVerification: {
    runId: StableId;
    createdAt: number;
    level: string;
    snapshotIdsJson: string;
    remainingPathCount: number;
    passed: boolean;
    message: string;
    status: string;
  };
}

export interface RelationshipEndpoints {
  OWNS: { from: "Organization"; to: "Repository" };
  CONTAINS_SERVICE: { from: "Repository"; to: "Service" };
  HAS_COMMIT: { from: "Repository"; to: "Commit" };
  HAS_DEPLOYMENT: { from: "Service"; to: "Deployment" };
  RUNS_COMMIT: { from: "Deployment"; to: "Commit" };
  IN_ENVIRONMENT: { from: "Deployment"; to: "Environment" };
  USES_SNAPSHOT: { from: "Deployment"; to: "LockfileSnapshot" };
  CONTAINS: { from: "LockfileSnapshot"; to: "Resolution" };
  SUPERSEDES: { from: "LockfileSnapshot"; to: "LockfileSnapshot" };
  INSTANCE_OF: { from: "Resolution"; to: "PackageVersion" };
  DEPENDS_ON_INSTANCE: { from: "Resolution"; to: "Resolution" };
  VERSION_OF: { from: "PackageVersion"; to: "Package" };
  DECLARES_DEPENDENCY: { from: "PackageVersion"; to: "Package" };
  RESOLVES_PUBLICLY_TO: { from: "PackageVersion"; to: "PackageVersion" };
  AFFECTED_BY: { from: "PackageVersion"; to: "Advisory" };
  ACTIVE_DURING: { from: "Advisory"; to: "IncidentWindow" };
  PUBLISHED_BY: { from: "PackageVersion"; to: "Maintainer" };
  BUILT_FROM: { from: "PackageVersion"; to: "Commit" };
  USES_INFRASTRUCTURE: { from: "PackageVersion"; to: "Infrastructure" };
  SIMILAR_NAME_TO: { from: "Package"; to: "Package" };
  REACHES: { from: "EntryPoint"; to: "SourceModule" };
  IMPORTS_MODULE: { from: "SourceModule"; to: "SourceModule" };
  BELONGS_TO: { from: "SourceModule"; to: "PackageVersion" };
  LOADED: { from: "RuntimeObservation"; to: "PackageVersion" };
  SUPPORTS: {
    from: "Evidence";
    to: "Deployment" | "Resolution" | "Advisory";
  };
}

export const RELATIONSHIP_ENDPOINT_LABELS = {
  OWNS: { from: ["Organization"], to: ["Repository"] },
  CONTAINS_SERVICE: { from: ["Repository"], to: ["Service"] },
  HAS_COMMIT: { from: ["Repository"], to: ["Commit"] },
  HAS_DEPLOYMENT: { from: ["Service"], to: ["Deployment"] },
  RUNS_COMMIT: { from: ["Deployment"], to: ["Commit"] },
  IN_ENVIRONMENT: { from: ["Deployment"], to: ["Environment"] },
  USES_SNAPSHOT: { from: ["Deployment"], to: ["LockfileSnapshot"] },
  CONTAINS: { from: ["LockfileSnapshot"], to: ["Resolution"] },
  SUPERSEDES: { from: ["LockfileSnapshot"], to: ["LockfileSnapshot"] },
  INSTANCE_OF: { from: ["Resolution"], to: ["PackageVersion"] },
  DEPENDS_ON_INSTANCE: { from: ["Resolution"], to: ["Resolution"] },
  VERSION_OF: { from: ["PackageVersion"], to: ["Package"] },
  DECLARES_DEPENDENCY: { from: ["PackageVersion"], to: ["Package"] },
  RESOLVES_PUBLICLY_TO: { from: ["PackageVersion"], to: ["PackageVersion"] },
  AFFECTED_BY: { from: ["PackageVersion"], to: ["Advisory"] },
  ACTIVE_DURING: { from: ["Advisory"], to: ["IncidentWindow"] },
  PUBLISHED_BY: { from: ["PackageVersion"], to: ["Maintainer"] },
  BUILT_FROM: { from: ["PackageVersion"], to: ["Commit"] },
  USES_INFRASTRUCTURE: { from: ["PackageVersion"], to: ["Infrastructure"] },
  SIMILAR_NAME_TO: { from: ["Package"], to: ["Package"] },
  REACHES: { from: ["EntryPoint"], to: ["SourceModule"] },
  IMPORTS_MODULE: { from: ["SourceModule"], to: ["SourceModule"] },
  BELONGS_TO: { from: ["SourceModule"], to: ["PackageVersion"] },
  LOADED: { from: ["RuntimeObservation"], to: ["PackageVersion"] },
  SUPPORTS: {
    from: ["Evidence"],
    to: ["Deployment", "Resolution", "Advisory"],
  },
} as const satisfies {
  [T in RelationshipType]: {
    from: readonly RelationshipEndpoints[T]["from"][];
    to: readonly RelationshipEndpoints[T]["to"][];
  };
};

export interface RelationshipPropertiesByType {
  OWNS: EmptyProperties;
  CONTAINS_SERVICE: EmptyProperties;
  HAS_COMMIT: EmptyProperties;
  HAS_DEPLOYMENT: EmptyProperties;
  RUNS_COMMIT: EmptyProperties;
  IN_ENVIRONMENT: EmptyProperties;
  USES_SNAPSHOT: EmptyProperties;
  CONTAINS: ProvenanceProperties;
  SUPERSEDES: EmptyProperties;
  INSTANCE_OF: ProvenanceProperties;
  DEPENDS_ON_INSTANCE: ProvenanceProperties & {
    dependencyName: string;
    specifier?: string;
    kind: DependencyKind;
  };
  VERSION_OF: ProvenanceProperties;
  DECLARES_DEPENDENCY: { dependencyName: string; specifier: string };
  RESOLVES_PUBLICLY_TO: EmptyProperties;
  AFFECTED_BY: EmptyProperties;
  ACTIVE_DURING: EmptyProperties;
  PUBLISHED_BY: EmptyProperties;
  BUILT_FROM: EmptyProperties;
  USES_INFRASTRUCTURE: EmptyProperties;
  SIMILAR_NAME_TO: { reason: string; score: number };
  REACHES: EmptyProperties;
  IMPORTS_MODULE: EmptyProperties;
  BELONGS_TO: EmptyProperties;
  LOADED: EmptyProperties;
  SUPPORTS: EmptyProperties;
}

export function isNodeLabel(value: string): value is NodeLabel {
  return (NODE_LABELS as readonly string[]).includes(value);
}

export function isRelationshipType(value: string): value is RelationshipType {
  return (RELATIONSHIP_TYPES as readonly string[]).includes(value);
}
