import { describe, expect, it } from "vitest";
import { analyzeStaticImports } from "./static-analyzer.js";

describe("static reachability", () => {
  it("walks only reachable source modules and identifies exact package imports", () => {
    const result = analyzeStaticImports({
      repositoryId: "acme/checkout",
      commitSha: "abc",
      entrypoints: ["src/server.ts"],
      files: [
        { path: "src/server.ts", source: 'import "./checkout.js"; import fastify from "fastify";' },
        { path: "src/checkout.ts", source: 'const helper = require("compromised-helper/subpath"); export { helper };' },
        { path: "src/dead.ts", source: 'import "not-reachable";' },
      ],
    });
    expect(result.analyzedFiles).toEqual(["src/checkout.ts", "src/server.ts"]);
    expect(result.unreachableFiles).toEqual(["src/dead.ts"]);
    expect(result.packages.map(({ packageName }) => packageName)).toEqual([
      "compromised-helper",
      "fastify",
    ]);
    expect(result.unknownDynamicBehavior).toBe(false);
  });

  it("abstains when a reachable dynamic import cannot be resolved", () => {
    const result = analyzeStaticImports({
      repositoryId: "acme/worker",
      commitSha: "def",
      entrypoints: ["worker.ts"],
      files: [{ path: "worker.ts", source: "await import(process.env.ADAPTER);" }],
    });
    expect(result.unknownDynamicBehavior).toBe(true);
    expect(result.unknownExpressions[0]).toMatchObject({
      file: "worker.ts",
      expression: "process.env.ADAPTER",
    });
  });

  it("resolves modern module extensions and excludes Node built-ins", () => {
    const result = analyzeStaticImports({
      repositoryId: "acme/modern-worker",
      commitSha: "ghi",
      entrypoints: ["src/worker.mts"],
      files: [
        { path: "src/worker.mts", source: 'import "./handler.mjs"; import assert from "assert/strict";' },
        { path: "src/handler.mts", source: 'import adapter from "external-adapter"; export { adapter };' },
      ],
    });
    expect(result.analyzedFiles).toEqual(["src/handler.mts", "src/worker.mts"]);
    expect(result.packages.map(({ packageName }) => packageName)).toEqual(["external-adapter"]);
  });
});
