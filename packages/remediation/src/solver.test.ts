import { describe, expect, it } from "vitest";
import type { StableId } from "@hydratrace/domain";
import { remediationCandidate, solveRemediation } from "./solver.js";

const id = (value: number) => String(value) as StableId;

describe("weighted remediation solver", () => {
  it("finds the exact two-change plan that covers every path", () => {
    const candidates = [
      remediationCandidate({ dependencyName: "gateway", fromVersion: "1.0.0", toVersion: "1.0.1", semverImpact: "patch", eliminatedPathIds: [id(1), id(2)], affectedServices: ["checkout"], lockfileChurn: 2, deprecated: false, knownVulnerable: false, verification: "LOCKFILE_VERIFIED", evidenceRefs: ["E-1"] }),
      remediationCandidate({ dependencyName: "queue", fromVersion: "2.0.0", toVersion: "2.1.0", semverImpact: "minor", eliminatedPathIds: [id(3)], affectedServices: ["payment"], lockfileChurn: 3, deprecated: false, knownVulnerable: false, verification: "LOCKFILE_VERIFIED", evidenceRefs: ["E-2"] }),
      remediationCandidate({ dependencyName: "platform", fromVersion: "1.0.0", toVersion: "2.0.0", semverImpact: "major", eliminatedPathIds: [id(1), id(2), id(3)], affectedServices: ["checkout", "payment"], lockfileChurn: 100, deprecated: false, knownVulnerable: false, verification: "PROPOSED", evidenceRefs: ["E-3"] }),
    ];
    const solution = solveRemediation([id(1), id(2), id(3)], candidates);
    expect(solution.exact).toBe(true);
    expect(solution.uncoveredPathIds).toEqual([]);
    expect(solution.candidates.map(({ candidate }) => candidate.dependencyName)).toEqual(["gateway", "queue"]);
  });

  it("does not use deprecated or still-vulnerable candidates", () => {
    const unsafe = remediationCandidate({ dependencyName: "bad", fromVersion: "1", toVersion: "2", semverImpact: "major", eliminatedPathIds: [id(1)], affectedServices: [], lockfileChurn: 0, deprecated: true, knownVulnerable: false, verification: "PROPOSED", evidenceRefs: [] });
    expect(solveRemediation([id(1)], [unsafe]).uncoveredPathIds).toEqual([id(1)]);
  });

  it("never turns a merely proposed client candidate into an automatic recommendation", () => {
    const proposed = remediationCandidate({ dependencyName: "gateway", fromVersion: "1.0.0", toVersion: "1.0.1", semverImpact: "patch", eliminatedPathIds: [id(1)], affectedServices: ["api"], lockfileChurn: 0, deprecated: false, knownVulnerable: false, verification: "PROPOSED", evidenceRefs: [] });
    expect(solveRemediation([id(1)], [proposed])).toMatchObject({
      candidates: [],
      coveredPathIds: [],
      uncoveredPathIds: [id(1)],
    });
  });
});
