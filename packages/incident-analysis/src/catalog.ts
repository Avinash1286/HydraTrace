import {
  canonicalKeys,
  normalizeNpmPackageName,
  ReachabilityLevel,
  stableIdFromCanonicalKey,
  type DeploymentManifest,
  type NormalizedSnapshot,
  type StableId,
} from "@hydratrace/domain";
import type {
  ReachabilityEvidence,
  RuntimeTrace,
  StaticAnalysisResult,
} from "@hydratrace/reachability";
import type { CatalogEntry, IncidentInput, IncidentRecord } from "./models.js";

interface MutableCatalogEntry {
  normalized: NormalizedSnapshot;
  fingerprint: string;
  deployments: Map<StableId, DeploymentManifest>;
}

/**
 * Deterministic incident catalog used by the engine and correctness tests.
 * HydraDB remains the graph/path source of truth; this catalog retains the
 * normalized import contracts needed for temporal filtering and API responses.
 */
export class IncidentCatalog {
  readonly #entries = new Map<StableId, MutableCatalogEntry>();
  readonly #incidents = new Map<StableId, IncidentRecord>();
  readonly #reachability = new Map<StableId, ReachabilityEvidence>();

  registerSnapshot(
    normalized: NormalizedSnapshot,
    deployment?: DeploymentManifest,
  ): void {
    const fingerprint = snapshotFingerprint(normalized);
    const existing = this.#entries.get(normalized.snapshot.id);
    if (existing !== undefined && existing.fingerprint !== fingerprint) {
      throw new Error(
        `Conflicting normalized snapshot for canonical ID ${normalized.snapshot.id}`,
      );
    }

    const entry =
      existing ??
      ({
        normalized: structuredClone(normalized),
        fingerprint,
        deployments: new Map<StableId, DeploymentManifest>(),
      } satisfies MutableCatalogEntry);
    if (existing === undefined) this.#entries.set(normalized.snapshot.id, entry);

    if (deployment !== undefined) {
      const stored = entry.deployments.get(deployment.deploymentId);
      if (stored !== undefined && canonicalJson(stored) !== canonicalJson(deployment)) {
        throw new Error(
          `Conflicting deployment for canonical ID ${deployment.deploymentId}`,
        );
      }
      if (stored === undefined) {
        entry.deployments.set(deployment.deploymentId, structuredClone(deployment));
      }
    }
  }

