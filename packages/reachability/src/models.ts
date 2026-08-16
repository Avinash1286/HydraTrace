import type { ReachabilityLevel, StableId } from "@hydratrace/domain";

export interface SourceFileInput {
  path: string;
  source: string;
}

export interface StaticAnalysisInput {
  repositoryId: string;
  commitSha: string;
  entrypoints: readonly string[];
  files: readonly SourceFileInput[];
}

export interface StaticPackageObservation {
  packageName: string;
  importers: readonly string[];
  specifiers: readonly string[];
  evidenceRefs: readonly string[];
}

export interface StaticAnalysisResult {
  repositoryId: string;
  commitSha: string;
  analyzedFiles: readonly string[];
  entrypoints: readonly string[];
  moduleEdges: readonly { from: string; to: string }[];
  unreachableFiles: readonly string[];
  packages: readonly StaticPackageObservation[];
  unknownDynamicBehavior: boolean;
  unknownExpressions: readonly { file: string; expression: string; evidenceRef: string }[];
}

export interface RuntimePackageObservation {
  name: string;
  version: string;
  firstLoadedAt: number;
  loadCount: number;
}

export interface RuntimeTrace {
  runId: string;
  startedAt: number;
  command: string;
  kind: "test" | "runtime";
  snapshotId: StableId;
  deploymentId?: StableId;
  packages: readonly RuntimePackageObservation[];
}

export interface ReachabilityEvidence {
  id: StableId;
  snapshotId: StableId;
  packageName: string;
  version?: string;
  level: ReachabilityLevel;
  source: "static" | "test-trace" | "runtime-trace" | "dynamic-unknown";
  observedAt: number;
  evidenceRefs: readonly string[];
  details: Readonly<Record<string, unknown>>;
}
