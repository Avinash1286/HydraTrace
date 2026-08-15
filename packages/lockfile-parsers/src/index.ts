export * from "./package-lock.js";
export * from "./pnpm-lock.js";

import type { LockfileParserOptions, NormalizedSnapshot } from "@hydratrace/domain";
import { parsePackageLock } from "./package-lock.js";
import { parsePnpmLock } from "./pnpm-lock.js";

export function parseLockfile(
  rawContent: string,
  options: LockfileParserOptions,
): NormalizedSnapshot {
  const sourceRef = options.sourceRef.toLowerCase();
  if (sourceRef.endsWith("package-lock.json")) return parsePackageLock(rawContent, options);
  if (sourceRef.endsWith("pnpm-lock.yaml") || sourceRef.endsWith("pnpm-lock.yml")) {
    return parsePnpmLock(rawContent, options);
  }
  throw new Error(`Unsupported lockfile: ${options.sourceRef}`);
}
