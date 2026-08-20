import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createHydraDbSmokeFixture,
  HydraDbGraphStore,
  hydraDbConnectionOptionsFromEnv,
} from "@hydratrace/hydradb-client";

const root = resolve(import.meta.dirname, "../../../..");
const composeFile = resolve(root, "infra/local/docker-compose.yml");
const secretPath = resolve(root, "infra/local/secrets/auth-token");
const composeEnvironment = {
  ...process.env,
  // Every run gets a clean durable prefix, so the gate proves a fresh index
  // publication without deleting or depending on data from an earlier run.
  HYDRATRACE_LOCAL_GRAPH_DATA_PATH: `development/gates/${randomBytes(12).toString("hex")}/slatedb-graph/data`,
};

let token: string;
try {
  token = (await readFile(secretPath, "utf8")).trim();
} catch {
  await mkdir(dirname(secretPath), { recursive: true });
  token = randomBytes(48).toString("base64");
  await writeFile(secretPath, token, { encoding: "utf8", flag: "wx" });
}
if (token.length < 32) {
  throw new Error("HydraDB auth token must contain at least 32 characters");
}

await command(
  "docker",
  ["compose", "-f", composeFile, "up", "-d", "hydradb-node"],
  composeEnvironment,
);
await waitReady("http://127.0.0.1:9090/readyz", 60_000);
const environment = {
  ...process.env,
  HYDRADB_BOLT_URI: "bolt://127.0.0.1:7687",
  HYDRADB_HTTP_URL: "http://127.0.0.1:8443",
  HYDRADB_ADMIN_URL: "http://127.0.0.1:9090",
  HYDRADB_GRAPH_ID: "default",
  HYDRADB_CELL_ID: "cell-0",
  HYDRADB_NAMESPACE: "development",
  HYDRADB_AUTH_TOKEN: token,
};
// HydraDB v0.1.1's local HTTP path procedure can spend several minutes warming
// object-store state even for this four-node fixture. Keep the causal smoke and
// property gates on the serialized Bolt adapter, then prove the required strong
// HTTP path separately below.
const causalBoltEnvironment = {
  ...environment,
  HYDRADB_HTTP_URL: undefined,
  HYDRADB_CONSISTENCY: "causal",
};
await command(
  "docker",
  [
    "compose",
    "-f",
    composeFile,
    "up",
    "-d",
    "--force-recreate",
    "hydradb-indexer",
  ],
  composeEnvironment,
);
// Recreate the indexer so its process counters start at zero. A single healthy
// cycle then proves this run, instead of accidentally accepting an old metric
// or waiting for three full rebuilds on a slow Docker Desktop host.
const emptyCycles = await waitIndexer(1, 120_000, false);
await pnpmSmoke(causalBoltEnvironment);
const publishedCycles = await waitIndexer(emptyCycles + 1, 120_000, true);
await command(
  "docker",
  ["compose", "-f", composeFile, "restart", "hydradb-node"],
  composeEnvironment,
);
await waitReady("http://127.0.0.1:9090/readyz", 60_000);
await pnpmSmoke(causalBoltEnvironment);
await waitIndexer(publishedCycles + 1, 120_000, true);
await strongPathProbe(environment);
await pnpmPropertyGate(causalBoltEnvironment);
process.stdout.write(
  "HydraDB persistence, idempotency, indexing, and three-hop path gate passed.\n",
);

async function waitReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "unavailable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      last = `HTTP ${response.status}`;
      if (response.ok) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(2_000);
  }
  throw new Error(`${url} was not ready: ${last}`);
}

