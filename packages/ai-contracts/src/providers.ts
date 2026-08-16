import type { AiProvider } from "./copilot.js";

export class AiGatewayProvider implements AiProvider {
  readonly name = "hydratrace-ai-gateway";
  constructor(
    private readonly url: string,
    private readonly sharedSecret: string,
  ) {}

  async generate(prompt: string, signal: AbortSignal): Promise<string> {
    const evidence = prompt.slice(prompt.indexOf("\n") + 1);
    const parsed = JSON.parse(evidence) as { evidenceRefs?: string[] };
    const response = await fetch(`${this.url.replace(/\/$/u, "")}/v1/generate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.sharedSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        evidenceRefs: parsed.evidenceRefs ?? [],
      }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`HydraTrace AI gateway returned ${response.status}`);
    }
    const value = await response.json() as Record<string, unknown>;
    delete value.provider;
    return JSON.stringify(value);
  }
}

export class CloudflareWorkersAiProvider implements AiProvider {
  readonly name = "cloudflare-workers-ai";
  constructor(private readonly accountId: string, private readonly token: string, private readonly model = "@cf/openai/gpt-oss-120b") {}
  async generate(prompt: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/ai/run/${this.model}`, { method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "system", content: "Return strict JSON only." }, { role: "user", content: prompt }], temperature: 0, max_tokens: 1_500 }), signal });
    if (!response.ok) throw new Error(`Cloudflare Workers AI returned ${response.status}`);
    const value = await response.json() as { result?: { response?: string; output_text?: string }; response?: string };
    const output = value.result?.response ?? value.result?.output_text ?? value.response; if (output === undefined) throw new Error("Cloudflare Workers AI response did not contain text"); return output;
  }
}

export class NvidiaNimProvider implements AiProvider {
  readonly name = "nvidia-nim";
  constructor(private readonly apiKey: string, private readonly model = "nvidia/nemotron-3-super-120b-a12b", private readonly baseUrl = "https://integrate.api.nvidia.com/v1") {}
  async generate(prompt: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: this.model, messages: [{ role: "system", content: "Return strict JSON only." }, { role: "user", content: prompt }], temperature: 0, max_tokens: 1_500, stream: false }), signal });
    if (!response.ok) throw new Error(`NVIDIA NIM returned ${response.status}`);
    const value = await response.json() as { choices?: Array<{ message?: { content?: string } }> }; const output = value.choices?.[0]?.message?.content; if (output === undefined) throw new Error("NVIDIA NIM response did not contain text"); return output;
  }
}
