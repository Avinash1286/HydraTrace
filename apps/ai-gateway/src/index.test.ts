import { describe, expect, it, vi } from "vitest";

import gateway from "./index.js";

const secret = "hydratrace-test-secret-that-is-at-least-32-characters";

function request(authorization?: string): Request {
  return new Request("https://gateway.example.test/v1/generate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify({
      prompt: "Explain the deterministic evidence.",
      evidenceRefs: ["evidence:one"],
    }),
  });
}

function environment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    AI: { run: vi.fn() },
    CLOUDFLARE_AI_MODEL: "@cf/openai/gpt-oss-120b",
    NVIDIA_NIM_MODEL: "nvidia/nemotron-3-super-120b-a12b",
    NVIDIA_NIM_BASE_URL: "https://integrate.api.nvidia.com/v1",
    ...overrides,
  };
}

function invoke(input: Request, env: Record<string, unknown>): Promise<Response> {
  return gateway.fetch(input as never, env as never);
}

describe("Cloudflare AI gateway", () => {
  it("fails closed before a strong shared secret is installed", async () => {
    const missing = await invoke(request("Bearer undefined"), environment());
    const short = await invoke(request("Bearer short"), environment({ AI_GATEWAY_SHARED_SECRET: "short" }));

    expect(missing.status).toBe(503);
    expect(short.status).toBe(503);
    await expect(missing.json()).resolves.toEqual({ error: "GATEWAY_NOT_CONFIGURED" });
  });

  it("rejects an invalid bearer token", async () => {
    const response = await invoke(request("Bearer incorrect"), environment({ AI_GATEWAY_SHARED_SECRET: secret }));

    expect(response.status).toBe(401);
  });

  it("returns only allowed evidence references from Workers AI", async () => {
    const run = vi.fn().mockResolvedValue({
      response: JSON.stringify({
        answer: "The exact dependency path reaches the affected version.",
        severity: "high",
        evidenceRefs: ["evidence:one", "invented:reference"],
        unknowns: [],
        recommendedActions: ["Apply the verified lockfile remediation."],
      }),
    });
    const response = await invoke(
      request(`Bearer ${secret}`),
      environment({ AI: { run }, AI_GATEWAY_SHARED_SECRET: secret }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      provider: "cloudflare-workers-ai",
      evidenceRefs: ["evidence:one"],
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("accepts the Responses API output shape used by GPT-OSS", async () => {
    const run = vi.fn().mockResolvedValue({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            answer: "The deployment is exposed.",
            severity: "critical",
            evidenceRefs: ["evidence:one"],
            unknowns: [],
            recommendedActions: ["Apply the verified remediation."],
          }),
        }],
      }],
    });
    const response = await invoke(
      request(`Bearer ${secret}`),
      environment({ AI: { run }, AI_GATEWAY_SHARED_SECRET: secret }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      provider: "cloudflare-workers-ai",
      severity: "critical",
    });
  });
});
