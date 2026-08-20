import type {
  PackageIntelligenceCatalog,
  PackageMetadataInput,
} from "@hydratrace/package-intelligence";
import { canonicalKeys, stableIdFromCanonicalKey, type StableId } from "@hydratrace/domain";
import type { GraphStore } from "@hydratrace/hydradb-client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hydratePackageIntelligence, persistPackageIntelligence } from "./package-metadata-graph.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  MAX_PAGE_OFFSET,
  paginate,
  type PageMetadata,
} from "./pagination.js";

const metadataSchema = z.object({
  name: z.string().trim().min(1).max(214),
  version: z.string().trim().min(1).max(128),
  maintainers: z.array(z.object({
    name: z.string().trim().min(1).max(256).optional(),
    email: z.string().trim().email().max(320).optional(),
    source: z.string().trim().min(1).max(128).optional(),
  })).max(1_000).optional(),
  repositoryUrl: z.string().trim().max(2_048).optional(),
  tarballUrl: z.string().trim().max(2_048).optional(),
  homepage: z.string().trim().max(2_048).optional(),
  provenanceIdentity: z.string().trim().max(1_024).optional(),
  publishedAt: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative().optional(),
  weeklyDownloads: z.number().int().nonnegative().optional(),
}).strict();

const packageParameters = z.object({
  packageName: z.string().trim().min(1),
  version: z.string().trim().min(1),
});
const packageIdParameters = z.object({ packageId: z.string().regex(/^\d+$/u) });
const packageQuery = z.object({
  version: z.string().trim().min(1).max(128).optional(),
  offset: z.coerce.number().int().min(0).max(MAX_PAGE_OFFSET).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});
const paginationQuery = packageQuery.omit({ version: true });

export function registerPackageIntelligenceRoutes(
  application: FastifyInstance,
  catalog: PackageIntelligenceCatalog,
  graphStore: GraphStore,
): void {
  application.post("/v1/package-metadata", async (request, reply) => {
    const parsed = z.array(metadataSchema).min(1).max(250).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_PACKAGE_METADATA" });
    try {
      const packages = parsed.data.map((metadata) => catalog.register(compactMetadata(metadata)));
      await persistPackageIntelligence(graphStore, catalog);
      return reply.code(201).send({ packages });
    } catch (error) {
      return reply.code(400).send({
        error: "PACKAGE_METADATA_FAILED",
        message: error instanceof Error ? error.message : "Unknown metadata error",
      });
    }
  });

  application.get("/v1/packages/:packageId", async (request, reply) => {
    const parameters = packageIdParameters.safeParse(request.params);
    const query = packageQuery.safeParse(request.query);
    if (!parameters.success || !query.success) return reply.code(400).send({ error: "INVALID_PACKAGE_ID" });
    await hydratePackageIntelligence(graphStore, catalog);
    const versions = versionsForPackage(catalog, parameters.data.packageId as StableId);
    const paginated = paginate(versions, query.data.offset, query.data.limit);
    return versions.length === 0
      ? reply.code(404).send({ error: "PACKAGE_METADATA_NOT_FOUND" })
      : {
          packageId: parameters.data.packageId,
          total: versions.length,
          offset: query.data.offset,
          limit: query.data.limit,
          versions: paginated.items,
          page: paginated.page,
        };
  });

  application.get("/v1/packages/:packageId/neighborhood", async (request, reply) => {
    const selected = await packageByIdRequest(request.params, request.query, catalog, graphStore);
    if (selected.error !== undefined) return reply.code(selected.status).send({ error: selected.error });
    return paginatedNeighborhood(
      catalog.neighborhood(selected.package.name, selected.package.version),
      selected.offset,
      selected.limit,
    );
  });

  application.get("/v1/packages/:packageId/maintainers", async (request, reply) => {
    const selected = await packageByIdRequest(request.params, request.query, catalog, graphStore);
    if (selected.error !== undefined) return reply.code(selected.status).send({ error: selected.error });
    return paginatedMaintainers(
      selected.package.id,
      selected.package.maintainers,
      selected.offset,
      selected.limit,
    );
  });

  application.get("/v1/packages/:packageId/similar-names", async (request, reply) => {
    const selected = await packageByIdRequest(request.params, request.query, catalog, graphStore);
    if (selected.error !== undefined) return reply.code(selected.status).send({ error: selected.error });
    const neighborhood = catalog.neighborhood(selected.package.name, selected.package.version);
    const similar = neighborhood.relations.filter(({ type }) => type === "SIMILAR_NAME");
    const paginated = paginate(similar, selected.offset, selected.limit);
    return {
      packageId: selected.package.id,
      relations: paginated.items,
      totalRelations: similar.length,
      relationsTruncated: paginated.page.truncated,
      page: paginated.page,
    };
  });

  application.get(
    "/v1/packages/:packageName/:version/neighborhood",
    async (request, reply) => {
      const parsed = packageParameters.safeParse(request.params);
      const query = paginationQuery.safeParse(request.query);
      if (!parsed.success || !query.success) return reply.code(400).send({ error: "INVALID_PACKAGE_QUERY" });
      try {
        await hydratePackageIntelligence(graphStore, catalog);
        return paginatedNeighborhood(
          catalog.neighborhood(parsed.data.packageName, parsed.data.version),
          query.data.offset,
          query.data.limit,
        );
      } catch (error) {
        return reply.code(404).send({
          error: "PACKAGE_METADATA_NOT_FOUND",
          message: error instanceof Error ? error.message : "Package metadata was not found",
        });
      }
    },
  );

  application.get(
    "/v1/packages/:packageName/:version/maintainers",
    async (request, reply) => {
      const parsed = packageParameters.safeParse(request.params);
      const query = paginationQuery.safeParse(request.query);
      if (!parsed.success || !query.success) return reply.code(400).send({ error: "INVALID_PACKAGE_QUERY" });
      await hydratePackageIntelligence(graphStore, catalog);
      const metadata = catalog.get(parsed.data.packageName, parsed.data.version);
      return metadata === undefined
        ? reply.code(404).send({ error: "PACKAGE_METADATA_NOT_FOUND" })
        : paginatedMaintainers(
            metadata.id,
            metadata.maintainers,
            query.data.offset,
            query.data.limit,
          );
    },
  );
}

