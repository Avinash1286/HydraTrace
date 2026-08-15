import { z } from "zod";

export const lockfileParserOptionsSchema = z.object({
  repositoryId: z.string().trim().min(1),
  commitSha: z.string().trim().min(1),
  sourceRef: z.string().trim().min(1),
  observedAt: z.number().int().nonnegative(),
  parserVersion: z.string().trim().min(1).optional(),
  importRunId: z.string().regex(/^\d+$/).optional(),
  rootPackage: z
    .object({
      name: z.string().trim().min(1),
      version: z.string().trim().min(1),
    })
    .optional(),
});

export function assertSha256(value: string, fieldName = "sha256"): void {
  if (!/^[a-f\d]{64}$/i.test(value)) {
    throw new Error(`${fieldName} must be a 64-character hexadecimal SHA-256 digest`);
  }
}
