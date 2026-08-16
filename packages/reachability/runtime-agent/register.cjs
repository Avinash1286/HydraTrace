const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

const originalLoad = Module._load;
const observations = new Map();
const startedAt = Date.now();
const output = process.env.HYDRATRACE_TRACE_FILE || "hydratrace-runtime-trace.json";

Module._load = function hydratraceLoad(request, parent, isMain) {
  const exported = originalLoad.apply(this, arguments);
  try {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const metadata = nearestPackage(resolved);
    if (metadata) record(metadata.name, metadata.version);
  } catch {
    // Module loading already succeeded. Evidence collection must never break the app.
  }
  return exported;
};

process.once("exit", () => {
  const trace = {
    runId: process.env.HYDRATRACE_RUN_ID || `runtime-${process.pid}-${startedAt}`,
    startedAt,
    command: process.argv.join(" "),
    kind: process.env.HYDRATRACE_TRACE_KIND === "runtime" ? "runtime" : "test",
    snapshotId: process.env.HYDRATRACE_SNAPSHOT_ID,
    packages: [...observations.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)),
  };
  fs.writeFileSync(output, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
});

function record(name, version) {
  const key = `${name}@${version}`;
  const existing = observations.get(key);
  if (existing) existing.loadCount += 1;
  else observations.set(key, { name, version, firstLoadedAt: Date.now(), loadCount: 1 });
}

function nearestPackage(filename) {
  if (typeof filename !== "string" || !path.isAbsolute(filename)) return undefined;
  let directory = path.dirname(filename);
  for (;;) {
    const manifest = path.join(directory, "package.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (typeof parsed.name === "string" && typeof parsed.version === "string") return parsed;
    } catch {}
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
