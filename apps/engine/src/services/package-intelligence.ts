import type {
  PackageIntelligenceCatalog,
  PackageMetadataInput,
} from "@hydratrace/package-intelligence";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

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

export function registerPackageIntelligenceRoutes(
  application: FastifyInstance,
  catalog: PackageIntelligenceCatalog,
): void {
  application.post("/v1/package-metadata", async (request, reply) => {
    const parsed = z.array(metadataSchema).min(1).max(5_000).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_PACKAGE_METADATA" });
    try {
      return reply.code(201).send({
        packages: parsed.data.map((metadata) => catalog.register(compactMetadata(metadata))),
      });
    } catch (error) {
      return reply.code(400).send({
        error: "PACKAGE_METADATA_FAILED",
        message: error instanceof Error ? error.message : "Unknown metadata error",
      });
    }
  });

  application.get(
    "/v1/packages/:packageName/:version/neighborhood",
    async (request, reply) => {
      const parsed = packageParameters.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: "INVALID_PACKAGE_QUERY" });
      try {
        return catalog.neighborhood(parsed.data.packageName, parsed.data.version);
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
      if (!parsed.success) return reply.code(400).send({ error: "INVALID_PACKAGE_QUERY" });
      const metadata = catalog.get(parsed.data.packageName, parsed.data.version);
      return metadata === undefined
        ? reply.code(404).send({ error: "PACKAGE_METADATA_NOT_FOUND" })
        : { packageId: metadata.id, maintainers: metadata.maintainers };
    },
  );
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
