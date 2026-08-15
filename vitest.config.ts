import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@hydratrace/domain": fromRoot("./packages/domain/src/index.ts"),
      "@hydratrace/graph-schema": fromRoot("./packages/graph-schema/src/index.ts"),
      "@hydratrace/lockfile-parsers": fromRoot("./packages/lockfile-parsers/src/index.ts"),
      "@hydratrace/hydradb-client": fromRoot("./packages/hydradb-client/src/index.ts"),
      "@hydratrace/ecosystem-enrichment": fromRoot(
        "./packages/ecosystem-enrichment/src/index.ts",
      ),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
