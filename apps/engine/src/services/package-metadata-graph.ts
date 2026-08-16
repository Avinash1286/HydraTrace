import {
  canonicalKeys,
  sha256Hex,
  stableIdFromCanonicalKey,
  type FactProvenance,
  type StableId,
} from "@hydratrace/domain";
import {
  graphRelationshipId,
  provenanceProperties,
  type GraphNodeRecord,
  type GraphRelationshipRecord,
} from "@hydratrace/graph-schema";
import type { GraphStore } from "@hydratrace/hydradb-client";
import type { PackageIntelligenceCatalog, PackageMetadata } from "@hydratrace/package-intelligence";

export async function persistPackageIntelligence(
  store: GraphStore,
  catalog: PackageIntelligenceCatalog,
): Promise<void> {
  const metadata = catalog.all();
  const nodes = new Map<StableId, GraphNodeRecord>();
  const relationships = new Map<StableId, GraphRelationshipRecord>();
  for (const record of metadata) addMetadata(record, nodes, relationships);
  for (const source of metadata) {
    for (const relation of catalog.neighborhood(source.name, source.version, 0.55).relations) {
      const sourcePackageId = stableIdFromCanonicalKey(canonicalKeys.package("npm", source.name));
      const targetPackageId = stableIdFromCanonicalKey(canonicalKeys.package("npm", relation.target.name));
      const edge: GraphRelationshipRecord<"SIMILAR_NAME_TO"> = {
        id: graphRelationshipId({
          type: "SIMILAR_NAME_TO",
          from: sourcePackageId,
          to: targetPackageId,
          discriminator: `${source.version}:${relation.target.version}`,
        }),
        type: "SIMILAR_NAME_TO",
        from: { id: sourcePackageId, label: "Package" },
        to: { id: targetPackageId, label: "Package" },
        properties: { score: relation.score, reason: relation.reasons.join("; ") },
      };
      relationships.set(edge.id, edge);
    }
  }
  await store.write({ nodes: [...nodes.values()], relationships: [...relationships.values()] });
}

export async function hydratePackageIntelligence(
  store: GraphStore,
  catalog: PackageIntelligenceCatalog,
): Promise<void> {
  const versions = (await store.matchNodes({ label: "PackageVersion", limit: 10_000 }))
    .filter((node): node is GraphNodeRecord<"PackageVersion"> => node.label === "PackageVersion");
  const publishedBy = await store.matchRelationships({ type: "PUBLISHED_BY", limit: 10_000 });
  const usesInfrastructure = await store.matchRelationships({ type: "USES_INFRASTRUCTURE", limit: 10_000 });
  const endpointIds = [...new Set([
    ...publishedBy.map(({ to }) => to.id),
    ...usesInfrastructure.map(({ to }) => to.id),
  ])];
  const endpointNodes = new Map((await store.getNodes(endpointIds)).map((node) => [node.id, node]));
  for (const version of versions) {
    if (catalog.get(version.properties.name, version.properties.version) !== undefined) continue;
    const maintainers = publishedBy
      .filter(({ from }) => from.id === version.id)
      .flatMap(({ to }) => {
        const node = endpointNodes.get(to.id);
        if (node?.label !== "Maintainer") return [];
        return [{
          name: node.properties.username,
          ...(node.properties.emailDomain === undefined ? {} : { email: `unknown@${node.properties.emailDomain}` }),
          source: "hydratrace-graph",
        }];
      });
    const infrastructure = usesInfrastructure
      .filter(({ from }) => from.id === version.id)
      .flatMap(({ to }) => {
        const node = endpointNodes.get(to.id);
        return node?.label === "Infrastructure" ? [node.properties] : [];
      });
    const repository = infrastructure.find(({ type }) => type === "repository")?.value;
    const tarballHost = infrastructure.find(({ type }) => type === "tarball-host")?.value;
    const homepageDomain = infrastructure.find(({ type }) => type === "homepage-domain")?.value;
    const provenanceIdentity = infrastructure.find(({ type }) => type === "provenance-identity")?.value;
    catalog.register({
      name: version.properties.name,
      version: version.properties.version,
      maintainers,
      ...(repository === undefined ? {} : { repositoryUrl: repository }),
      ...(tarballHost === undefined ? {} : { tarballUrl: `https://${tarballHost}/` }),
      ...(homepageDomain === undefined ? {} : { homepage: `https://${homepageDomain}/` }),
      ...(provenanceIdentity === undefined ? {} : { provenanceIdentity }),
    });
  }
}

