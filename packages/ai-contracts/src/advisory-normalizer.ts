import { z } from "zod";

export const advisoryDraftSchema = z.object({
  advisoryId: z.string().min(1),
  ecosystem: z.literal("npm"),
  packageNames: z.array(z.string().min(1)).min(1),
  affectedRanges: z.array(z.string().min(1)),
  fixedVersions: z.array(z.string().min(1)),
  incidentStartsAt: z.number().int().nonnegative().nullable(),
  incidentEndsAt: z.number().int().nonnegative().nullable(),
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(z.string().min(1)),
  unknowns: z.array(z.string()),
}).strict();

export type AdvisoryDraft = z.infer<typeof advisoryDraftSchema>;

/**
 * Validates an AI-produced advisory draft without promoting it to vulnerability
 * truth. Exact affected versions remain the responsibility of OSV/manual input.
 */
export function validateAdvisoryDraft(
  raw: unknown,
  allowedEvidenceRefs: readonly string[],
): AdvisoryDraft {
  const parsed = advisoryDraftSchema.parse(raw);
  const allowed = new Set(allowedEvidenceRefs);
  if (parsed.evidenceRefs.some((reference) => !allowed.has(reference))) {
    throw new Error("Advisory draft cites evidence outside the approved bundle");
  }
  if (
    parsed.incidentStartsAt !== null &&
    parsed.incidentEndsAt !== null &&
    parsed.incidentEndsAt < parsed.incidentStartsAt
  ) {
    throw new Error("Advisory draft has an invalid incident interval");
  }
  return parsed;
}

export function deterministicAdvisoryDraft(input: {
  advisoryId: string;
  packageName: string;
  affectedRanges?: readonly string[];
  fixedVersions?: readonly string[];
  evidenceRefs: readonly string[];
}): AdvisoryDraft {
  return {
    advisoryId: input.advisoryId,
    ecosystem: "npm",
    packageNames: [input.packageName],
    affectedRanges: [...(input.affectedRanges ?? [])],
    fixedVersions: [...(input.fixedVersions ?? [])],
    incidentStartsAt: null,
    incidentEndsAt: null,
    confidence: 0.5,
    evidenceRefs: [...input.evidenceRefs],
    unknowns: ["Incident live-window timestamps require human confirmation."],
  };
}

