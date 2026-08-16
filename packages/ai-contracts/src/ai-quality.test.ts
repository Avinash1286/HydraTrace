import { describe, expect, it } from "vitest";
import { GroundedCopilot, type AiProvider } from "./copilot.js";

const questions = [
  "Which production service should be fixed first?",
  "How did the affected package enter checkout?",
  "Was analytics exposed?",
  "What evidence proves the exact version?",
  "When did exposure begin?",
  "When did checkout become safe?",
  "Which paths are statically reachable?",
  "Which packages were observed in tests?",
  "Is production runtime execution known?",
  "What remains unknown?",
  "How many complete paths exist?",
  "Which deployment contains the bad snapshot?",
  "What is the minimum remediation?",
  "Has remediation been strongly verified?",
  "Why is the risk score high?",
  "Which maintainer relationships deserve review?",
  "Are similar names proof of malware?",
  "Which evidence came from the lockfile?",
  "Can AI change exposure truth?",
  "Give an executive incident summary.",
] as const;

describe("twenty-question grounded AI quality gate", () => {
  for (const [index, question] of questions.entries()) {
    it(`keeps question ${index + 1} schema-valid, cited, and abstaining`, async () => {
      const allowed = [`E-Q${index + 1}-PATH`, `E-Q${index + 1}-DEPLOYMENT`];
      const provider: AiProvider = {
        name: "quality-fixture",
        generate: async () => JSON.stringify({
          answer: "Checkout is the highest-priority service based on the supplied path and deployment evidence.",
          severity: "high",
          evidenceRefs: [...allowed, "E-INVENTED"],
          unknowns: ["No production runtime trace is available."],
          recommendedActions: ["Inspect the cited path before changing the lockfile."],
        }),
      };
      const result = await new GroundedCopilot([provider]).answer({
        incidentId: `incident-${index + 1}`,
        question,
        summary: { findings: [{ serviceId: "checkout-api", risk: { score: 88, label: "High" } }] },
        evidenceRefs: allowed,
        unknowns: ["No production runtime trace is available."],
      });
      expect(result.grounded).toBe(true);
      expect(result.evidenceRefs).toEqual(allowed);
      expect(result.unknowns).toContain("No production runtime trace is available.");
      expect(result.answer.length).toBeGreaterThan(0);
    });
  }
});

