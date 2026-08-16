import { normalizeNpmPackageName, stableIdFromCanonicalKey, type StableId } from "@hydratrace/domain";

export interface PackageMetadataInput {
  name: string;
  version: string;
  maintainers?: readonly { name?: string; email?: string; source?: string }[];
  repositoryUrl?: string;
  tarballUrl?: string;
  homepage?: string;
  provenanceIdentity?: string;
  publishedAt?: number;
  createdAt?: number;
  weeklyDownloads?: number;
}

export interface PackageMetadata extends PackageMetadataInput {
  id: StableId;
  normalizedName: string;
  maintainers: readonly { identity: string; name?: string; email?: string; source: string }[];
}

export interface NeighborhoodRelation {
  relationId: StableId;
  type: "SHARED_MAINTAINER" | "SHARED_INFRASTRUCTURE" | "SIMILAR_NAME";
  target: PackageMetadata;
  score: number;
  reasons: readonly string[];
  evidenceRefs: readonly string[];
  indicatorOnly: true;
}

export interface PackageNeighborhood {
  package: PackageMetadata;
  relations: readonly NeighborhoodRelation[];
}

export class PackageIntelligenceCatalog {
  readonly #packages = new Map<StableId, PackageMetadata>();

  register(input: PackageMetadataInput): PackageMetadata {
    const normalizedName = normalizeNpmPackageName(input.name);
    if (input.version.trim().length === 0) throw new Error("Package version is required");
    const id = stableIdFromCanonicalKey(`package-metadata:npm:${normalizedName}:${input.version}`);
    const maintainers = (input.maintainers ?? []).map((maintainer) => {
      const email = maintainer.email?.trim().toLowerCase();
      const name = maintainer.name?.trim();
      const identity = email ?? name?.toLowerCase();
      if (identity === undefined || identity.length === 0) throw new Error("Maintainer identity is empty");
      return {
        identity,
        source: maintainer.source?.trim() || "npm-registry",
        ...(name === undefined ? {} : { name }),
        ...(email === undefined ? {} : { email }),
      };
    }).sort((left, right) => left.identity.localeCompare(right.identity));
    const record: PackageMetadata = {
      id,
      name: input.name.trim(),
      normalizedName,
      version: input.version.trim(),
      maintainers,
      ...(input.repositoryUrl === undefined ? {} : { repositoryUrl: input.repositoryUrl }),
      ...(input.tarballUrl === undefined ? {} : { tarballUrl: input.tarballUrl }),
      ...(input.homepage === undefined ? {} : { homepage: input.homepage }),
      ...(input.provenanceIdentity === undefined ? {} : { provenanceIdentity: input.provenanceIdentity }),
      ...(input.publishedAt === undefined ? {} : { publishedAt: input.publishedAt }),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      ...(input.weeklyDownloads === undefined ? {} : { weeklyDownloads: input.weeklyDownloads }),
    };
    const existing = this.#packages.get(id);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(record)) {
      throw new Error(`Conflicting package metadata for ${record.name}@${record.version}`);
    }
    if (existing === undefined) this.#packages.set(id, structuredClone(record));
    return structuredClone(existing ?? record);
  }

  get size(): number { return this.#packages.size; }

  clear(): void { this.#packages.clear(); }

  all(): readonly PackageMetadata[] {
    return [...this.#packages.values()]
      .sort((left, right) => left.normalizedName.localeCompare(right.normalizedName) || left.version.localeCompare(right.version))
      .map((record) => structuredClone(record));
  }

  get(name: string, version: string): PackageMetadata | undefined {
    const id = stableIdFromCanonicalKey(`package-metadata:npm:${normalizeNpmPackageName(name)}:${version}`);
    const record = this.#packages.get(id);
    return record === undefined ? undefined : structuredClone(record);
  }

  neighborhood(name: string, version: string, minimumSimilarity = 0.55): PackageNeighborhood {
    const source = this.get(name, version);
    if (source === undefined) throw new Error(`Package metadata ${name}@${version} was not found`);
    const relations: NeighborhoodRelation[] = [];
    for (const target of this.#packages.values()) {
      if (target.id === source.id) continue;
      const sharedMaintainers = intersection(
        source.maintainers.map(({ identity }) => identity),
        target.maintainers.map(({ identity }) => identity),
      );
      if (sharedMaintainers.length > 0) {
        relations.push(relation(source, target, "SHARED_MAINTAINER", 1, sharedMaintainers.map((identity) => `shared maintainer ${identity}`)));
      }
      const sharedInfrastructure = infrastructure(source).filter((value) => infrastructure(target).includes(value));
      if (sharedInfrastructure.length > 0) {
        relations.push(relation(source, target, "SHARED_INFRASTRUCTURE", Math.min(1, 0.6 + sharedInfrastructure.length * 0.1), sharedInfrastructure.map((value) => `shared infrastructure ${value}`)));
      }
      const similarity = nameSimilarity(source, target);
      if (similarity.score >= minimumSimilarity && source.normalizedName !== target.normalizedName) {
        relations.push(relation(source, target, "SIMILAR_NAME", similarity.score, similarity.reasons));
      }
    }
    return {
      package: source,
      relations: relations.sort((left, right) => right.score - left.score || left.type.localeCompare(right.type) || left.target.normalizedName.localeCompare(right.target.normalizedName)),
    };
  }
}

function relation(source: PackageMetadata, target: PackageMetadata, type: NeighborhoodRelation["type"], score: number, reasons: readonly string[]): NeighborhoodRelation {
  const relationId = stableIdFromCanonicalKey(`neighborhood:${source.id}:${type}:${target.id}`);
  return { relationId, type, target: structuredClone(target), score: round(score), reasons: [...reasons].sort(), evidenceRefs: [`E-NEIGHBOR-${relationId}`], indicatorOnly: true };
}

function nameSimilarity(source: PackageMetadata, target: PackageMetadata): { score: number; reasons: string[] } {
  const left = homoglyphNormalize(source.normalizedName);
  const right = homoglyphNormalize(target.normalizedName);
  const distance = damerauLevenshtein(left, right);
  let score = 1 - distance / Math.max(left.length, right.length, 1);
  const reasons = [`Damerau-Levenshtein distance ${distance}`];
  if (homoglyphNormalize(source.normalizedName) !== source.normalizedName || homoglyphNormalize(target.normalizedName) !== target.normalizedName) {
    score = Math.max(score, 0.8); reasons.push("Unicode homoglyph normalization");
  }
  const leftTokens = tokens(left); const rightTokens = tokens(right);
  if (sameMembers(leftTokens, rightTokens) && leftTokens.join("-") !== rightTokens.join("-")) {
    score = Math.max(score, 0.72); reasons.push("token reordering");
  }
  if (source.normalizedName.startsWith("@") !== target.normalizedName.startsWith("@")) {
    reasons.push("scope confusion"); score = Math.min(1, score + 0.05);
  }
  const sourceDownloads = source.weeklyDownloads ?? 0; const targetDownloads = target.weeklyDownloads ?? 0;
  if (Math.max(sourceDownloads, targetDownloads) >= Math.max(1, Math.min(sourceDownloads, targetDownloads)) * 100) {
    reasons.push("popularity asymmetry"); score = Math.min(1, score + 0.05);
  }
  return { score: round(score), reasons };
}

export function damerauLevenshtein(left: string, right: string): number {
  const rows = left.length + 1; const columns = right.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(columns).fill(0));
  for (let i = 0; i < rows; i += 1) matrix[i]![0] = i;
  for (let j = 0; j < columns; j += 1) matrix[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < columns; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(matrix[i - 1]![j]! + 1, matrix[i]![j - 1]! + 1, matrix[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        matrix[i]![j] = Math.min(matrix[i]![j]!, matrix[i - 2]![j - 2]! + cost);
      }
    }
  }
  return matrix[left.length]![right.length]!;
}

function infrastructure(metadata: PackageMetadata): string[] {
  return [host(metadata.repositoryUrl), host(metadata.tarballUrl), host(metadata.homepage), metadata.provenanceIdentity?.trim().toLowerCase(), ...metadata.maintainers.map(({ email }) => email?.split("@")[1])].filter((value): value is string => value !== undefined && value.length > 0);
}
function host(value?: string): string | undefined { if (value === undefined) return undefined; try { return new URL(value.replace(/^git\+/u, "")).hostname.toLowerCase(); } catch { return undefined; } }
function intersection(left: readonly string[], right: readonly string[]): string[] { const target = new Set(right); return [...new Set(left.filter((value) => target.has(value)))].sort(); }
function tokens(value: string): string[] { return value.replace(/^@/u, "").split(/[\-_/]/u).filter(Boolean); }
function sameMembers(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && [...left].sort().join("\0") === [...right].sort().join("\0"); }
function homoglyphNormalize(value: string): string { return value.normalize("NFKC").replace(/[аɑ]/gu, "a").replace(/[еε]/gu, "e").replace(/[оο]/gu, "o").replace(/[рρ]/gu, "p").replace(/[сϲ]/gu, "c").replace(/[хχ]/gu, "x"); }
function round(value: number): number { return Math.round(value * 100) / 100; }
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`; return JSON.stringify(value); }
