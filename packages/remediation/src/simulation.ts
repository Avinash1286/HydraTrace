import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePackageLock } from "@hydratrace/lockfile-parsers";
import type { StableId } from "@hydratrace/domain";
import type { LockfileSimulationInput, LockfileSimulationResult } from "./models.js";

export async function simulateNpmLockfile(input: LockfileSimulationInput): Promise<LockfileSimulationResult> {
  const directory = await mkdtemp(join(tmpdir(), "hydratrace-remediation-"));
  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "--package-lock-only", "--ignore-scripts", "--audit=false", "--fund=false", "--no-update-notifier"];
  try {
    const manifest = JSON.parse(input.packageJson) as Record<string, unknown>;
    updateDependency(manifest, input.dependencyName, input.toVersion);
    await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(join(directory, "package-lock.json"), input.packageLock, "utf8");
    const execution = await run(npmExecutable, args, directory, input.timeoutMs ?? 60_000);
    const resultingPackageLock = await readFile(join(directory, "package-lock.json"), "utf8");
    const affectedPathCount = countAffectedPaths(resultingPackageLock, input);
    return {
      command: [npmExecutable, ...args],
      exitCode: execution.exitCode,
      affectedPathCount,
      lockfileChurn: lockfileChurn(input.packageLock, resultingPackageLock),
      verification: execution.exitCode === 0 && affectedPathCount === 0 ? "LOCKFILE_VERIFIED" : "FAILED",
      stdout: execution.stdout,
      stderr: execution.stderr,
      resultingPackageLock,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function updateDependency(manifest: Record<string, unknown>, name: string, version: string): void {
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = manifest[key];
    if (dependencies !== null && typeof dependencies === "object" && name in dependencies) {
      (dependencies as Record<string, unknown>)[name] = version; return;
    }
  }
  throw new Error(`Direct dependency ${name} was not found in package.json`);
}

function countAffectedPaths(content: string, input: LockfileSimulationInput): number {
  const normalized = parsePackageLock(content, { repositoryId: input.repositoryId, commitSha: input.commitSha, sourceRef: "package-lock.json", observedAt: Date.now() });
  const targetVersions = new Set(normalized.packages.filter(({ normalizedName, version }) => normalizedName === input.affectedPackageName.toLowerCase() && input.affectedVersions.includes(version)).map(({ id }) => id));
  const targetResolutions = new Set(normalized.resolutions.filter(({ packageVersionId }) => targetVersions.has(packageVersionId)).map(({ id }) => id));
  const adjacency = new Map<StableId, StableId[]>(); for (const edge of normalized.edges) { const list = adjacency.get(edge.fromResolutionId) ?? []; list.push(edge.toResolutionId); adjacency.set(edge.fromResolutionId, list); }
  let count = 0; const pending = normalized.resolutions.filter(({ root }) => root).map(({ id }) => [id]);
  while (pending.length > 0) { const path = pending.shift()!; const current = path.at(-1)!; if (targetResolutions.has(current)) count += 1; if (path.length > 17) continue; for (const next of adjacency.get(current) ?? []) if (!path.includes(next)) pending.push([...path, next]); }
  return count;
}

function lockfileChurn(before: string, after: string): number { const left = before.split(/\r?\n/u); const right = after.split(/\r?\n/u); const length = Math.max(left.length, right.length); let changed = 0; for (let index = 0; index < length; index += 1) if (left[index] !== right[index]) changed += 1; return changed; }
function run(command: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> { return new Promise((resolve, reject) => { const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: safeChildEnvironment(cwd) }); let stdout = ""; let stderr = ""; const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs); child.stdout.on("data", (chunk) => { if (stdout.length < 100_000) stdout += String(chunk); }); child.stderr.on("data", (chunk) => { if (stderr.length < 100_000) stderr += String(chunk); }); child.once("error", reject); child.once("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? -1, stdout, stderr }); }); }); }

function safeChildEnvironment(cwd: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    npm_config_cache: join(cwd, ".npm-cache"),
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    NODE_OPTIONS: "--max-old-space-size=256",
  };
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}