  createIncident(input: IncidentInput, now = Date.now()): IncidentRecord {
    const normalizedPackageName = normalizeNpmPackageName(input.packageName);
    const affectedVersions = [...new Set(input.affectedVersions.map((value) => value.trim()))]
      .filter((value) => value.length > 0)
      .sort();
    if (affectedVersions.length === 0) {
      throw new Error("At least one exact affected version is required");
    }
    if (input.startsAt !== undefined && !isTimestamp(input.startsAt)) {
      throw new Error("Incident startsAt must be a nonnegative integer timestamp");
    }
    if (input.endsAt !== undefined && !isTimestamp(input.endsAt)) {
      throw new Error("Incident endsAt must be a nonnegative integer timestamp");
    }
    if (input.advisoryWithdrawnAt !== undefined && !isTimestamp(input.advisoryWithdrawnAt)) {
      throw new Error("Incident advisoryWithdrawnAt must be a nonnegative integer timestamp");
    }
    if (
      input.startsAt !== undefined &&
      input.endsAt !== undefined &&
      input.endsAt < input.startsAt
    ) {
      throw new Error("Incident endsAt must not be earlier than startsAt");
    }
    if (!Number.isFinite(input.windowConfidence ?? 1)) {
      throw new Error("Incident windowConfidence must be finite");
    }
    if (!isUnitScore(input.severityScore ?? 0.8)) {
      throw new Error("Incident severityScore must be between 0 and 1");
    }
    if (!isUnitScore(input.trustContextScore ?? 0.5)) {
      throw new Error("Incident trustContextScore must be between 0 and 1");
    }
    const windowConfidence = Math.min(1, Math.max(0, input.windowConfidence ?? 1));
    const environments = [
      ...new Set((input.environments ?? []).map((value) => value.trim().toLowerCase())),
    ]
      .filter((value) => value.length > 0)
      .sort();
    const identity = [
      "incident",
      normalizedPackageName,
      affectedVersions.join(","),
      input.advisoryId ?? "",
      input.startsAt ?? "",
      input.endsAt ?? "",
      input.advisoryWithdrawnAt ?? "",
      environments.join(","),
    ].join(":");
    const id = stableIdFromCanonicalKey(identity);
    const incident: IncidentRecord = {
      id,
      ecosystem: "npm",
      packageName: input.packageName.trim(),
      normalizedPackageName,
      affectedVersions,
      environments,
      source: input.source ?? (input.advisoryId === undefined ? "manual" : "osv"),
      windowSource: input.windowSource ?? (input.startsAt === undefined ? "unknown" : "manual"),
      windowConfidence,
      severityScore: input.severityScore ?? 0.8,
      trustContextScore: input.trustContextScore ?? 0.5,
      createdAt: now,
      ...(input.advisoryId === undefined ? {} : { advisoryId: input.advisoryId }),
      ...(input.advisoryPublishedAt === undefined ? {} : { advisoryPublishedAt: input.advisoryPublishedAt }),
      ...(input.advisoryWithdrawnAt === undefined ? {} : { advisoryWithdrawnAt: input.advisoryWithdrawnAt }),
      ...(input.packagePublishedAt === undefined ? {} : { packagePublishedAt: input.packagePublishedAt }),
      ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
      ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
    };

    const existing = this.#incidents.get(id);
    if (existing !== undefined) return structuredClone(existing);
    this.#incidents.set(id, structuredClone(incident));
    return structuredClone(incident);
  }

  getIncident(id: StableId): IncidentRecord | undefined {
    const incident = this.#incidents.get(id);
    return incident === undefined ? undefined : structuredClone(incident);
  }

