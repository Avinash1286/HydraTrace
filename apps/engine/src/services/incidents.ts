import type { StableId } from "@hydratrace/domain";
import {
  IncidentCatalog,
  analyzeBlastRadius,
  buildExposureTimeline,
  type BlastRadiusQuery,
} from "@hydratrace/incident-analysis";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const stableIdSchema = z.string().regex(/^\d+$/);

const incidentBodySchema = z
  .object({
    ecosystem: z.literal("npm"),
    packageName: z.string().trim().min(1).max(214),
    affectedVersions: z.array(z.string().trim().min(1).max(128)).min(1).max(100),
    advisoryId: z.string().trim().min(1).max(256).optional(),
    startsAt: z.number().int().nonnegative().optional(),
    endsAt: z.number().int().nonnegative().optional(),
    environments: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
    source: z.enum(["manual", "osv", "both"]).optional(),
    windowSource: z.string().trim().min(1).max(256).optional(),
    windowConfidence: z.number().min(0).max(1).optional(),
    severityScore: z.number().min(0).max(1).optional(),
    trustContextScore: z.number().min(0).max(1).optional(),
  })
  .strict();

const listQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const blastQuerySchema = z.object({
  at: z.coerce.number().int().nonnegative().optional(),
  environments: z.string().trim().optional(),
  includeDevelopment: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  pathDisplayLimit: z.coerce.number().int().min(1).max(100).optional(),
  pathCountLimit: z.coerce.number().int().min(1).max(10_000).optional(),
  maxDepth: z.coerce.number().int().min(0).max(16).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export function registerIncidentRoutes(
  application: FastifyInstance,
  catalog: IncidentCatalog,
): void {
  application.post("/v1/incidents", async (request, reply) => {
    const parsed = incidentBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_INCIDENT",
        issues: parsed.error.issues.map(({ path, message }) => ({ path, message })),
      });
    }
    try {
      const incident = catalog.createIncident({
        ecosystem: parsed.data.ecosystem,
        packageName: parsed.data.packageName,
        affectedVersions: parsed.data.affectedVersions,
        ...(parsed.data.advisoryId === undefined
          ? {}
          : { advisoryId: parsed.data.advisoryId }),
        ...(parsed.data.startsAt === undefined
          ? {}
          : { startsAt: parsed.data.startsAt }),
        ...(parsed.data.endsAt === undefined
          ? {}
          : { endsAt: parsed.data.endsAt }),
        ...(parsed.data.environments === undefined
          ? {}
          : { environments: parsed.data.environments }),
        ...(parsed.data.source === undefined ? {} : { source: parsed.data.source }),
        ...(parsed.data.windowSource === undefined
          ? {}
          : { windowSource: parsed.data.windowSource }),
        ...(parsed.data.windowConfidence === undefined
          ? {}
          : { windowConfidence: parsed.data.windowConfidence }),
        ...(parsed.data.severityScore === undefined
          ? {}
          : { severityScore: parsed.data.severityScore }),
        ...(parsed.data.trustContextScore === undefined
          ? {}
          : { trustContextScore: parsed.data.trustContextScore }),
      });
      return reply.code(201).send({ incident });
    } catch (error) {
      return reply.code(400).send({
        error: "INCIDENT_CREATION_FAILED",
        message: error instanceof Error ? error.message : "Unknown incident error",
      });
    }
  });

  application.get("/v1/incidents", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_PAGINATION" });
    const incidents = catalog.listIncidents();
    return {
      total: incidents.length,
      offset: parsed.data.offset,
      limit: parsed.data.limit,
      incidents: incidents.slice(
        parsed.data.offset,
        parsed.data.offset + parsed.data.limit,
      ),
    };
  });

  application.get("/v1/incidents/:incidentId", async (request, reply) => {
    const incidentId = parseIncidentId(request.params);
    if (incidentId === undefined) {
      return reply.code(400).send({ error: "INVALID_INCIDENT_ID" });
    }
    const incident = catalog.getIncident(incidentId);
    return incident === undefined
      ? reply.code(404).send({ error: "INCIDENT_NOT_FOUND" })
      : { incident };
  });

  application.get(
    "/v1/incidents/:incidentId/blast-radius",
    async (request, reply) => {
      const incidentId = parseIncidentId(request.params);
      const query = parseBlastQuery(request.query);
      if (incidentId === undefined || query === undefined) {
        return reply.code(400).send({ error: "INVALID_BLAST_RADIUS_QUERY" });
      }
      if (catalog.getIncident(incidentId) === undefined) {
        return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
      }
      try {
        return analyzeBlastRadius(catalog, incidentId, query);
      } catch (error) {
        return reply.code(400).send({
          error: "BLAST_RADIUS_FAILED",
          message: error instanceof Error ? error.message : "Unknown analysis error",
        });
      }
    },
  );

  application.get(
    "/v1/incidents/:incidentId/timeline",
    async (request, reply) => {
      const incidentId = parseIncidentId(request.params);
      if (incidentId === undefined) {
        return reply.code(400).send({ error: "INVALID_INCIDENT_ID" });
      }
      if (catalog.getIncident(incidentId) === undefined) {
        return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
      }
      return buildExposureTimeline(catalog, incidentId);
    },
  );

  application.get("/v1/incidents/:incidentId/paths", async (request, reply) => {
    const incidentId = parseIncidentId(request.params);
    const query = parseBlastQuery(request.query);
    if (incidentId === undefined || query === undefined) {
      return reply.code(400).send({ error: "INVALID_PATH_QUERY" });
    }
    if (catalog.getIncident(incidentId) === undefined) {
      return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
    }
    const result = analyzeBlastRadius(catalog, incidentId, query);
    return {
      incidentId,
      totalPaths: result.totalPaths,
      pathsTruncated: result.pathsTruncated,
      findings: result.findings.map((finding) => ({
        findingId: finding.findingId,
        serviceId: finding.serviceId,
        deploymentId: finding.deploymentId,
        pathCount: finding.pathCount,
        displayedPaths: finding.displayedPaths,
        pathsTruncated: finding.pathsTruncated,
      })),
    };
  });

  application.get(
    "/v1/incidents/:incidentId/findings/:findingId",
    async (request, reply) => {
      const parameters = z
        .object({ incidentId: stableIdSchema, findingId: stableIdSchema })
        .safeParse(request.params);
      if (!parameters.success) {
        return reply.code(400).send({ error: "INVALID_FINDING_ID" });
      }
      const incidentId = parameters.data.incidentId as StableId;
      if (catalog.getIncident(incidentId) === undefined) {
        return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
      }
      const result = analyzeBlastRadius(catalog, incidentId, {
        includeDevelopment: true,
        pathDisplayLimit: 100,
        limit: 100,
      });
      const finding = result.findings.find(
        ({ findingId }) => findingId === parameters.data.findingId,
      );
      return finding === undefined
        ? reply.code(404).send({ error: "FINDING_NOT_FOUND" })
        : { finding };
    },
  );
}

