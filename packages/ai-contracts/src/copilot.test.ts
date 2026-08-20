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

const incidentEvidence = {
  incidentId: "production-incident",
  question: "Which production service should be fixed first?",
  summary: {
    totalAffectedServices: 2,
    totalPaths: 3,
    findings: [
      {
        findingId: "finding-checkout",
        serviceId: "checkout-api",
        environment: "production",
        affectedPackageName: "checkout-framework",
        affectedVersion: "2.0.0",
        pathCount: 2,
        risk: { score: 88, label: "High" },
        evidenceRefs: ["E-CHECKOUT"],
        unknowns: [],
        reachabilityEvidence: [{
          source: "static",
          evidenceRefs: ["E-CHECKOUT-STATIC"],
        }],
      },
      {
        findingId: "finding-payment",
        serviceId: "payment-worker",
        environment: "production",
        affectedPackageName: "queue-runtime",
        affectedVersion: "4.0.0",
        pathCount: 1,
        risk: { score: 94, label: "Critical" },
        evidenceRefs: ["E-PAYMENT"],
        unknowns: [],
        reachabilityEvidence: [{
          source: "test-trace",
          evidenceRefs: ["E-PAYMENT-TEST"],
        }],
      },
    ],
  },
  evidenceRefs: [
    "E-CHECKOUT",
    "E-CHECKOUT-STATIC",
    "E-PAYMENT",
    "E-PAYMENT-TEST",
  ],
  unknowns: ["The exact malicious-publication window is unavailable."],
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

  it("answers an affected named service only from its matching production finding", () => {
    const result = deterministicCopilot({
      ...incidentEvidence,
      question: "Was checkout-api affected in production?",
    });

    expect(result.answer).toContain("checkout-api appears in 1 supplied production finding");
    expect(result.answer).toContain("checkout-framework@2.0.0");
    expect(result.answer).not.toContain("payment-worker");
    expect(result.evidenceRefs).toEqual(["E-CHECKOUT", "E-CHECKOUT-STATIC"]);
  });

  it("answers the analytics negative after provider failure without substituting the highest-risk service", async () => {
    const unavailableProvider: AiProvider = {
      name: "unavailable-gateway",
      generate: async () => { throw new Error("gateway unavailable"); },
    };
    const result = await new GroundedCopilot([unavailableProvider]).answer({
      ...incidentEvidence,
      question: "Was analytics-dashboard affected in production?",
    });

    expect(result.provider).toBe("deterministic-template");
    expect(result.answer).toContain("analytics-dashboard does not appear in the supplied production findings");
    expect(result.answer).toContain("does not show it as affected for this query");
    expect(result.answer).not.toContain("payment-worker");
    expect(result.answer).not.toContain("highest-priority");
  });

  it("does not turn an invented service into a broad safe or affected claim", () => {
    const result = deterministicCopilot({
      ...incidentEvidence,
      question: "Was invented-ledger-api affected in production?",
    });

    expect(result.answer).toContain("invented-ledger-api does not appear");
    expect(result.answer).toContain("does not establish whether that service exists or is safe outside the supplied scope");
    expect(result.unknowns).toContain("No production finding for invented-ledger-api is supplied.");
  });

  it("keeps production runtime execution unknown when only static and test evidence is supplied", () => {
    const result = deterministicCopilot({
      ...incidentEvidence,
      question: "Is production runtime execution known?",
    });

    expect(result.answer).toContain("No production runtime-trace evidence is supplied");
    expect(result.answer).toContain("runtime execution is unknown");
    expect(result.answer).toContain("test-trace evidence must not be treated as production runtime confirmation");
    expect(result.unknowns).toContain("No production runtime-trace evidence is supplied for the current findings.");
  });

  it("reports an explicit production runtime observation without claiming vulnerable code executed", () => {
    const runtimeEvidence = structuredClone(incidentEvidence);
    runtimeEvidence.question = "Is production runtime execution known?";
    runtimeEvidence.summary.findings[0]!.reachabilityEvidence = [{
      source: "runtime-trace",
      evidenceRefs: ["E-CHECKOUT-RUNTIME"],
    }];
    runtimeEvidence.evidenceRefs.push("E-CHECKOUT-RUNTIME");
    const result = deterministicCopilot(runtimeEvidence);

    expect(result.answer).toContain("production runtime-trace evidence records checkout-framework@2.0.0 loaded for checkout-api");
    expect(result.answer).toContain("not that vulnerable code executed");
    expect(result.evidenceRefs).toEqual(["E-CHECKOUT-RUNTIME"]);
  });

  it("does not invent remediation verification when no remediation record is supplied", () => {
    const result = deterministicCopilot({
      ...incidentEvidence,
      question: "Has remediation been strongly verified?",
    });

    expect(result.answer).toContain("No remediation plan or verification record is supplied");
    expect(result.answer).toContain("strong remediation verification cannot be confirmed");
    expect(result.severity).toBe("unknown");
    expect(result.unknowns).toContain("Remediation status and strong graph verification were not supplied.");
  });

  it("keeps priority selection bounded to the highest supplied deterministic risk score", () => {
    const result = deterministicCopilot(incidentEvidence);

    expect(result.answer).toContain("payment-worker is the highest-priority service");
    expect(result.answer).toContain("risk score (94)");
    expect(result.answer).not.toContain("analytics-dashboard");
    expect(result.evidenceRefs).toEqual(["E-PAYMENT", "E-PAYMENT-TEST"]);
  });
});