  listIncidents(): readonly IncidentRecord[] {
    return [...this.#incidents.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((incident) => structuredClone(incident));
  }

  stats(): {
    repositories: number;
    snapshots: number;
    packageVersions: number;
    resolutions: number;
    dependencyEdges: number;
    deployments: number;
    incidents: number;
    reachabilityEvidence: number;
  } {
    const entries = [...this.#entries.values()];
    return {
      repositories: new Set(entries.map(({ normalized }) => normalized.snapshot.repositoryId)).size,
      snapshots: entries.length,
      packageVersions: entries.reduce((sum, { normalized }) => sum + normalized.packages.length, 0),
      resolutions: entries.reduce((sum, { normalized }) => sum + normalized.resolutions.length, 0),
      dependencyEdges: entries.reduce((sum, { normalized }) => sum + normalized.edges.length, 0),
      deployments: entries.reduce((sum, { deployments }) => sum + deployments.size, 0),
      incidents: this.#incidents.size,
      reachabilityEvidence: this.#reachability.size,
    };
  }

  entries(): readonly CatalogEntry[] {
    return [...this.#entries.values()]
      .sort((left, right) => left.normalized.snapshot.id.localeCompare(right.normalized.snapshot.id))
      .map((entry) => ({
        normalized: structuredClone(entry.normalized),
        deployments: [...entry.deployments.values()]
          .sort((left, right) => left.deploymentId.localeCompare(right.deploymentId))
          .map((deployment) => structuredClone(deployment)),
      }));
  }

  entry(snapshotId: StableId): CatalogEntry | undefined {
    const entry = this.#entries.get(snapshotId);
    return entry === undefined
      ? undefined
      : {
          normalized: structuredClone(entry.normalized),
          deployments: [...entry.deployments.values()].map((deployment) =>
            structuredClone(deployment),
          ),
        };
  }

  registerStaticAnalysis(
    snapshotId: StableId,
    result: StaticAnalysisResult,
    observedAt = Date.now(),
  ): readonly ReachabilityEvidence[] {
    const entry = this.#entries.get(snapshotId);
    if (entry === undefined) throw new Error(`Snapshot ${snapshotId} was not found`);
    if (entry.normalized.snapshot.repositoryId !== result.repositoryId) {
      throw new Error("Static analysis repositoryId does not match the snapshot");
    }
    if (entry.normalized.snapshot.commitSha !== result.commitSha) {
      throw new Error("Static analysis commitSha does not match the snapshot");
    }
    const evidence: ReachabilityEvidence[] = [];
    for (const observation of result.packages) {
      for (const version of entry.normalized.packages.filter(
        ({ normalizedName }) => normalizedName === normalizeNpmPackageName(observation.packageName),
      )) {
        evidence.push(
          this.#storeReachability({
            snapshotId,
            packageName: version.name,
            version: version.version,
            level: ReachabilityLevel.StaticReachable,
            source: "static",
            observedAt,
            evidenceRefs: observation.evidenceRefs,
            details: {
              importers: observation.importers,
              specifiers: observation.specifiers,
              analyzedFiles: result.analyzedFiles,
            },
          }),
        );
      }
    }
    if (result.unknownDynamicBehavior) {
      const dynamicRefs = result.unknownExpressions.map(({ evidenceRef }) => evidenceRef);
      for (const version of entry.normalized.packages) {
        evidence.push(
          this.#storeReachability({
            snapshotId,
            packageName: version.name,
            version: version.version,
            level: ReachabilityLevel.UnknownDynamicBehavior,
            source: "dynamic-unknown",
            observedAt,
            evidenceRefs: dynamicRefs,
            details: { unknownExpressions: result.unknownExpressions },
          }),
        );
      }
    }
    return evidence;
  }

  registerRuntimeTrace(trace: RuntimeTrace): readonly ReachabilityEvidence[] {
    const entry = this.#entries.get(trace.snapshotId);
    if (entry === undefined) throw new Error(`Snapshot ${trace.snapshotId} was not found`);
    if (
      trace.deploymentId !== undefined &&
      !entry.deployments.has(trace.deploymentId)
    ) {
      throw new Error("Runtime trace deploymentId does not belong to the snapshot");
    }
    const evidence: ReachabilityEvidence[] = [];
    for (const observation of trace.packages) {
      const installed = entry.normalized.packages.some(
        ({ normalizedName, version }) =>
          normalizedName === normalizeNpmPackageName(observation.name) &&
          version === observation.version,
      );
      if (!installed) continue;
      const level =
        trace.kind === "runtime"
          ? ReachabilityLevel.RuntimeObserved
          : ReachabilityLevel.TestObserved;
      const source = trace.kind === "runtime" ? "runtime-trace" : "test-trace";
      evidence.push(
        this.#storeReachability({
          snapshotId: trace.snapshotId,
          packageName: observation.name,
          version: observation.version,
          level,
          source,
          observedAt: observation.firstLoadedAt,
          evidenceRefs: [`E-${trace.kind.toUpperCase()}-${trace.runId}`],
          details: {
            runId: trace.runId,
            command: trace.command,
            loadCount: observation.loadCount,
            ...(trace.deploymentId === undefined
              ? {}
              : { deploymentId: trace.deploymentId }),
          },
        }),
      );
    }
    return evidence;
  }

  reachabilityFor(
    snapshotId: StableId,
    packageName: string,
    version: string,
  ): readonly ReachabilityEvidence[] {
    const normalizedName = normalizeNpmPackageName(packageName);
    return [...this.#reachability.values()]
      .filter(
        (evidence) =>
          evidence.snapshotId === snapshotId &&
          normalizeNpmPackageName(evidence.packageName) === normalizedName &&
          (evidence.version === undefined || evidence.version === version),
      )
      .sort(compareReachabilityEvidence)
      .map((evidence) => structuredClone(evidence));
  }

  registerReachabilityEvidence(input: ReachabilityEvidence): ReachabilityEvidence {
    const entry = this.#entries.get(input.snapshotId);
    if (entry === undefined) throw new Error(`Snapshot ${input.snapshotId} was not found`);
    const installed = entry.normalized.packages.some(
      ({ normalizedName, version }) =>
        normalizedName === normalizeNpmPackageName(input.packageName) &&
        (input.version === undefined || version === input.version),
    );
    if (!installed) throw new Error("Reachability evidence does not match an installed package version");
    const expectedId = stableIdFromCanonicalKey(
      `reachability:${input.snapshotId}:${normalizeNpmPackageName(input.packageName)}:${input.version ?? "*"}:${input.source}:${input.evidenceRefs.join(",")}`,
    );
    if (input.id !== expectedId) throw new Error("Reachability evidence ID is not canonical");
    const existing = this.#reachability.get(input.id);
    if (existing !== undefined) return structuredClone(existing);
    this.#reachability.set(input.id, structuredClone(input));
    return structuredClone(input);
  }

  clear(): void {
    this.#entries.clear();
    this.#incidents.clear();
    this.#reachability.clear();
  }

  #storeReachability(
    input: Omit<ReachabilityEvidence, "id">,
  ): ReachabilityEvidence {
    const id = stableIdFromCanonicalKey(
      `reachability:${input.snapshotId}:${normalizeNpmPackageName(input.packageName)}:${input.version ?? "*"}:${input.source}:${input.evidenceRefs.join(",")}`,
    );
    const record: ReachabilityEvidence = { id, ...structuredClone(input) };
    const existing = this.#reachability.get(id);
    if (existing !== undefined) return structuredClone(existing);
    this.#reachability.set(id, record);
    return structuredClone(record);
  }
}

