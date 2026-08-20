import type { StableId } from "@hydratrace/domain";
import type { GraphStore } from "@hydratrace/hydradb-client";
import type { IncidentCatalog } from "@hydratrace/incident-analysis";
import {
  analyzeStaticImports,
  type RuntimeTrace,
} from "@hydratrace/reachability";
import type { ScanWorkflowInput } from "./scans.js";
import {
  persistRuntimeReachability,
  persistStaticReachability,
} from "./reachability-graph.js";

export interface ScanReachabilitySummary {
  evidenceAccepted: number;
  staticAnalysis?: {
    origin: "archive" | "precomputed";
    analyzedFiles: number;
    packageObservations: number;
    unknownDynamicBehavior: boolean;
    evidenceAccepted: number;
  };
  runtimeTrace?: {
    kind: "test" | "runtime";
    packageObservations: number;
    evidenceAccepted: number;
  };
}

/**
 * Canonically binds optional code/runtime observations to the snapshot made by
 * this scan. Call only after registerSnapshot so evidence cannot float without
 * an immutable lockfile snapshot.
 */
export async function persistScanReachability(
  graphStore: GraphStore,
  catalog: IncidentCatalog,
  input: ScanWorkflowInput,
  snapshotId: StableId,
): Promise<ScanReachabilitySummary> {
  const entry = catalog.entry(snapshotId);
  if (entry === undefined) throw new Error(`Snapshot ${snapshotId} was not registered before reachability analysis`);
  let evidenceAccepted = 0;
  let staticSummary: ScanReachabilitySummary["staticAnalysis"];
  let runtimeSummary: ScanReachabilitySummary["runtimeTrace"];

  if (input.staticAnalysis !== undefined) {
    const staticInput = {
      repositoryId: input.repositoryId,
      commitSha: input.commitSha,
      entrypoints: input.staticAnalysis.entrypoints,
      files: input.staticAnalysis.files,
    };
    const analysis = analyzeStaticImports(staticInput);
    const evidence = catalog.registerStaticAnalysis(
      snapshotId,
      analysis,
      input.staticAnalysis.observedAt ?? input.observedAt,
    );
    await persistStaticReachability(graphStore, entry, staticInput, analysis, evidence);
    evidenceAccepted += evidence.length;
    staticSummary = {
      origin: input.staticAnalysis.origin,
      analyzedFiles: analysis.analyzedFiles.length,
      packageObservations: analysis.packages.length,
      unknownDynamicBehavior: analysis.unknownDynamicBehavior,
      evidenceAccepted: evidence.length,
    };
  }

  if (input.runtimeTrace !== undefined) {
    const { deploymentId, ...runtimeInput } = input.runtimeTrace;
    const trace: RuntimeTrace = {
      ...runtimeInput,
      snapshotId,
      ...(deploymentId === undefined
        ? {}
        : { deploymentId: deploymentId as StableId }),
    };
    const evidence = catalog.registerRuntimeTrace(trace);
    await persistRuntimeReachability(graphStore, entry, trace, evidence);
    evidenceAccepted += evidence.length;
    runtimeSummary = {
      kind: trace.kind,
      packageObservations: trace.packages.length,
      evidenceAccepted: evidence.length,
    };
  }

  return {
    evidenceAccepted,
    ...(staticSummary === undefined ? {} : { staticAnalysis: staticSummary }),
    ...(runtimeSummary === undefined ? {} : { runtimeTrace: runtimeSummary }),
  };
}
