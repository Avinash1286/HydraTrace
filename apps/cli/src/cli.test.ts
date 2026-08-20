import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("HydraTrace CLI", () => {
  it("accepts durable dispatch and acknowledgement stages while polling to completion", async () => {
    const observedStages = ["DISPATCHING", "ACKNOWLEDGED", "COMPLETE"] as const;
    let statusReads = 0;
    await withApi((method, path, response) => {
      if (method === "POST" && path === "/v1/scans") {
        respond(response, 202, { scanId: "dispatch-123", stage: "QUEUED" });
        return;
      }
      if (method === "GET" && path === "/v1/scans/dispatch-123") {
        const stage = observedStages[statusReads] ?? "COMPLETE";
        statusReads += 1;
        respond(response, 200, {
          scanId: "dispatch-123",
          stage,
          ...(stage === "COMPLETE" ? { result: { persisted: true } } : {}),
        });
        return;
      }
      respond(response, 404, { error: "NOT_FOUND" });
    }, async (api) => {
      const result = await runCli([
        "scan", "--lockfile", await fixtureLockfile(), "--api", api,
        "--poll-interval-ms", "5", "--timeout-ms", "1000",
      ]);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        scanId: "dispatch-123",
        stage: "COMPLETE",
        result: { persisted: true },
      });
      expect(statusReads).toBe(3);
    });
  });

  it("polls a durable queued scan through retry stages and prints only the terminal result", async () => {
    const requests: string[] = [];
    let statusReads = 0;
    await withApi((method, path, response) => {
      requests.push(`${method} ${path}`);
      if (method === "POST" && path === "/v1/scans") {
        respond(response, 202, { scanId: "123", stage: "QUEUED", attempt: 0 });
        return;
      }
      if (method === "GET" && path === "/v1/scans/123") {
        statusReads += 1;
        if (statusReads === 1) {
          respond(response, 200, { scanId: "123", stage: "RETRY_WAIT", attempt: 1 });
        } else {
          respond(response, 200, {
            scanId: "123",
            stage: "COMPLETE",
            attempt: 2,
            result: { counts: { resolutions: 4 } },
          });
        }
        return;
      }
      respond(response, 404, { error: "NOT_FOUND" });
    }, async (api) => {
      const lockfile = await fixtureLockfile();
      const result = await runCli([
        "scan", "--lockfile", lockfile, "--api", api,
        "--poll-interval-ms", "5", "--timeout-ms", "1000",
      ]);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        scanId: "123",
        stage: "COMPLETE",
        attempt: 2,
        result: { counts: { resolutions: 4 } },
      });
      expect(requests).toEqual([
        "POST /v1/scans",
        "GET /v1/scans/123",
        "GET /v1/scans/123",
      ]);
    });
  });

  it("returns scan-failure exit code 2 when a durable job fails", async () => {
    await withApi((method, path, response) => {
      if (method === "POST" && path === "/v1/scans") {
        respond(response, 202, { scanId: "456", stage: "QUEUED" });
      } else if (method === "GET" && path === "/v1/scans/456") {
        respond(response, 200, { scanId: "456", stage: "FAILED", error: "indexer unavailable" });
      } else {
        respond(response, 404, { error: "NOT_FOUND" });
      }
    }, async (api) => {
      const result = await runCli([
        "scan", "--lockfile", await fixtureLockfile(), "--api", api,
        "--poll-interval-ms", "5", "--timeout-ms", "1000",
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("scan 456 ended FAILED: indexer unavailable");
    });
  });

  it("bounds durable polling and returns scan-failure exit code 2 on timeout", async () => {
    await withApi((_method, _path, response) => {
      respond(response, 200, { scanId: "789", stage: "QUEUED" });
    }, async (api) => {
      const result = await runCli([
        "scan", "--lockfile", await fixtureLockfile(), "--api", api,
        "--poll-interval-ms", "5", "--timeout-ms", "50",
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("scan timed out after 50 ms");
    });
  });

  it("paginates every finding and preserves gate exit code 1 for a reachable high-risk exposure", async () => {
    const offsets: number[] = [];
    await withApi((method, path, response) => {
      if (method === "POST" && path === "/v1/incidents") {
        respond(response, 201, { incident: { id: "incident-1" } });
      } else if (method === "GET" && path.startsWith("/v1/incidents/incident-1/blast-radius?")) {
        const query = new URL(path, "http://fixture.invalid").searchParams;
        const offset = Number(query.get("offset"));
        offsets.push(offset);
        respond(response, 200, {
          totalFindings: 101,
          findings: offset === 0
            ? Array.from({ length: 100 }, (_, index) => gateFinding(`non-blocking-${index}`, "Low", 1))
            : [gateFinding("checkout", "High", 2)],
        });
      } else {
        respond(response, 404, { error: "NOT_FOUND" });
      }
    }, async (api) => {
      const result = await runCli([
        "gate", "--package", "vulnerable", "--version", "1.0.0",
        "--fail-on", "reachable-high", "--api", api,
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("reachable high-risk exposure");
      const output = JSON.parse(result.stdout) as { findings: Array<{ reachability: number }> };
      expect(output.findings).toHaveLength(101);
      expect(output.findings.at(-1)).toMatchObject({ reachability: 2 });
      expect(offsets).toEqual([0, 100]);
    });
  });

  it("does not classify unknown dynamic behavior as proven reachable", async () => {
    await withApi((method, path, response) => {
      if (method === "POST" && path === "/v1/incidents") {
        respond(response, 201, { incident: { id: "incident-unknown" } });
      } else if (method === "GET" && path.startsWith("/v1/incidents/incident-unknown/blast-radius?")) {
        respond(response, 200, {
          totalFindings: 1,
          findings: [gateFinding("unknown-service", "Critical", 5)],
        });
      } else {
        respond(response, 404, { error: "NOT_FOUND" });
      }
    }, async (api) => {
      const result = await runCli([
        "gate", "--package", "vulnerable", "--version", "1.0.0",
        "--fail-on", "reachable-high", "--api", api,
      ]);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ findings: [{ reachability: 5 }] });
    });
  });

  it("uses the atomic comparison endpoint and preserves BLOCK exit code 1", async () => {
    const paths: string[] = [];
    await withApi((method, path, response) => {
      paths.push(`${method} ${path}`);
      if (method === "POST" && path === "/v1/incidents") {
        respond(response, 201, { incident: { id: "321" } });
      } else if (method === "POST" && path === "/v1/incidents/321/comparison") {
        respond(response, 200, {
          comparison: {
            status: "BLOCK",
            baseline: comparisonSummary(0),
            current: comparisonSummary(1),
            newBlockingPaths: [{ signature: "new-path" }],
            reasons: [],
          },
        });
      } else {
        respond(response, 404, { error: "NOT_FOUND" });
      }
    }, async (api) => {
      const result = await runCli([
        "gate", "--package", "vulnerable", "--version", "1.0.0",
        "--baseline", `commit:${"a".repeat(40)}`,
        "--current", "b".repeat(40),
        "--repository", "fixture/repository",
        "--fail-on", "reachable-high", "--api", api,
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("new reachable high-risk path");
      expect(JSON.parse(result.stdout).comparison.status).toBe("BLOCK");
      expect(paths).toEqual([
        "POST /v1/incidents",
        "POST /v1/incidents/321/comparison",
      ]);
    });
  });

  it("fails closed with scan-failure exit code 2 for an inconclusive comparison", async () => {
    await withApi((method, path, response) => {
      if (method === "POST" && path === "/v1/incidents") {
        respond(response, 201, { incident: { id: "654" } });
      } else if (method === "POST" && path === "/v1/incidents/654/comparison") {
        respond(response, 200, {
          comparison: {
            status: "INCONCLUSIVE",
            baseline: comparisonSummary(0),
            current: comparisonSummary(0),
            newBlockingPaths: [],
            reasons: [{ code: "SCAN_SELECTOR_UNAVAILABLE" }],
          },
        });
      } else {
        respond(response, 404, { error: "NOT_FOUND" });
      }
    }, async (api) => {
      const result = await runCli([
        "gate", "--package", "vulnerable", "--version", "1.0.0",
        "--baseline", "scan:123", "--current", "snapshot:456", "--api", api,
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("inconclusive and failed closed");
      expect(JSON.parse(result.stdout).comparison.status).toBe("INCONCLUSIVE");
    });
  });

  it("refuses a malformed PASS response instead of silently opening the gate", async () => {
    await withApi((method, path, response) => {
      if (method === "POST" && path === "/v1/incidents") {
        respond(response, 201, { incident: { id: "777" } });
      } else if (method === "POST" && path === "/v1/incidents/777/comparison") {
        respond(response, 200, { comparison: { status: "PASS" } });
      } else {
        respond(response, 404, { error: "NOT_FOUND" });
      }
    }, async (api) => {
      const result = await runCli([
        "gate", "--package", "vulnerable", "--version", "1.0.0",
        "--baseline", "snapshot:123", "--current", "snapshot:456", "--api", api,
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).not.toBe("");
      expect(result.stderr).toContain("internally inconsistent baseline comparison");
    });
  });

  it("rejects mutable symbolic refs with configuration exit code 3 before network access", async () => {
    const result = await runCli([
      "gate", "--package", "vulnerable", "--version", "1.0.0",
      "--baseline", "main", "--current", "snapshot:123", "--fail-on", "reachable-high",
    ]);

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("symbolic refs");
  });
});

async function fixtureLockfile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hydratrace-cli-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "package-lock.json");
  await writeFile(path, JSON.stringify({
    name: "cli-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: { "": { name: "cli-fixture", version: "1.0.0" } },
  }), "utf8");
  return path;
}

async function withApi(
  handler: (method: string, path: string, response: ServerResponse) => void,
  run: (api: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    handler(request.method ?? "GET", request.url ?? "/", response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test API did not bind a TCP port");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
}

function respond(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function gateFinding(serviceId: string, risk: "Low" | "High" | "Critical", reachability: number): Record<string, unknown> {
  return {
    serviceId,
    environment: "production",
    affectedPackageName: "vulnerable",
    affectedVersion: "1.0.0",
    pathCount: 1,
    risk: { label: risk },
    reachability,
  };
}

function comparisonSummary(blockingPaths: number): Record<string, unknown> {
  return {
    evidenceFingerprint: "a".repeat(64),
    totalFindings: blockingPaths,
    totalPaths: blockingPaths,
    blockingPaths,
  };
}

function runCli(arguments_: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", cliPath, ...arguments_],
      {
        cwd: repositoryRoot,
        env: { ...process.env, NO_COLOR: "1" },
        encoding: "utf8",
        timeout: 5_000,
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : -1,
          stdout,
          stderr,
        });
      },
    );
  });
}
