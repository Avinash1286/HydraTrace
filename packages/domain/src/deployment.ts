import { z } from "zod";
import {
  canonicalKeys,
  stableIdFromCanonicalKey,
} from "./ids.js";
import type { DeploymentManifest } from "./models.js";
import { assertSha256 } from "./validation.js";

const deploymentInputSchema = z.object({
  schemaVersion: z.literal(1),
  organizationId: z.string().trim().min(1),
  repositoryId: z.string().trim().min(1),
  serviceId: z.string().trim().min(1),
  environment: z.string().trim().min(1),
  criticality: z
    .enum(["production", "staging", "development", "unknown"])
    .optional(),
  commitSha: z.string().trim().min(1),
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }).nullable(),
  lockfile: z.string().trim().min(1),
});

export function parseDeploymentManifest(
  rawContent: string,
  lockfileSha256: string,
): DeploymentManifest {
  assertSha256(lockfileSha256, "lockfileSha256");
  let value: unknown;
  try {
    value = JSON.parse(rawContent) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid deployment manifest JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = deploymentInputSchema.parse(value);
  const startedAt = Date.parse(parsed.startedAt);
  const endedAt = parsed.endedAt === null ? null : Date.parse(parsed.endedAt);
  if (endedAt !== null && endedAt <= startedAt) {
    throw new Error("Deployment endedAt must be later than startedAt");
  }
  const criticality =
    parsed.criticality ?? inferCriticality(parsed.environment.toLowerCase());
  const deploymentId = stableIdFromCanonicalKey(
    canonicalKeys.deployment(
      parsed.serviceId,
      parsed.environment,
      parsed.commitSha,
      startedAt,
    ),
  );

  return {
    schemaVersion: 1,
    organizationId: parsed.organizationId,
    repositoryId: parsed.repositoryId,
    serviceId: parsed.serviceId,
    deploymentId,
    environment: parsed.environment,
    criticality,
    commitSha: parsed.commitSha,
    lockfile: parsed.lockfile,
    lockfileSha256: lockfileSha256.toLowerCase(),
    startedAt,
    endedAt,
  };
}

function inferCriticality(environment: string): DeploymentManifest["criticality"] {
  if (environment === "production" || environment === "prod") return "production";
  if (environment === "staging" || environment === "stage") return "staging";
  if (environment === "development" || environment === "dev") return "development";
  return "unknown";
}
