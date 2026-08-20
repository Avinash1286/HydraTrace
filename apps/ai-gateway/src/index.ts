import { z } from "zod";

interface Env {
  AI: Ai;
  AI_GATEWAY_SHARED_SECRET?: string;
  CLOUDFLARE_AI_MODEL: string;
  NVIDIA_API_KEY?: string;
  NVIDIA_NIM_MODEL: string;
  NVIDIA_NIM_BASE_URL: string;
}

const requestSchema = z.object({
  prompt: z.string().min(1).max(100_000),
  evidenceRefs: z.array(z.string()).max(10_000),
}).strict();
const severitySchema = z.preprocess(
  (value) => typeof value === "string" ? value.trim().toLowerCase() : value,
  z.enum(["critical", "high", "medium", "low", "unknown"]),
);
const responseSchema = z.object({
  answer: z.string(),
  severity: severitySchema,
  evidenceRefs: z.array(z.string()),
  unknowns: z.array(z.string()),
  recommendedActions: z.array(z.string()),
}).strict();

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return Response.json({ status: "ok", service: "hydratrace-ai-gateway" });
    if (request.method !== "POST" || url.pathname !== "/v1/generate") return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    if (typeof env.AI_GATEWAY_SHARED_SECRET !== "string" || env.AI_GATEWAY_SHARED_SECRET.length < 32) {
      return Response.json({ error: "GATEWAY_NOT_CONFIGURED" }, { status: 503 });
    }
    if (!constantTimeEqual(request.headers.get("authorization") ?? "", `Bearer ${env.AI_GATEWAY_SHARED_SECRET}`)) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    const parsed = requestSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
    const allowedRefs = new Set(parsed.data.evidenceRefs);
    const messages = [{ role: "system", content: "Return strict JSON only. Use only supplied deterministic evidence and cite only allowed references." }, { role: "user", content: parsed.data.prompt }];
    const attempts: Array<() => Promise<string>> = [
      async () => textFromCloudflare(await env.AI.run(env.CLOUDFLARE_AI_MODEL as Parameters<Ai["run"]>[0], { messages, temperature: 0, max_tokens: 800 } as never)),
      async () => {
        if (!env.NVIDIA_API_KEY) throw new Error("NVIDIA fallback is not configured");
        const response = await fetch(`${env.NVIDIA_NIM_BASE_URL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${env.NVIDIA_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model: env.NVIDIA_NIM_MODEL, messages, temperature: 0, max_tokens: 1_500 }) });
        if (!response.ok) throw new Error(`NVIDIA returned ${response.status}`);
        const value = await response.json() as { choices?: Array<{ message?: { content?: string } }> }; return value.choices?.[0]?.message?.content ?? "";
      },
    ];
    for (const [index, attempt] of attempts.entries()) {
      try {
        const value = responseSchema.parse(JSON.parse(extractJson(await attempt())));
        const evidenceRefs = [...new Set(value.evidenceRefs.filter((reference) => allowedRefs.has(reference)))];
        if (value.answer.length > 0 && evidenceRefs.length === 0) throw new Error("Ungrounded provider response");
        return Response.json({ ...value, evidenceRefs, provider: index === 0 ? "cloudflare-workers-ai" : "nvidia-nim" });
      } catch (error) {
        console.warn("HydraTrace AI provider attempt failed", {
          provider: index === 0 ? "cloudflare-workers-ai" : "nvidia-nim",
          reason: safeProviderError(error),
        });
      }
    }
    return Response.json({ error: "PROVIDERS_UNAVAILABLE", deterministicFallbackRequired: true }, { status: 503 });
  },
} satisfies ExportedHandler<Env>;

function textFromCloudflare(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") throw new Error("Cloudflare output did not contain text");
  const record = value as Record<string, unknown>;
  if (typeof record.response === "string") return record.response;
  if (record.response !== null && typeof record.response === "object") return JSON.stringify(record.response);
  if (typeof record.output_text === "string") return record.output_text;

  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choiceContent = choices
    .map((choice) => choice !== null && typeof choice === "object" ? (choice as Record<string, unknown>).message : undefined)
    .map((message) => message !== null && typeof message === "object" ? (message as Record<string, unknown>).content : undefined)
    .find((content): content is string => typeof content === "string");
  if (choiceContent !== undefined) return choiceContent;

  const output = Array.isArray(record.output) ? record.output : [];
  const outputText = output.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const outputItem = item as Record<string, unknown>;
    if (typeof outputItem.text === "string") return [outputItem.text];
    if (typeof outputItem.content === "string") return [outputItem.content];
    if (!Array.isArray(outputItem.content)) return [];
    return outputItem.content.flatMap((part) => {
      if (part === null || typeof part !== "object") return [];
      const contentPart = part as Record<string, unknown>;
      return typeof contentPart.text === "string" ? [contentPart.text] : [];
    });
  }).join("\n");
  if (outputText !== "") return outputText;
  throw new Error("Cloudflare output did not contain text");
}
function extractJson(value: string): string { const first = value.indexOf("{"); const last = value.lastIndexOf("}"); if (first < 0 || last <= first) throw new Error("No JSON object"); return value.slice(first, last + 1); }
function constantTimeEqual(left: string, right: string): boolean { if (left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index); return difference === 0; }
function safeProviderError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 240) : "Unknown provider error";
}
