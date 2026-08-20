import { sha256Hex } from "@hydratrace/domain";
import { z } from "zod";

export const copilotResponseSchema = z.object({
  answer: z.string().min(1).max(12_000),
  severity: z.enum(["critical", "high", "medium", "low", "unknown"]),
  evidenceRefs: z.array(z.string()).max(1_000),
  unknowns: z.array(z.string()).max(1_000),
  recommendedActions: z.array(z.string()).max(100),
}).strict();
export type CopilotResponse = z.infer<typeof copilotResponseSchema>;

export interface CopilotEvidence {
  incidentId: string;
  question: string;
  summary: Readonly<Record<string, unknown>>;
  evidenceRefs: readonly string[];
  unknowns: readonly string[];
}

export interface AiProvider {
  name: string;
  generate(prompt: string, signal: AbortSignal): Promise<string>;
}

export interface CopilotResult extends CopilotResponse {
  provider: string;
  grounded: boolean;
  promptVersion: string;
}

export class GroundedCopilot {
  readonly #providers: readonly AiProvider[];
  readonly #cache = new Map<string, CopilotResult>();
  readonly #failures = new Map<string, { count: number; openedAt?: number }>();
  readonly #promptVersion: string;

  constructor(providers: readonly AiProvider[], promptVersion = "copilot-v1") {
    this.#providers = providers;
    this.#promptVersion = promptVersion;
  }

