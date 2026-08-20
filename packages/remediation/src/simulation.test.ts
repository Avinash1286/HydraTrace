import { describe, expect, it } from "vitest";
import { NPM_LOCKFILE_SIMULATION_ARGS } from "./simulation.js";

describe("lockfile simulation command boundary", () => {
  it("is lockfile-only and disables every npm lifecycle script", () => {
    expect(NPM_LOCKFILE_SIMULATION_ARGS).toEqual([
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--audit=false",
      "--fund=false",
      "--no-update-notifier",
    ]);
  });
});
