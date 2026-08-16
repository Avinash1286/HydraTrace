import { describe, expect, it } from "vitest";
import { PackageIntelligenceCatalog, damerauLevenshtein } from "./neighborhood.js";

describe("package neighborhood intelligence", () => {
  it("returns evidence-backed indicators without claiming maliciousness", () => {
    const catalog = new PackageIntelligenceCatalog();
    catalog.register({
      name: "lodash",
      version: "4.17.21",
      maintainers: [{ email: "maintainer@example.com" }],
      repositoryUrl: "https://github.com/lodash/lodash",
      weeklyDownloads: 50_000_000,
    });
    catalog.register({
      name: "lodahs",
      version: "1.0.0",
      maintainers: [{ email: "maintainer@example.com" }],
      repositoryUrl: "https://github.com/example/lodahs",
      weeklyDownloads: 10,
    });
    const neighborhood = catalog.neighborhood("lodash", "4.17.21");
    expect(neighborhood.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "SHARED_MAINTAINER", indicatorOnly: true }),
      expect.objectContaining({ type: "SHARED_INFRASTRUCTURE", indicatorOnly: true }),
      expect.objectContaining({ type: "SIMILAR_NAME", indicatorOnly: true }),
    ]));
  });

  it("handles adjacent transpositions", () => {
    expect(damerauLevenshtein("lodash", "lodahs")).toBe(1);
  });
});
