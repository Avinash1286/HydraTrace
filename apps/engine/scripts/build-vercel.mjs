import { build } from "esbuild";

await build({
  entryPoints: ["api/_entry.ts"],
  outfile: "api/index.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: {
    js: "import { createRequire as __hydratraceCreateRequire } from 'node:module'; import { fileURLToPath as __hydratraceFileURLToPath } from 'node:url'; import { dirname as __hydratraceDirname } from 'node:path'; const require = __hydratraceCreateRequire(import.meta.url); const __filename = __hydratraceFileURLToPath(import.meta.url); const __dirname = __hydratraceDirname(__filename);",
  },
});
