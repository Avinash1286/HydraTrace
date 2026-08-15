import { describe, expect, it } from "vitest";
import {
  canonicalKeys,
  normalizeNpmPackageName,
  sha256Hex,
  stableIdFromCanonicalKey,
} from "./ids.js";

describe("stable graph identifiers", () => {
  it("is deterministic and inside the nonnegative signed 63-bit range", () => {
    const key = canonicalKeys.packageVersion("npm", "lodash", "4.17.21");
    const first = stableIdFromCanonicalKey(key);
    const second = stableIdFromCanonicalKey(key);

    expect(first).toBe(second);
    expect(BigInt(first)).toBeGreaterThanOrEqual(0n);
    expect(BigInt(first)).toBeLessThanOrEqual((1n << 63n) - 1n);
  });

  it("canonicalizes npm package names", () => {
    expect(normalizeNpmPackageName("  @Scope/Package ")).toBe("@scope/package");
    expect(canonicalKeys.package("npm", "Lodash")).toBe("npm:package:lodash");
  });

  it("hashes lockfile content reproducibly", () => {
    expect(sha256Hex("hydratrace")).toMatch(/^[a-f\d]{64}$/);
    expect(sha256Hex("hydratrace")).toBe(sha256Hex("hydratrace"));
  });
});
