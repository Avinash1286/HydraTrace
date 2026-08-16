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
import { analyzeBlastRadius, type IncidentCatalog } from "@hydratrace/incident-analysis";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const parametersSchema = z.object({ incidentId: z.string().regex(/^\d+$/) });
const questionSchema = z.object({ question: z.string().trim().min(2).max(4_000) }).strict();
const reportSchema = z.object({ format: z.enum(["markdown", "json", "sarif"]).default("markdown") }).strict();

export function registerAiRoutes(
  application: FastifyInstance,
  catalog: IncidentCatalog,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const copilot = new GroundedCopilot(providersFromEnvironment(environment));
  application.post("/v1/incidents/:incidentId/copilot", async (request, reply) => {
    const parameters = parametersSchema.safeParse(request.params); const parsed = questionSchema.safeParse(request.body);
    if (!parameters.success || !parsed.success) return reply.code(400).send({ error: "INVALID_COPILOT_QUERY" });
    const incidentId = parameters.data.incidentId as StableId; const incident = catalog.getIncident(incidentId);
    if (incident === undefined) return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
    const blast = analyzeBlastRadius(catalog, incidentId, { includeDevelopment: true, pathDisplayLimit: 100, limit: 100 });
    const evidenceRefs = [...new Set(blast.findings.flatMap(({ evidenceRefs }) => evidenceRefs))];
    const unknowns = [...new Set(blast.findings.flatMap(({ unknowns }) => unknowns))];
    const result = await copilot.answer({ incidentId, question: parsed.data.question, summary: { packageName: incident.packageName, affectedVersions: incident.affectedVersions, totalAffectedServices: blast.totalAffectedServices, totalPaths: blast.totalPaths, findings: blast.findings }, evidenceRefs, unknowns });
    return result;
  });

  application.post("/v1/incidents/:incidentId/reports", async (request, reply) => {
    const parameters = parametersSchema.safeParse(request.params); const parsed = reportSchema.safeParse(request.body ?? {});
    if (!parameters.success || !parsed.success) return reply.code(400).send({ error: "INVALID_REPORT_QUERY" });
    const incidentId = parameters.data.incidentId as StableId; const incident = catalog.getIncident(incidentId);
    if (incident === undefined) return reply.code(404).send({ error: "INCIDENT_NOT_FOUND" });
    const blast = analyzeBlastRadius(catalog, incidentId, { includeDevelopment: true, pathDisplayLimit: 100, limit: 100 });
    const input: IncidentReportInput = { incidentId, packageName: incident.packageName, affectedVersions: incident.affectedVersions, findings: blast.findings };
    if (parsed.data.format === "json") return { incident, blast };
    if (parsed.data.format === "sarif") return sarifIncidentReport(input);
    return reply.type("text/markdown; charset=utf-8").send(markdownIncidentReport(input));
  });
}

function providersFromEnvironment(environment: NodeJS.ProcessEnv): AiProvider[] {
  const providers: AiProvider[] = [];
  if (environment.AI_GATEWAY_URL && environment.AI_GATEWAY_SHARED_SECRET) providers.push(new AiGatewayProvider(environment.AI_GATEWAY_URL, environment.AI_GATEWAY_SHARED_SECRET));
  if (environment.CLOUDFLARE_ACCOUNT_ID && environment.CLOUDFLARE_AI_TOKEN) providers.push(new CloudflareWorkersAiProvider(environment.CLOUDFLARE_ACCOUNT_ID, environment.CLOUDFLARE_AI_TOKEN, environment.CLOUDFLARE_AI_MODEL ?? "@cf/openai/gpt-oss-120b"));
  if (environment.NVIDIA_API_KEY) providers.push(new NvidiaNimProvider(environment.NVIDIA_API_KEY, environment.NVIDIA_NIM_MODEL ?? "nvidia/nemotron-3-super-120b-a12b", environment.NVIDIA_NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1"));
  return providers;
}
