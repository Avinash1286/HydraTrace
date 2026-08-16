import { sha256Hex, stableIdFromCanonicalKey, type StableId } from "@hydratrace/domain";
import {
  graphRelationshipId,
  type GraphNodeRecord,
  type GraphRecords,
  type GraphRelationshipRecord,
} from "@hydratrace/graph-schema";
import type { GraphStore } from "@hydratrace/hydradb-client";
import type { CatalogEntry } from "@hydratrace/incident-analysis";
import type {
  ReachabilityEvidence,
  RuntimeTrace,
  StaticAnalysisInput,
  StaticAnalysisResult,
} from "@hydratrace/reachability";

export async function persistStaticReachability(
  store: GraphStore,
  entry: CatalogEntry,
  input: StaticAnalysisInput,
  result: StaticAnalysisResult,
  evidence: readonly ReachabilityEvidence[],
): Promise<void> {
  const nodes: GraphNodeRecord[] = [];
  const relationships: GraphRelationshipRecord[] = [];
  const modules = new Map<string, GraphNodeRecord<"SourceModule">>();
  for (const file of input.files) {
    const normalizedPath = normalizePath(file.path);
    if (!result.analyzedFiles.includes(normalizedPath)) continue;
    const id = sourceModuleId(entry.normalized.snapshot.id, normalizedPath);
    const node: GraphNodeRecord<"SourceModule"> = {
      id,
      label: "SourceModule",
      properties: {
        filePath: normalizedPath,
        language: language(normalizedPath),
        contentHash: sha256Hex(file.source),
      },
    };
    modules.set(normalizedPath, node);
    nodes.push(node);
  }
  for (const entrypoint of result.entrypoints) {
    const target = modules.get(entrypoint);
    if (target === undefined) continue;
    const id = stableIdFromCanonicalKey(`entrypoint:${entry.normalized.snapshot.id}:${entrypoint}`);
    nodes.push({ id, label: "EntryPoint", properties: { type: "application", command: entrypoint } });
    relationships.push(emptyRelationship("REACHES", id, "EntryPoint", target.id, "SourceModule"));
  }
  for (const edge of result.moduleEdges) {
    const from = modules.get(edge.from);
    const to = modules.get(edge.to);
    if (from !== undefined && to !== undefined) {
      relationships.push(emptyRelationship("IMPORTS_MODULE", from.id, "SourceModule", to.id, "SourceModule"));
    }
  }
  for (const observation of result.packages) {
    const externalId = stableIdFromCanonicalKey(
      `source-module:${entry.normalized.snapshot.id}:npm:${observation.packageName}`,
    );
    nodes.push({
      id: externalId,
      label: "SourceModule",
      properties: {
        filePath: `npm:${observation.packageName}`,
        language: "javascript-package",
        contentHash: sha256Hex(observation.specifiers.join("\0")),
      },
    });
    for (const importer of observation.importers) {
      const importerNode = modules.get(importer);
      if (importerNode !== undefined) {
        relationships.push(emptyRelationship("IMPORTS_MODULE", importerNode.id, "SourceModule", externalId, "SourceModule"));
      }
    }
    for (const version of entry.normalized.packages.filter(({ normalizedName }) =>
      normalizedName === observation.packageName.toLowerCase())) {
      relationships.push(emptyRelationship("BELONGS_TO", externalId, "SourceModule", version.id, "PackageVersion"));
    }
  }
  addEvidenceRecords(entry, evidence, nodes, relationships);
  await store.write({ nodes, relationships });
}

export async function persistRuntimeReachability(
  store: GraphStore,
  entry: CatalogEntry,
  trace: RuntimeTrace,
  evidence: readonly ReachabilityEvidence[],
): Promise<void> {
  const nodes: GraphNodeRecord[] = [];
  const relationships: GraphRelationshipRecord[] = [];
  addEvidenceRecords(entry, evidence, nodes, relationships);
  for (const record of evidence) {
    const details = record.details as { runId?: unknown; command?: unknown; loadCount?: unknown; deploymentId?: unknown };
    const observationId = stableIdFromCanonicalKey(`runtime-observation:${record.id}`);
    nodes.push({
      id: observationId,
      label: "RuntimeObservation",
      properties: {
        runId: typeof details.runId === "string" ? details.runId : trace.runId,
        observedAt: record.observedAt,
        source: record.source,
        snapshotId: record.snapshotId,
        packageName: record.packageName,
        version: record.version ?? "*",
        command: typeof details.command === "string" ? details.command : trace.command,
        loadCount: typeof details.loadCount === "number" ? details.loadCount : 1,
        ...(typeof details.deploymentId === "string" ? { deploymentId: details.deploymentId as StableId } : {}),
      },
    });
    for (const version of entry.normalized.packages.filter(({ normalizedName, version }) =>
      normalizedName === record.packageName.toLowerCase() &&
      (record.version === undefined || version === record.version))) {
      relationships.push(emptyRelationship("LOADED", observationId, "RuntimeObservation", version.id, "PackageVersion"));
    }
  }
  await store.write({ nodes, relationships });
}

function addEvidenceRecords(
  entry: CatalogEntry,
  evidence: readonly ReachabilityEvidence[],
  nodes: GraphNodeRecord[],
  relationships: GraphRelationshipRecord[],
): void {
  for (const record of evidence) {
    const detailsJson = canonicalJson(record.details);
    const evidenceRefsJson = JSON.stringify([...record.evidenceRefs]);
    nodes.push({
      id: record.id,
      label: "Evidence",
      properties: {
        type: `reachability:${record.source}`,
        sourceRef: record.evidenceRefs[0] ?? `reachability:${record.id}`,
        sha256: sha256Hex(`${evidenceRefsJson}\0${detailsJson}`),
        parserVersion: "0.1.0",
        snapshotId: record.snapshotId,
        packageName: record.packageName,
        level: record.level,
        observedAt: record.observedAt,
        evidenceRefsJson,
        detailsJson,
        ...(record.version === undefined ? {} : { version: record.version }),
      },
    });
    for (const resolution of entry.normalized.resolutions.filter(({ packageName, version }) =>
      packageName.toLowerCase() === record.packageName.toLowerCase() &&
      (record.version === undefined || version === record.version))) {
      relationships.push(emptyRelationship("SUPPORTS", record.id, "Evidence", resolution.id, "Resolution"));
    }
  }
}

function emptyRelationship<T extends GraphRelationshipRecord["type"]>(
  type: T,
  from: StableId,
  fromLabel: Extract<GraphRelationshipRecord, { type: T }>["from"]["label"],
  to: StableId,
  toLabel: Extract<GraphRelationshipRecord, { type: T }>["to"]["label"],
): Extract<GraphRelationshipRecord, { type: T }> {
  return {
    id: graphRelationshipId({ type, from, to }),
    type,
    from: { id: from, label: fromLabel },
    to: { id: to, label: toLabel },
    properties: {},
  } as Extract<GraphRelationshipRecord, { type: T }>;
}

function sourceModuleId(snapshotId: StableId, path: string): StableId {
  return stableIdFromCanonicalKey(`source-module:${snapshotId}:${path}`);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function language(path: string): string {
  if (/\.tsx?$/u.test(path)) return "typescript";
  if (/\.[cm]?jsx?$/u.test(path)) return "javascript";
  return "unknown";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