function versionsForPackage(catalog: PackageIntelligenceCatalog, packageId: StableId) {
  return catalog.all().filter((record) =>
    stableIdFromCanonicalKey(canonicalKeys.package("npm", record.name)) === packageId);
}

async function packageByIdRequest(
  parametersInput: unknown,
  queryInput: unknown,
  catalog: PackageIntelligenceCatalog,
  graphStore: GraphStore,
): Promise<
  | {
      package: ReturnType<PackageIntelligenceCatalog["all"]>[number];
      offset: number;
      limit: number;
      error?: never;
      status?: never;
    }
  | { error: string; status: 400 | 404; package?: never }
> {
  const parameters = packageIdParameters.safeParse(parametersInput);
  const query = packageQuery.safeParse(queryInput);
  if (!parameters.success || !query.success) return { error: "INVALID_PACKAGE_QUERY", status: 400 };
  await hydratePackageIntelligence(graphStore, catalog);
  const versions = versionsForPackage(catalog, parameters.data.packageId as StableId);
  const selected = query.data.version === undefined
    ? versions.toSorted((left, right) => right.version.localeCompare(left.version))[0]
    : versions.find(({ version }) => version === query.data.version);
  return selected === undefined
    ? { error: "PACKAGE_METADATA_NOT_FOUND", status: 404 }
    : { package: selected, offset: query.data.offset, limit: query.data.limit };
}

function paginatedNeighborhood(
  neighborhood: ReturnType<PackageIntelligenceCatalog["neighborhood"]>,
  offset: number,
  limit: number,
) {
  const relations = paginate(neighborhood.relations, offset, limit);
  return {
    ...neighborhood,
    relations: relations.items,
    totalRelations: neighborhood.relations.length,
    relationsTruncated: relations.page.truncated,
    page: relations.page,
  };
}

function paginatedMaintainers<T>(
  packageId: StableId,
  maintainers: readonly T[],
  offset: number,
  limit: number,
): {
  packageId: StableId;
  maintainers: readonly T[];
  totalMaintainers: number;
  maintainersTruncated: boolean;
  page: PageMetadata;
} {
  const paginated = paginate(maintainers, offset, limit);
  return {
    packageId,
    maintainers: paginated.items,
    totalMaintainers: maintainers.length,
    maintainersTruncated: paginated.page.truncated,
    page: paginated.page,
  };
}

function compactMetadata(
  metadata: z.infer<typeof metadataSchema>,
): PackageMetadataInput {
  return {
    name: metadata.name,
    version: metadata.version,
    ...(metadata.maintainers === undefined
      ? {}
      : {
          maintainers: metadata.maintainers.map((maintainer) => ({
            ...(maintainer.name === undefined ? {} : { name: maintainer.name }),
            ...(maintainer.email === undefined ? {} : { email: maintainer.email }),
            ...(maintainer.source === undefined ? {} : { source: maintainer.source }),
          })),
        }),
    ...(metadata.repositoryUrl === undefined ? {} : { repositoryUrl: metadata.repositoryUrl }),
    ...(metadata.tarballUrl === undefined ? {} : { tarballUrl: metadata.tarballUrl }),
    ...(metadata.homepage === undefined ? {} : { homepage: metadata.homepage }),
    ...(metadata.provenanceIdentity === undefined
      ? {}
      : { provenanceIdentity: metadata.provenanceIdentity }),
    ...(metadata.publishedAt === undefined ? {} : { publishedAt: metadata.publishedAt }),
    ...(metadata.createdAt === undefined ? {} : { createdAt: metadata.createdAt }),
    ...(metadata.weeklyDownloads === undefined
      ? {}
      : { weeklyDownloads: metadata.weeklyDownloads }),
  };
}
