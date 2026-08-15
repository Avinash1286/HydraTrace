import { describe, expect, it } from "vitest";
import { parsePackageLock } from "./package-lock.js";

const fixture = JSON.stringify({
  name: "checkout-api",
  version: "1.0.0",
  lockfileVersion: 3,
  packages: {
    "": {
      name: "checkout-api",
      version: "1.0.0",
      dependencies: { "checkout-framework": "1.0.0" },
      devDependencies: { "dev-tool": "1.0.0" },
    },
    "node_modules/checkout-framework": {
      version: "1.0.0",
      dependencies: { "telemetry-core": "2.0.0" },
    },
    "node_modules/telemetry-core": {
      version: "2.0.0",
      dependencies: { "compromised-helper": "1.4.2" },
    },
    "node_modules/compromised-helper": { version: "1.4.2" },
    "node_modules/dev-tool": {
      version: "1.0.0",
      dev: true,
      dependencies: { "compromised-helper": "1.4.2" },
    },
  },
});

const options = {
  repositoryId: "repository:acme/checkout-api",
  commitSha: "abc123",
  sourceRef: "package-lock.json",
  observedAt: 1_786_700_000_000,
} as const;

describe("package-lock parser", () => {
  it("normalizes exact instances and transitive edges", () => {
    const result = parsePackageLock(fixture, options);

    expect(result.packages).toHaveLength(5);
    expect(result.resolutions).toHaveLength(5);
    expect(result.edges).toHaveLength(5);
    expect(result.warnings).toEqual([]);

    const framework = result.resolutions.find(
      (resolution) => resolution.packageName === "checkout-framework",
    );
    const devTool = result.resolutions.find(
      (resolution) => resolution.packageName === "dev-tool",
    );
    expect(framework?.direct).toBe(true);
    expect(devTool).toMatchObject({ direct: true, dev: true });
  });

  it("returns identical canonical identifiers on repeated parsing", () => {
    const first = parsePackageLock(fixture, options);
    const second = parsePackageLock(fixture, { ...options, observedAt: options.observedAt + 1 });

    expect(second.snapshot.id).toBe(first.snapshot.id);
    expect(second.resolutions.map(({ id }) => id)).toEqual(
      first.resolutions.map(({ id }) => id),
    );
    expect(second.edges.map(({ id }) => id)).toEqual(first.edges.map(({ id }) => id));
  });

  it("resolves nested packages before hoisted packages", () => {
    const nested = JSON.stringify({
      lockfileVersion: 2,
      packages: {
        "": { dependencies: { parent: "1.0.0" } },
        "node_modules/parent": {
          version: "1.0.0",
          dependencies: { child: "2.0.0" },
        },
        "node_modules/child": { version: "1.0.0" },
        "node_modules/parent/node_modules/child": { version: "2.0.0" },
      },
    });
    const result = parsePackageLock(nested, options);
    const parent = result.resolutions.find((resolution) => resolution.packageName === "parent");
    const targetEdge = result.edges.find((edge) => edge.fromResolutionId === parent?.id);
    const target = result.resolutions.find(
      (resolution) => resolution.id === targetEdge?.toResolutionId,
    );

    expect(target?.installPath).toBe("node_modules/parent/node_modules/child");
    expect(target?.version).toBe("2.0.0");
  });
});
