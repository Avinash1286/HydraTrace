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
  const findings = Array.isArray(evidence.summary.findings) ? evidence.summary.findings as Array<Record<string, unknown>> : [];
  const highest = [...findings].sort((left, right) => Number((right.risk as Record<string, unknown> | undefined)?.score ?? 0) - Number((left.risk as Record<string, unknown> | undefined)?.score ?? 0))[0];
  const service = String(highest?.serviceId ?? "No service"); const packageName = String(highest?.affectedPackageName ?? "the affected package"); const version = String(highest?.affectedVersion ?? "unknown");
  const severity = String((highest?.risk as Record<string, unknown> | undefined)?.label ?? "unknown").toLowerCase();
  return { answer: findings.length === 0 ? "No deployed exposure matches the current deterministic incident query." : `${service} is currently the highest-priority service in this evidence set. It contains ${packageName}@${version}; review its complete dependency path and reachability evidence before remediation.`, severity: ["critical", "high", "medium", "low"].includes(severity) ? severity as CopilotResponse["severity"] : "unknown", evidenceRefs: evidence.evidenceRefs.slice(0, 20), unknowns: [...evidence.unknowns], recommendedActions: findings.length === 0 ? ["Confirm the affected version and incident window."] : ["Inspect the highest-risk finding's complete path.", "Generate lockfile-only remediation candidates.", "Require a zero-path strong graph verification before declaring success."], provider: "deterministic-template", grounded: true, promptVersion };
}

function buildPrompt(evidence: CopilotEvidence, promptVersion: string): string { return `You are the HydraTrace incident explainer. Never decide exposure, reachability, risk, or verification. Use only the supplied deterministic JSON evidence. Return one strict JSON object with answer, severity, evidenceRefs, unknowns, recommendedActions. Cite only evidenceRefs present in the input. Prompt version: ${promptVersion}\n${JSON.stringify(evidence)}`; }
function extractJson(value: string): string { const first = value.indexOf("{"); const last = value.lastIndexOf("}"); if (first < 0 || last <= first) throw new Error("Provider did not return JSON"); return value.slice(first, last + 1); }
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`; return JSON.stringify(value); }
