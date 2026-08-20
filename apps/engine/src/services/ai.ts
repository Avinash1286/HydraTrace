import {
  CloudflareWorkersAiProvider,
  AiGatewayProvider,
  GroundedCopilot,
  NvidiaNimProvider,
  markdownIncidentReport,
  sarifIncidentReport,
  type AiProvider,
  type IncidentReportInput,
} from "@hydratrace/ai-contracts";
import type { StableId } from "@hydratrace/domain";
import type { GraphStore } from "@hydratrace/hydradb-client";
import type {
  BlastRadiusResult,
  IncidentCatalog,
  IncidentRecord,
} from "@hydratrace/incident-analysis";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  analyzeBlastRadiusFromGraphStore,
  ensureIncidentCatalogHydrated,
} from "./graph-catalog.js";

const parametersSchema = z.object({ incidentId: z.string().regex(/^\d+$/) });
const questionSchema = z.object({ question: z.string().trim().min(2).max(4_000) }).strict();
const reportSchema = z.object({ format: z.enum(["markdown", "json", "sarif"]).default("markdown") }).strict();
const completeEvidenceQuery = {
  includeDevelopment: false,
  pathDisplayLimit: 100,
  pathCountLimit: 10_000,
  maxDepth: 16,
  offset: 0,
  limit: 100,
} as const;

type IncidentEvidence =
  | { state: "not-found" }
  | {
      state: "truncated";
      blast: BlastRadiusResult;
      findingsTruncated: boolean;
    }
  | {
      state: "complete";
      incident: IncidentRecord;
      blast: BlastRadiusResult;
    };

export function registerAiRoutes(
  application: FastifyInstance,
  catalog: IncidentCatalog,
  graphStore: GraphStore,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const copilot = new GroundedCopilot(providersFromEnvironment(environment));
  application.post("/v1/incidents/:incidentId/copilot", async (request, reply) => {
    const parameters = parametersSchema.safeParse(request.params); const parsed = questionSchema.safeParse(request.body);
    if (!parameters.success || !parsed.success) return reply.code(400).send({ error: "INVALID_COPILOT_QUERY" });
    const incidentId = parameters.data.incidentId as StableId;
    let evidence: IncidentEvidence;
    try {
      evidence = await loadCompleteIncidentEvidence(graphStore, catalog, incidentId);
    } catch (error) {
      return reply.code(400).send({
        error: "INCIDENT_EVIDENCE_FAILED",
        message: error instanceof Error ? error.message : "Incident evidence could not be loaded",
      });
    }
    if (evidence.state === "not-found") return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
    if (evidence.state === "truncated") return truncatedEvidence(reply, evidence, "copilot");
    const { incident, blast } = evidence;
    const evidenceRefs = [...new Set(blast.findings.flatMap(({ evidenceRefs }) => evidenceRefs))];
    const unknowns = [...new Set(blast.findings.flatMap(({ unknowns }) => unknowns))];
    const result = await copilot.answer({ incidentId, question: parsed.data.question, summary: { packageName: incident.packageName, affectedVersions: incident.affectedVersions, totalAffectedServices: blast.totalAffectedServices, totalPaths: blast.totalPaths, findings: blast.findings }, evidenceRefs, unknowns });
    return result;
  });

  application.post("/v1/incidents/:incidentId/reports", async (request, reply) => {
    const parameters = parametersSchema.safeParse(request.params); const parsed = reportSchema.safeParse(request.body ?? {});
    if (!parameters.success || !parsed.success) return reply.code(400).send({ error: "INVALID_REPORT_QUERY" });
    const incidentId = parameters.data.incidentId as StableId;
    let evidence: IncidentEvidence;
    try {
      evidence = await loadCompleteIncidentEvidence(graphStore, catalog, incidentId);
    } catch (error) {
      return reply.code(400).send({
        error: "INCIDENT_EVIDENCE_FAILED",
        message: error instanceof Error ? error.message : "Incident evidence could not be loaded",
      });
    }
    if (evidence.state === "not-found") return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
    if (evidence.state === "truncated") return truncatedEvidence(reply, evidence, "report");
    const { incident, blast } = evidence;
    const input: IncidentReportInput = {
      incidentId,
      packageName: incident.packageName,
      affectedVersions: incident.affectedVersions,
      findings: blast.findings,
      generatedAt: blast.generatedAt,
    };
    if (parsed.data.format === "json") return { incident, blast };
    if (parsed.data.format === "sarif") return sarifIncidentReport(input);
    return reply.type("text/markdown; charset=utf-8").send(markdownIncidentReport(input));
  });
}

async function loadCompleteIncidentEvidence(
  graphStore: GraphStore,
  catalog: IncidentCatalog,
  incidentId: StableId,
): Promise<IncidentEvidence> {
  const incident = await ensureIncidentCatalogHydrated(graphStore, catalog, incidentId);
  if (incident === undefined) return { state: "not-found" };
  // Report generation must be reproducible for the same durable incident. The
  // persisted creation time is a deterministic input, unlike request wall time.
  const blast = await analyzeBlastRadiusFromGraphStore(
    graphStore,
    catalog,
    incidentId,
    completeEvidenceQuery,
    incident.createdAt,
  );
  const findingsTruncated = blast.offset !== 0 || blast.findings.length !== blast.totalFindings;
  return blast.pathsTruncated || findingsTruncated
    ? { state: "truncated", blast, findingsTruncated }
    : { state: "complete", incident, blast };
}

function truncatedEvidence(
  reply: FastifyReply,
  evidence: Extract<IncidentEvidence, { state: "truncated" }>,
  consumer: "copilot" | "report",
) {
  return reply.code(409).send({
    error: "INCIDENT_EVIDENCE_TRUNCATED",
    message: `The ${consumer} requires the complete incident evidence set. Narrow the incident before retrying.`,
    totalFindings: evidence.blast.totalFindings,
    returnedFindings: evidence.blast.findings.length,
    findingsTruncated: evidence.findingsTruncated,
    pathsTruncated: evidence.blast.pathsTruncated,
    totalPaths: evidence.blast.totalPaths,
  });
}

function providersFromEnvironment(environment: NodeJS.ProcessEnv): AiProvider[] {
  const providers: AiProvider[] = [];
  if (environment.AI_GATEWAY_URL && environment.AI_GATEWAY_SHARED_SECRET) providers.push(new AiGatewayProvider(environment.AI_GATEWAY_URL, environment.AI_GATEWAY_SHARED_SECRET));
  if (environment.CLOUDFLARE_ACCOUNT_ID && environment.CLOUDFLARE_AI_TOKEN) providers.push(new CloudflareWorkersAiProvider(environment.CLOUDFLARE_ACCOUNT_ID, environment.CLOUDFLARE_AI_TOKEN, environment.CLOUDFLARE_AI_MODEL ?? "@cf/openai/gpt-oss-120b"));
  if (environment.NVIDIA_API_KEY) providers.push(new NvidiaNimProvider(environment.NVIDIA_API_KEY, environment.NVIDIA_NIM_MODEL ?? "nvidia/nemotron-3-super-120b-a12b", environment.NVIDIA_NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1"));
  return providers;
}