  async answer(evidence: CopilotEvidence): Promise<CopilotResult> {
    const key = sha256Hex(`${this.#promptVersion}\0${canonicalJson(evidence)}`);
    const cached = this.#cache.get(key); if (cached !== undefined) return structuredClone(cached);
    const allowedRefs = new Set(evidence.evidenceRefs);
    const prompt = buildPrompt(evidence, this.#promptVersion);
    for (const provider of this.#providers) {
      if (this.#circuitOpen(provider.name)) continue;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 25_000);
          const raw = await provider.generate(prompt, controller.signal).finally(() => clearTimeout(timer));
          const parsed = copilotResponseSchema.parse(JSON.parse(extractJson(raw)));
          const evidenceRefs = [...new Set(parsed.evidenceRefs.filter((reference) => allowedRefs.has(reference)))];
          if (evidenceRefs.length === 0 && parsed.answer.length > 0) throw new Error("Provider response contained no supported evidence references");
          const result: CopilotResult = { ...parsed, evidenceRefs, provider: provider.name, grounded: true, promptVersion: this.#promptVersion };
          this.#failures.delete(provider.name); this.#cache.set(key, result); return structuredClone(result);
        } catch { this.#recordFailure(provider.name); }
      }
    }
    const fallback = deterministicCopilot(evidence, this.#promptVersion); this.#cache.set(key, fallback); return structuredClone(fallback);
  }

  #circuitOpen(provider: string): boolean { const failure = this.#failures.get(provider); if (failure?.openedAt === undefined) return false; if (Date.now() - failure.openedAt > 60_000) { this.#failures.delete(provider); return false; } return true; }
  #recordFailure(provider: string): void { const previous = this.#failures.get(provider) ?? { count: 0 }; const count = previous.count + 1; this.#failures.set(provider, { count, ...(count >= 3 ? { openedAt: Date.now() } : {}) }); }
}

export function deterministicCopilot(evidence: CopilotEvidence, promptVersion = "copilot-v1"): CopilotResult {
  const findings = findingRecords(evidence.summary.findings);
  const question = evidence.question.trim();
  const namedService = affectedServiceQuestion(question);
  const draft = remediationQuestion(question)
    ? remediationDraft(evidence.summary)
    : runtimeQuestion(question)
      ? runtimeDraft(findings, question)
      : namedService === undefined
        ? priorityQuestion(question)
          ? priorityDraft(findings)
          : summaryDraft(findings, evidence.summary)
        : affectedServiceDraft(findings, namedService, question);
  const allowedRefs = new Set(evidence.evidenceRefs);
  const relevantRefs = uniqueStrings(draft.evidenceRefs).filter((reference) =>
    allowedRefs.has(reference)
  );
  return {
    answer: draft.answer,
    severity: draft.severity,
    evidenceRefs: (relevantRefs.length > 0 ? relevantRefs : uniqueStrings(evidence.evidenceRefs)).slice(0, 20),
    unknowns: uniqueStrings([...evidence.unknowns, ...draft.unknowns]).slice(0, 1_000),
    recommendedActions: [...draft.recommendedActions],
    provider: "deterministic-template",
    grounded: true,
    promptVersion,
  };
}

interface DeterministicDraft {
  answer: string;
  severity: CopilotResponse["severity"];
  evidenceRefs: readonly string[];
  unknowns: readonly string[];
  recommendedActions: readonly string[];
}

function affectedServiceDraft(
  findings: readonly Record<string, unknown>[],
  requestedService: string,
  question: string,
): DeterministicDraft {
  const productionOnly = /\bproduction\b/iu.test(question);
  const matching = findings.filter((finding) =>
    normalizedText(finding.serviceId) === normalizedText(requestedService) &&
    (!productionOnly || normalizedText(finding.environment) === "production")
  );
  const scope = productionOnly ? "production " : "";
  if (matching.length === 0) {
    return {
      answer: `${requestedService} does not appear in the supplied ${scope}findings. The current deterministic evidence therefore does not show it as affected for this query; it does not establish whether that service exists or is safe outside the supplied scope.`,
      severity: "unknown",
      evidenceRefs: [],
      unknowns: [`No ${scope}finding for ${requestedService} is supplied.`],
      recommendedActions: ["Confirm the exact service ID and incident query scope before drawing a broader conclusion."],
    };
  }
  const highest = highestRiskFinding(matching)!;
  const packages = uniqueStrings(matching.map((finding) => packageIdentity(finding)))
    .filter((value) => value !== "")
    .slice(0, 5);
  const reportedPaths = matching.reduce((total, finding) =>
    total + nonnegativeInteger(finding.pathCount), 0);
  return {
    answer: `${stringField(highest, "serviceId", requestedService)} appears in ${matching.length} supplied ${scope}finding${matching.length === 1 ? "" : "s"}${packages.length === 0 ? "" : ` for ${packages.join(", ")}`}${reportedPaths === 0 ? "" : ` across ${reportedPaths} reported dependency path${reportedPaths === 1 ? "" : "s"}`}.`,
    severity: findingSeverity(highest),
    evidenceRefs: matching.flatMap(findingEvidenceRefs),
    unknowns: matching.flatMap(findingUnknowns),
    recommendedActions: ["Inspect the cited deployment and dependency-path evidence for this service."],
  };
}

function runtimeDraft(
  findings: readonly Record<string, unknown>[],
  question: string,
): DeterministicDraft {
  const productionOnly = /\bproduction\b/iu.test(question);
  const relevant = findings.filter((finding) =>
    !productionOnly || normalizedText(finding.environment) === "production"
  );
  const observations = relevant.flatMap((finding) =>
    reachabilityEvidence(finding)
      .filter((item) => item.source === "runtime-trace")
      .map((item) => ({ finding, item }))
  );
  const scope = productionOnly ? "production " : "";
  if (observations.length === 0) {
    return {
      answer: `No ${scope}runtime-trace evidence is supplied for the current findings, so runtime execution is unknown. Static or test-trace evidence must not be treated as ${scope}runtime confirmation.`,
      severity: relevant.length === 0 ? "unknown" : findingSeverity(highestRiskFinding(relevant)),
      evidenceRefs: relevant.flatMap(findingEvidenceRefs),
      unknowns: [`No ${scope}runtime-trace evidence is supplied for the current findings.`],
      recommendedActions: [`Provide a ${scope}runtime trace if runtime loading confirmation is required.`],
    };
  }
  const services = uniqueStrings(observations.map(({ finding }) =>
    stringField(finding, "serviceId", "unknown service")
  ));
  const packages = uniqueStrings(observations.map(({ finding }) => packageIdentity(finding)))
    .filter((value) => value !== "");
  const observedFindings = observations.map(({ finding }) => finding);
  return {
    answer: `Supplied ${scope}runtime-trace evidence records ${packages.length === 0 ? "the affected package" : summarizedValues(packages)} loaded for ${summarizedValues(services)}. This confirms a runtime observation, not that vulnerable code executed.`,
    severity: findingSeverity(highestRiskFinding(observedFindings)),
    evidenceRefs: observations.flatMap(({ item }) => stringArray(item.evidenceRefs)),
    unknowns: observedFindings.flatMap(findingUnknowns),
    recommendedActions: ["Inspect the cited runtime observation before making a vulnerable-code execution claim."],
  };
}

function remediationDraft(summary: Readonly<Record<string, unknown>>): DeterministicDraft {
  const remediation = recordValue(summary.remediation);
  if (remediation === undefined) {
    return {
      answer: "No remediation plan or verification record is supplied in this deterministic incident summary, so strong remediation verification cannot be confirmed.",
      severity: "unknown",
      evidenceRefs: [],
      unknowns: ["Remediation status and strong graph verification were not supplied."],
      recommendedActions: ["Load the deterministic remediation record and its strong zero-path graph verification before declaring success."],
    };
  }
  const verification = recordValue(remediation.verification);
  const status = stringField(remediation, "status", "unknown");
  const level = verification === undefined ? "unknown" : stringField(verification, "level", "unknown");
  const passed = verification?.passed === true;
  const remainingPathCount = verification === undefined
    ? undefined
    : optionalNonnegativeInteger(verification.remainingPathCount);
  const stronglyVerified = status === "VERIFIED" && level === "STRONG_GRAPH" &&
    passed && remainingPathCount === 0;
  const details = `status ${status}, verification level ${level}${remainingPathCount === undefined ? "" : `, and ${remainingPathCount} remaining path${remainingPathCount === 1 ? "" : "s"}`}`;
  return {
    answer: stronglyVerified
      ? `The supplied remediation record reports ${details}; strong zero-path verification is explicitly confirmed.`
      : `The supplied remediation record reports ${details}. It does not explicitly establish VERIFIED status with passed STRONG_GRAPH verification and zero remaining paths.`,
    severity: "unknown",
    evidenceRefs: [
      ...stringArray(remediation.evidenceRefs),
      ...stringArray(verification?.evidenceRefs),
    ],
    unknowns: stronglyVerified ? [] : ["Strong remediation verification is not established by the supplied record."],
    recommendedActions: stronglyVerified
      ? ["Retain the cited remediation and zero-path evidence with the incident record."]
      : ["Require an explicit VERIFIED / STRONG_GRAPH / zero-remaining-path result before declaring success."],
  };
}

function priorityDraft(findings: readonly Record<string, unknown>[]): DeterministicDraft {
  const highest = highestRiskFinding(findings);
  if (highest === undefined) {
    return {
      answer: "No affected service appears in the supplied deterministic findings, so this evidence cannot name a remediation priority.",
      severity: "unknown",
      evidenceRefs: [],
      unknowns: ["No affected service finding was supplied."],
      recommendedActions: ["Confirm the affected version and incident query scope."],
    };
  }
  const service = stringField(highest, "serviceId", "The highest-risk service");
  const packageName = stringField(highest, "affectedPackageName", "the affected package");
  const version = stringField(highest, "affectedVersion", "unknown");
  const score = riskScore(highest);
  return {
    answer: `${service} is the highest-priority service in the supplied findings based on the highest deterministic risk score${score === 0 ? "" : ` (${score})`}. It contains ${packageName}@${version}; inspect its cited path and reachability evidence before remediation.`,
    severity: findingSeverity(highest),
    evidenceRefs: findingEvidenceRefs(highest),
    unknowns: findingUnknowns(highest),
    recommendedActions: [
      "Inspect the highest-risk finding's complete path.",
      "Generate evidence-backed lockfile remediation candidates.",
      "Require a zero-path strong graph verification before declaring success.",
    ],
  };
}

function summaryDraft(
  findings: readonly Record<string, unknown>[],
  summary: Readonly<Record<string, unknown>>,
): DeterministicDraft {
  if (findings.length === 0) {
    return {
      answer: "No deployed exposure matches the supplied deterministic incident query.",
      severity: "unknown",
      evidenceRefs: [],
      unknowns: [],
      recommendedActions: ["Confirm the affected version and incident window."],
    };
  }
  const suppliedServiceCount = optionalNonnegativeInteger(summary.totalAffectedServices);
  const serviceCount = suppliedServiceCount ?? new Set(
    findings.map((finding) => normalizedText(finding.serviceId)).filter((value) => value !== "")
  ).size;
  const totalPaths = optionalNonnegativeInteger(summary.totalPaths);
  const highest = highestRiskFinding(findings)!;
  return {
    answer: `The supplied deterministic incident summary contains ${findings.length} finding${findings.length === 1 ? "" : "s"} across ${serviceCount} affected service${serviceCount === 1 ? "" : "s"}${totalPaths === undefined ? "" : ` and ${totalPaths} complete dependency path${totalPaths === 1 ? "" : "s"}`}. This bounded fallback has no more specific supplied fact for the question; inspect the cited evidence rather than inferring an answer.`,
    severity: findingSeverity(highest),
    evidenceRefs: findings.flatMap(findingEvidenceRefs),
    unknowns: findings.flatMap(findingUnknowns),
    recommendedActions: ["Inspect the cited deterministic findings for the requested fact."],
  };
}

function affectedServiceQuestion(question: string): string | undefined {
  const match = /\b(?:was|is|were|are)\s+(?:the\s+)?(?:service\s+)?["'`]?([a-z0-9@][a-z0-9@._:/-]{0,127})["'`]?\s+(?:affected|exposed|impacted|vulnerable)\b/iu.exec(question);
  return match?.[1];
}

function remediationQuestion(question: string): boolean {
  return /\bremediat(?:e|ed|es|ing|ion|ions)\b|\bverification\b|\bstrong(?:ly)?\s+verif(?:y|ied|ication)\b/iu.test(question);
}

function runtimeQuestion(question: string): boolean {
  return /\bruntime(?:-trace)?\b|\bproduction\s+execution\b/iu.test(question);
}

function priorityQuestion(question: string): boolean {
  return /\bpriority\b|\burgent\b|\bhighest[- ]risk\b|\bmost\s+severe\b|\b(?:fix|fixed|investigate|address)\s+first\b|\bwhich\s+(?:production\s+)?service\s+should\b/iu.test(question);
}

function highestRiskFinding(
  findings: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  return [...findings].sort((left, right) =>
    riskScore(right) - riskScore(left) ||
    stringField(left, "serviceId", "").localeCompare(stringField(right, "serviceId", "")) ||
    stringField(left, "findingId", "").localeCompare(stringField(right, "findingId", ""))
  )[0];
}

function findingRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.map(recordValue)
      .filter((finding): finding is Record<string, unknown> => finding !== undefined)
      .slice(0, 100)
    : [];
}

function findingSeverity(finding: Record<string, unknown> | undefined): CopilotResponse["severity"] {
  const severity = normalizedText(recordValue(finding?.risk)?.label);
  return severity === "critical" || severity === "high" || severity === "medium" || severity === "low"
    ? severity
    : "unknown";
}

function riskScore(finding: Record<string, unknown>): number {
  const score = recordValue(finding.risk)?.score;
  return typeof score === "number" && Number.isFinite(score) && score >= 0 ? score : 0;
}

function findingEvidenceRefs(finding: Record<string, unknown>): string[] {
  return [
    ...stringArray(finding.evidenceRefs),
    ...reachabilityEvidence(finding).flatMap((item) => stringArray(item.evidenceRefs)),
  ];
}

function findingUnknowns(finding: Record<string, unknown>): string[] {
  return stringArray(finding.unknowns);
}

function reachabilityEvidence(finding: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(finding.reachabilityEvidence)
    ? finding.reachabilityEvidence
      .map(recordValue)
      .filter((item): item is Record<string, unknown> => item !== undefined)
      .slice(0, 100)
    : [];
}

function packageIdentity(finding: Record<string, unknown>): string {
  const name = stringField(finding, "affectedPackageName", "");
  const version = stringField(finding, "affectedVersion", "");
  return name === "" ? "" : version === "" ? name : `${name}@${version}`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") return fallback;
  return value.length <= 256 ? value : `${value.slice(0, 253)}...`;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, 1_000)
    : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function optionalNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nonnegativeInteger(value: unknown): number {
  return optionalNonnegativeInteger(value) ?? 0;
}

function summarizedValues(values: readonly string[]): string {
  const displayed = values.slice(0, 5);
  const remaining = values.length - displayed.length;
  return `${displayed.join(", ")}${remaining === 0 ? "" : ` and ${remaining} more`}`;
}

function buildPrompt(evidence: CopilotEvidence, promptVersion: string): string { return `You are the HydraTrace incident explainer. Never decide exposure, reachability, risk, or verification. Use only the supplied deterministic JSON evidence. Return one strict JSON object with answer, severity, evidenceRefs, unknowns, recommendedActions. Cite only evidenceRefs present in the input. Prompt version: ${promptVersion}\n${JSON.stringify(evidence)}`; }
function extractJson(value: string): string { const first = value.indexOf("{"); const last = value.lastIndexOf("}"); if (first < 0 || last <= first) throw new Error("Provider did not return JSON"); return value.slice(first, last + 1); }
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`; return JSON.stringify(value); }
