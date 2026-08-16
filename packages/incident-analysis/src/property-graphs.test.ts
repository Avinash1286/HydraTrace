import { stableIdFromCanonicalKey, type DeploymentManifest, type FactProvenance, type NormalizedSnapshot, type StableId } from "@hydratrace/domain";
import { describe, expect, it } from "vitest";
import { analyzeBlastRadius } from "./blast-radius.js";
import { IncidentCatalog } from "./catalog.js";

describe("fixed-seed graph properties", () => {
  it("matches an independent simple-path enumerator across random DAGs", () => {
    const random = mulberry32(0x48594452);
    for (let example = 0; example < 30; example += 1) {
      const size = 6 + Math.floor(random() * 12);
      const adjacency = Array.from({ length: size }, () => [] as number[]);
      for (let from = 0; from < size - 1; from += 1) {
        adjacency[from]!.push(from + 1);
        for (let to = from + 2; to < size; to += 1) if (random() < 0.16) adjacency[from]!.push(to);
      }
      const expected = referencePathCount(adjacency, size - 1);
      const { normalized, deployment } = syntheticSnapshot(example, adjacency);
      const catalog = new IncidentCatalog(); catalog.registerSnapshot(normalized, deployment);
      const incident = catalog.createIncident({ ecosystem: "npm", packageName: "affected", affectedVersions: ["1.0.0"], startsAt: 0 }, 1);
      const result = analyzeBlastRadius(catalog, incident.id, { pathDisplayLimit: 100, pathCountLimit: 10_000 }, 2);
      expect(result.totalPaths, `example ${example}`).toBe(expected);
      const unique = new Set(result.findings[0]?.displayedPaths.map(({ resolutionIds }) => resolutionIds.join("/")) ?? []);
      expect(unique.size).toBe(expected);
    }
  });
});

function syntheticSnapshot(example: number, adjacency: readonly number[][]): { normalized: NormalizedSnapshot; deployment: DeploymentManifest } {
  const snapshotId = id(`property-snapshot:${example}`); const observedAt = 10; const provenance: FactProvenance = { sourceType: "package-lock", sourceRef: "package-lock.json", sourceSha256: "a".repeat(64), repositoryId: `property/repo-${example}`, commitSha: `commit-${example}`, importRunId: id(`run:${example}`), observedAt, parserVersion: "property", confidence: 1 };
  const versions = adjacency.map((_, index) => ({ id: id(`version:${example}:${index}`), packageId: id(`package:${example}:${index}`), name: index === adjacency.length - 1 ? "affected" : `package-${index}`, normalizedName: index === adjacency.length - 1 ? "affected" : `package-${index}`, ecosystem: "npm" as const, version: "1.0.0", provenance }));
  const resolutions = versions.map((version, index) => ({ id: id(`resolution:${example}:${index}`), snapshotId, packageVersionId: version.id, packageName: version.name, version: version.version, sourceKey: index === 0 ? "" : `node_modules/${version.name}`, installPath: index === 0 ? "." : `node_modules/${version.name}`, root: index === 0, direct: index === 1, dev: false, optional: false, peer: false, provenance }));
  const edges = adjacency.flatMap((targets, from) => targets.map((to) => ({ id: id(`edge:${example}:${from}:${to}`), snapshotId, fromResolutionId: resolutions[from]!.id, toResolutionId: resolutions[to]!.id, dependencyName: resolutions[to]!.packageName, kind: "production" as const, provenance })));
  const normalized: NormalizedSnapshot = { snapshot: { id: snapshotId, ecosystem: "npm", lockfileType: "package-lock", contentHash: "a".repeat(64), repositoryId: `property/repo-${example}`, commitSha: `commit-${example}`, sourceRef: "package-lock.json", parserVersion: "property", createdAt: observedAt }, packages: versions, resolutions, edges, warnings: [] };
  const deployment: DeploymentManifest = { schemaVersion: 1, organizationId: "property", repositoryId: normalized.snapshot.repositoryId, serviceId: `service-${example}`, deploymentId: id(`deployment:${example}`), environment: "production", criticality: "production", commitSha: normalized.snapshot.commitSha, lockfile: "package-lock.json", lockfileSha256: normalized.snapshot.contentHash, startedAt: observedAt, endedAt: null };
  return { normalized, deployment };
}
function referencePathCount(adjacency: readonly number[][], target: number): number { let count = 0; const pending: number[][] = [[0]]; while (pending.length > 0) { const path = pending.pop()!; const current = path.at(-1)!; if (current === target) count += 1; for (const next of adjacency[current] ?? []) if (!path.includes(next)) pending.push([...path, next]); } return count; }
function mulberry32(seed: number): () => number { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let value = Math.imul(seed ^ seed >>> 15, 1 | seed); value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value; return ((value ^ value >>> 14) >>> 0) / 4294967296; }; }
function id(value: string): StableId { return stableIdFromCanonicalKey(value); }
