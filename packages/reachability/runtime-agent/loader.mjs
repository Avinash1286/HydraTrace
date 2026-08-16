import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const output = process.env.HYDRATRACE_TRACE_FILE || "hydratrace-runtime-trace.jsonl";
const seen = new Set();

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith("file:")) {
    const metadata = nearestPackage(fileURLToPath(result.url));
    if (metadata) record(metadata.name, metadata.version, result.url);
  }
  return result;
}

function record(name, version, url) {
  const key = `${name}@${version}`;
  if (seen.has(key)) return;
  seen.add(key);
  const event = {
    runId: process.env.HYDRATRACE_RUN_ID || `runtime-esm-${process.pid}`,
    observedAt: Date.now(),
    kind: process.env.HYDRATRACE_TRACE_KIND === "runtime" ? "runtime" : "test",
    snapshotId: process.env.HYDRATRACE_SNAPSHOT_ID,
    package: { name, version, url },
  };
  fs.appendFileSync(output, `${JSON.stringify(event)}\n`, "utf8");
}

function nearestPackage(filename) {
  let directory = path.dirname(filename);
  for (;;) {
    const manifest = path.join(directory, "package.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (typeof parsed.name === "string" && typeof parsed.version === "string") {
        return parsed;
      }
    } catch {
      // Continue to the parent. Evidence collection must not break loading.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