async function waitIndexer(
  minimumCycles: number,
  timeoutMs: number,
  requireDependencyGeneration: boolean,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = "unavailable";
  while (Date.now() < deadline) {
    try {
      const [health, metricsResponse] = await Promise.all([
        fetch("http://127.0.0.1:9091/readyz", {
          signal: AbortSignal.timeout(2_000),
        }),
        fetch("http://127.0.0.1:9091/metrics", {
          signal: AbortSignal.timeout(2_000),
        }),
      ]);
      const metrics = await metricsResponse.text();
      const ready = metric(metrics, "graph_indexer_ready");
      const successes = metric(metrics, "graph_indexer_successful_cycles");
      const failures = metric(metrics, "graph_indexer_consecutive_failed_cycles");
      const generations = dependencyGenerations(metrics);
      last = `ready=${ready} successful=${successes} failures=${failures} generations=${generations}`;
      if (
        health.ok &&
        ready === 1 &&
        successes >= minimumCycles &&
        failures === 0 &&
        (!requireDependencyGeneration || generations >= 1)
      ) {
        return successes;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(2_000);
  }
  throw new Error(`HydraDB indexer was not healthy: ${last}`);
}

function dependencyGenerations(text: string): number {
  const samples = text.matchAll(
    /^graph_indexer_generations_published\{[^}]*edge_type="DEPENDS_ON_INSTANCE"[^}]*\}\s+([0-9]+(?:\.[0-9]+)?)$/gmu,
  );
  let total = 0;
  let found = false;
  for (const sample of samples) {
    found = true;
    total += Number(sample[1]);
  }
  return found ? total : Number.NaN;
}

function metric(text: string, name: string): number {
  const match = text.match(
    new RegExp(`^${name}\\s+([0-9]+(?:\\.[0-9]+)?)$`, "mu"),
  );
  return match === null ? Number.NaN : Number(match[1]);
}

async function strongPathProbe(env: NodeJS.ProcessEnv): Promise<void> {
  const store = HydraDbGraphStore.connect(
    hydraDbConnectionOptionsFromEnv({
      ...env,
      HYDRADB_CONSISTENCY: "strong",
    }),
  );
  try {
    const fixture = createHydraDbSmokeFixture();
    let paths: Awaited<ReturnType<typeof store.findPaths>> | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        paths = await store.findPaths({
          from: { id: fixture.expectedPath[0]!, label: "Resolution" },
          to: { id: fixture.expectedPath.at(-1)!, label: "Resolution" },
          relationshipType: "DEPENDS_ON_INSTANCE",
          minDepth: 3,
          maxDepth: 3,
          limit: 2,
        });
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          attempt === 3 ||
          !/(?:HTTP 408|query timeout|TimeoutError|aborted due to timeout)/iu.test(
            message,
          )
        ) {
          throw error;
        }
        process.stdout.write(
          `HydraDB strong-read path timed out during cold cache warm-up; retrying (${attempt}/3).\n`,
        );
        await delay(5_000);
      }
    }
    if (paths === undefined) {
      throw new Error("HydraDB strong-read path did not return a result");
    }
    const path = paths[0];
    if (
      paths.length !== 1 ||
      path?.nodeIds.join(",") !== fixture.expectedPath.join(",") ||
      path.relationshipIds.join(",") !== fixture.expectedRelationshipIds.join(",")
    ) {
      throw new Error(
        "HydraDB strong-read path did not match the persisted three-hop fixture",
      );
    }
    process.stdout.write("HydraDB strong-read three-hop path verified.\n");
  } finally {
    await store.close();
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function pnpmSmoke(env: NodeJS.ProcessEnv): Promise<void> {
  return process.platform === "win32"
    ? command(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", "pnpm smoke:hydradb"],
        env,
        180_000,
      )
    : command("pnpm", ["smoke:hydradb"], env, 180_000);
}

function pnpmPropertyGate(env: NodeJS.ProcessEnv): Promise<void> {
  return process.platform === "win32"
    ? command(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", "pnpm property:hydradb"],
        env,
        180_000,
      )
    : command("pnpm", ["property:hydradb"], env, 180_000);
}

function command(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 120_000,
): Promise<void> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env,
      shell: false,
      windowsHide: true,
      stdio: "inherit",
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid !== undefined) {
        const killer = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/t", "/f"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.unref();
      } else {
        child.kill("SIGTERM");
      }
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new Error(
            `${executable} ${args.join(" ")} timed out after ${timeoutMs}ms`,
          ),
        );
      } else if (code === 0) {
        resolveCommand();
      } else {
        reject(
          new Error(
            `${executable} ${args.join(" ")} failed with exit code ${code}`,
          ),
        );
      }
    });
  });
}
