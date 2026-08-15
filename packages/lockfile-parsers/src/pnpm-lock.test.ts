import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePnpmLock } from "./pnpm-lock.js";

const fixturePath = fileURLToPath(
  new URL("../../../fixtures/acme-commerce/analytics-dashboard/pnpm-lock.yaml", import.meta.url),
);

const options = {
  repositoryId: "acme-commerce/analytics-dashboard",
  commitSha: "cccccccccccccccccccccccccccccccccccccccc",
  sourceRef: "pnpm-lock.yaml",
  observedAt: 1_786_706_400_000,
  rootPackage: { name: "@acme/analytics-dashboard", version: "1.0.0" },
} as const;

describe("pnpm lockfile parser", () => {
  it("preserves peer contexts, optional edges, and dev-only reachability", async () => {
    const content = await readFile(fixturePath, "utf8");
    const result = parsePnpmLock(content, options);

    expect(result.packages).toHaveLength(7);
    expect(result.resolutions).toHaveLength(7);
    expect(result.edges).toHaveLength(7);
    expect(result.warnings).toEqual([]);

    const affectedVersions = result.resolutions.filter(
      (resolution) =>
        resolution.packageName === "compromised-helper" && resolution.version === "1.4.2",
    );
    const safeVersion = result.resolutions.find(
      (resolution) =>
        resolution.packageName === "compromised-helper" && resolution.version === "1.4.3",
    );
    const peerContext = result.resolutions.find((resolution) =>
      resolution.sourceKey.startsWith("chart-wrapper@"),
    );
    expect(affectedVersions).toHaveLength(1);
    expect(affectedVersions[0]?.dev).toBe(true);
    expect(safeVersion?.dev).toBe(false);
    expect(peerContext?.peer).toBe(true);
    expect(result.edges.some((edge) => edge.kind === "peer")).toBe(true);
    expect(result.edges.some((edge) => edge.kind === "optional")).toBe(true);
  });

  it("materializes workspace links instead of discarding them", () => {
    const content = `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      local-lib:\n        specifier: workspace:*\n        version: link:../local-lib\npackages: {}\nsnapshots: {}\n`;
    const result = parsePnpmLock(content, {
      ...options,
      sourceRef: "workspace-pnpm-lock.yaml",
    });

    expect(result.warnings).toEqual([]);
    expect(result.resolutions.find((resolution) => resolution.packageName === "local-lib")).toMatchObject({
      direct: true,
      installPath: "link:../local-lib",
    });
    expect(result.edges).toHaveLength(1);
  });
});
