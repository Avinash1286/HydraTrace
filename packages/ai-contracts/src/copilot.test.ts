import { describe, expect, it } from "vitest";
import { GroundedCopilot, deterministicCopilot, type AiProvider } from "./copilot.js";

const evidence = {
  incidentId: "1",
  question: "What is most urgent?",
  summary: {
    findings: [{ serviceId: "checkout", affectedPackageName: "bad", affectedVersion: "1.0.0", risk: { score: 92, label: "Critical" } }],
  },
  evidenceRefs: ["E-1", "E-2"],
  unknowns: ["No production runtime trace is available."],
};

describe("grounded copilot", () => {
  it("falls back deterministically when providers are unavailable", async () => {
    const result = await new GroundedCopilot([]).answer(evidence);
    expect(result).toMatchObject({ provider: "deterministic-template", grounded: true, severity: "critical", evidenceRefs: ["E-1", "E-2"] });
  });

  it("removes invented evidence references", async () => {
    const provider: AiProvider = { name: "fixture", generate: async () => JSON.stringify({ answer: "checkout is urgent", severity: "critical", evidenceRefs: ["E-1", "E-INVENTED"], unknowns: [], recommendedActions: [] }) };
    const result = await new GroundedCopilot([provider]).answer(evidence);
    expect(result.evidenceRefs).toEqual(["E-1"]);
  });

  it("never loses explicit unknowns in the template fallback", () => {
    expect(deterministicCopilot(evidence).unknowns).toEqual(evidence.unknowns);
  });
});