function parseIncidentId(parameters: unknown): StableId | undefined {
  const parsed = z.object({ incidentId: stableIdSchema }).safeParse(parameters);
  return parsed.success ? (parsed.data.incidentId as StableId) : undefined;
}

function parseBlastQuery(value: unknown): BlastRadiusQuery | undefined {
  const parsed = blastQuerySchema.safeParse(value);
  if (!parsed.success) return undefined;
  const environments = parsed.data.environments
    ?.split(",")
    .map((environment) => environment.trim())
    .filter((environment) => environment.length > 0);
  return {
    ...(parsed.data.at === undefined ? {} : { at: parsed.data.at }),
    ...(environments === undefined ? {} : { environments }),
    ...(parsed.data.includeDevelopment === undefined
      ? {}
      : { includeDevelopment: parsed.data.includeDevelopment }),
    ...(parsed.data.pathDisplayLimit === undefined
      ? {}
      : { pathDisplayLimit: parsed.data.pathDisplayLimit }),
    ...(parsed.data.pathCountLimit === undefined
      ? {}
      : { pathCountLimit: parsed.data.pathCountLimit }),
    ...(parsed.data.maxDepth === undefined
      ? {}
      : { maxDepth: parsed.data.maxDepth }),
    ...(parsed.data.offset === undefined ? {} : { offset: parsed.data.offset }),
    ...(parsed.data.limit === undefined ? {} : { limit: parsed.data.limit }),
  };
}