function addMetadata(
  record: PackageMetadata,
  nodes: Map<StableId, GraphNodeRecord>,
  relationships: Map<StableId, GraphRelationshipRecord>,
): void {
  const packageId = stableIdFromCanonicalKey(canonicalKeys.package("npm", record.name));
  const versionId = stableIdFromCanonicalKey(canonicalKeys.packageVersion("npm", record.name, record.version));
  nodes.set(packageId, {
    id: packageId,
    label: "Package",
    properties: { ecosystem: "npm", name: record.name, normalizedName: record.normalizedName },
  });
  nodes.set(versionId, {
    id: versionId,
    label: "PackageVersion",
    properties: {
      packageId,
      ecosystem: "npm",
      name: record.name,
      normalizedName: record.normalizedName,
      version: record.version,
    },
  });
  const provenance = manualProvenance(record);
  const versionOf: GraphRelationshipRecord<"VERSION_OF"> = {
    id: graphRelationshipId({ type: "VERSION_OF", from: versionId, to: packageId }),
    type: "VERSION_OF",
    from: { id: versionId, label: "PackageVersion" },
    to: { id: packageId, label: "Package" },
    properties: provenanceProperties(provenance),
  };
  relationships.set(versionOf.id, versionOf);

  for (const maintainer of record.maintainers) {
    const maintainerId = stableIdFromCanonicalKey(`maintainer:${maintainer.identity}`);
    const emailDomain = maintainer.email?.split("@")[1];
    nodes.set(maintainerId, {
      id: maintainerId,
      label: "Maintainer",
      properties: {
        username: maintainer.name ?? maintainer.identity,
        ...(maintainer.email === undefined ? {} : { emailHash: sha256Hex(maintainer.email) }),
        ...(emailDomain === undefined ? {} : { emailDomain }),
      },
    });
    const edge = emptyRelationship("PUBLISHED_BY", versionId, "PackageVersion", maintainerId, "Maintainer");
    relationships.set(edge.id, edge);
    if (emailDomain !== undefined) addInfrastructure(versionId, "maintainer-email-domain", emailDomain, nodes, relationships);
  }
  if (record.repositoryUrl !== undefined) addInfrastructure(versionId, "repository", normalizeUrl(record.repositoryUrl), nodes, relationships);
  if (record.tarballUrl !== undefined) addInfrastructure(versionId, "tarball-host", host(record.tarballUrl), nodes, relationships);
  if (record.homepage !== undefined) addInfrastructure(versionId, "homepage-domain", host(record.homepage), nodes, relationships);
  if (record.provenanceIdentity !== undefined) addInfrastructure(versionId, "provenance-identity", record.provenanceIdentity, nodes, relationships);
}

function addInfrastructure(
  versionId: StableId,
  type: string,
  value: string,
  nodes: Map<StableId, GraphNodeRecord>,
  relationships: Map<StableId, GraphRelationshipRecord>,
): void {
  if (value.length === 0) return;
  const id = stableIdFromCanonicalKey(`infrastructure:${type}:${value.toLowerCase()}`);
  nodes.set(id, { id, label: "Infrastructure", properties: { type, value } });
  const edge = emptyRelationship("USES_INFRASTRUCTURE", versionId, "PackageVersion", id, "Infrastructure");
  relationships.set(edge.id, edge);
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

function manualProvenance(record: PackageMetadata): FactProvenance {
  const source = JSON.stringify(record);
  const sourceSha256 = sha256Hex(source);
  return {
    sourceType: "manual",
    sourceRef: "package-metadata",
    sourceSha256,
    repositoryId: "ecosystem/npm",
    commitSha: "registry-metadata",
    importRunId: stableIdFromCanonicalKey(`package-metadata-import:${sourceSha256}`),
    observedAt: record.publishedAt ?? record.createdAt ?? 0,
    parserVersion: "0.1.0",
    confidence: 1,
  };
}

function host(value: string): string {
  try { return new URL(value).hostname.toLowerCase(); } catch { return value.toLowerCase(); }
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/u, "").toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}