function compareReachabilityEvidence(
  left: ReachabilityEvidence,
  right: ReachabilityEvidence,
): number {
  return (
    reachabilityRank(right.level) - reachabilityRank(left.level) ||
    right.observedAt - left.observedAt ||
    left.id.localeCompare(right.id)
  );
}

function reachabilityRank(level: ReachabilityLevel): number {
  switch (level) {
    case ReachabilityLevel.RuntimeObserved: return 5;
    case ReachabilityLevel.TestObserved: return 4;
    case ReachabilityLevel.StaticReachable: return 3;
    case ReachabilityLevel.UnknownDynamicBehavior: return 2;
    case ReachabilityLevel.Installed: return 1;
    case ReachabilityLevel.NotPresent: return 0;
  }
}

function snapshotFingerprint(normalized: NormalizedSnapshot): string {
  return canonicalJson({
    snapshot: {
      id: normalized.snapshot.id,
      contentHash: normalized.snapshot.contentHash,
      repositoryId: normalized.snapshot.repositoryId,
      commitSha: normalized.snapshot.commitSha,
      lockfileType: normalized.snapshot.lockfileType,
    },
    packages: normalized.packages.map(({ id, packageId, version }) => ({
      id,
      packageId,
      version,
    })),
    resolutions: normalized.resolutions.map(
      ({ id, packageVersionId, sourceKey, root, direct, dev, optional, peer }) => ({
        id,
        packageVersionId,
        sourceKey,
        root,
        direct,
        dev,
        optional,
        peer,
      }),
    ),
    edges: normalized.edges.map(
      ({ id, fromResolutionId, toResolutionId, kind }) => ({
        id,
        fromResolutionId,
        toResolutionId,
        kind,
      }),
    ),
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isTimestamp(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isUnitScore(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function catalogServiceCanonicalId(
  repositoryId: string,
  serviceId: string,
): StableId {
  return stableIdFromCanonicalKey(canonicalKeys.service(repositoryId, serviceId));
}
