import { afterEach, describe, expect, it, vi } from "vitest";
import { AiGatewayProvider } from "./providers.js";

describe("AiGatewayProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends only the allowed evidence set and strips gateway metadata", async () => {
    const request = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        Response.json({
          answer: "Grounded answer",
          severity: "high",
          evidenceRefs: ["evidence:1"],
          unknowns: [],
          recommendedActions: ["Inspect the path"],
          provider: "cloudflare-workers-ai",
        }),
    );
    vi.stubGlobal("fetch", request);
    const provider = new AiGatewayProvider(
      "https://gateway.example/",
      "shared-secret",
    );

    const output = await provider.generate(
      `instructions\n${JSON.stringify({ evidenceRefs: ["evidence:1"] })}`,
      new AbortController().signal,
    );

    expect(JSON.parse(output)).not.toHaveProperty("provider");
    const init = request.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({
      authorization: "Bearer shared-secret",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      evidenceRefs: ["evidence:1"],
    });
  });
});
