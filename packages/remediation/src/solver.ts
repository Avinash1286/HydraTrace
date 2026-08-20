import { stableIdFromCanonicalKey, type StableId } from "@hydratrace/domain";
import type { CandidateCost, RemediationCandidate, RemediationSolution, SemverImpact } from "./models.js";

export function remediationCandidate(input: Omit<RemediationCandidate, "candidateId">): RemediationCandidate {
  const candidateId = stableIdFromCanonicalKey(`remediation-candidate:${input.dependencyName}:${input.fromVersion}:${input.toVersion}:${[...input.eliminatedPathIds].sort().join(",")}`);
  return { candidateId, ...input, eliminatedPathIds: [...new Set(input.eliminatedPathIds)].sort(), affectedServices: [...new Set(input.affectedServices)].sort() };
}

export function solveRemediation(
  vulnerablePathIds: readonly StableId[],
  candidates: readonly RemediationCandidate[],
): RemediationSolution {
  const universe = [...new Set(vulnerablePathIds)].sort();
  const valid = candidates.filter((candidate) =>
    candidate.verification !== "PROPOSED" &&
    !candidate.deprecated &&
    !candidate.knownVulnerable &&
    candidate.eliminatedPathIds.some((id) => universe.includes(id)));
  return valid.length <= 25 ? exactSolve(universe, valid) : greedySolve(universe, valid);
}

function exactSolve(universe: readonly StableId[], candidates: readonly RemediationCandidate[]): RemediationSolution {
  let best: { chosen: RemediationCandidate[]; cost: number; covered: Set<StableId> } | undefined;
  const visit = (index: number, chosen: RemediationCandidate[], covered: Set<StableId>, cost: number): void => {
    if (best !== undefined && cost >= best.cost) return;
    if (covered.size === universe.length) { best = { chosen: [...chosen], cost, covered: new Set(covered) }; return; }
    if (index >= candidates.length) return;
    const remainingCoverage = new Set(covered);
    for (let cursor = index; cursor < candidates.length; cursor += 1) for (const path of candidates[cursor]!.eliminatedPathIds) if (universe.includes(path)) remainingCoverage.add(path);
    if (remainingCoverage.size < universe.length) return;
    const candidate = candidates[index]!;
    const nextCovered = new Set(covered);
    for (const path of candidate.eliminatedPathIds) if (universe.includes(path)) nextCovered.add(path);
    chosen.push(candidate); visit(index + 1, chosen, nextCovered, cost + candidateCost(candidate).total); chosen.pop();
    visit(index + 1, chosen, covered, cost);
  };
  visit(0, [], new Set(), 0);
  const chosen = best?.chosen ?? [];
  return solution(universe, chosen, true);
}

function greedySolve(universe: readonly StableId[], candidates: readonly RemediationCandidate[]): RemediationSolution {
  const uncovered = new Set(universe); const chosen: RemediationCandidate[] = []; const remaining = [...candidates];
  while (uncovered.size > 0) {
    remaining.sort((left, right) => {
      const leftCount = left.eliminatedPathIds.filter((path) => uncovered.has(path)).length;
      const rightCount = right.eliminatedPathIds.filter((path) => uncovered.has(path)).length;
      const leftRatio = leftCount / Math.max(candidateCost(left).total, 0.01);
      const rightRatio = rightCount / Math.max(candidateCost(right).total, 0.01);
      return rightRatio - leftRatio || left.candidateId.localeCompare(right.candidateId);
    });
    const candidate = remaining.shift();
    if (candidate === undefined || !candidate.eliminatedPathIds.some((path) => uncovered.has(path))) break;
    chosen.push(candidate); for (const path of candidate.eliminatedPathIds) uncovered.delete(path);
  }
  return solution(universe, chosen, false);
}

export function candidateCost(candidate: RemediationCandidate): CandidateCost {
  const semverPenalty = semverCost(candidate.semverImpact);
  const changedDirectDependencies = 1;
  const lockfileChurnPenalty = Math.min(10, candidate.lockfileChurn / 25);
  const affectedServiceCount = candidate.affectedServices.length * 0.5;
  const verificationFailurePenalty = candidate.verification === "PROPOSED" ? 5 : 0;
  return { total: round(semverPenalty + changedDirectDependencies + lockfileChurnPenalty + affectedServiceCount + verificationFailurePenalty), semverPenalty, changedDirectDependencies, lockfileChurnPenalty: round(lockfileChurnPenalty), affectedServiceCount, verificationFailurePenalty };
}

function solution(universe: readonly StableId[], chosen: readonly RemediationCandidate[], exact: boolean): RemediationSolution {
  const covered = new Set<StableId>(); for (const candidate of chosen) for (const path of candidate.eliminatedPathIds) if (universe.includes(path)) covered.add(path);
  const withCosts = chosen.map((candidate) => ({ candidate, cost: candidateCost(candidate) }));
  return { candidates: withCosts, coveredPathIds: [...covered].sort(), uncoveredPathIds: universe.filter((path) => !covered.has(path)), exact, totalCost: round(withCosts.reduce((sum, value) => sum + value.cost.total, 0)) };
}
function semverCost(impact: SemverImpact): number { return impact === "patch" ? 1 : impact === "minor" ? 3 : impact === "major" ? 8 : 5; }
function round(value: number): number { return Math.round(value * 100) / 100; }
