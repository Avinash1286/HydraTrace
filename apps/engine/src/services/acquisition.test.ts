import { describe, expect, it, vi } from "vitest";
import { acquireScanInput } from "./acquisition.js";

const lockfile = JSON.stringify({
  name: "archive-app",
  version: "1.0.0",
  lockfileVersion: 3,
  packages: { "": { name: "archive-app", version: "1.0.0" } },
});

describe("secure scan acquisition", () => {
  it("reads a bounded ZIP without extracting repository files", async () => {
    const archive = zip([{ path: "repo/package-lock.json", content: lockfile }]);
    const acquired = await acquireScanInput({
      mode: "zip",
      archiveBase64: archive.toString("base64"),
      repositoryId: "fixture/archive-app",
      commitSha: "abc123",
      observedAt: 10,
      environment: "production",
      deploymentStartedAt: 10,
    });

    expect(acquired).toMatchObject({
      content: lockfile,
      sourceRef: "package-lock.json",
      repositoryId: "fixture/archive-app",
      commitSha: "abc123",
    });
    expect(JSON.parse(acquired.deploymentManifest!)).toMatchObject({
      environment: "production",
      repositoryId: "fixture/archive-app",
    });
  });

  it("rejects archive path traversal before reading a lockfile", async () => {
    const archive = zip([{ path: "../package-lock.json", content: lockfile }]);
    await expect(acquireScanInput({
      mode: "zip",
      archiveBase64: archive.toString("base64"),
    })).rejects.toThrow(/relative path|Unsafe ZIP path/u);
  });

  it("pins a public GitHub scan to the resolved commit SHA", async () => {
    const archive = zip([
      { path: "repo-main/package-lock.json", content: lockfile },
      { path: "repo-main/package.json", content: JSON.stringify({
        name: "archive-app",
        version: "1.0.0",
        scripts: { start: "node src/server.js" },
      }) },
      { path: "repo-main/src/server.ts", content: 'import helper from "compromised-helper";' },
      { path: "repo-main/src/lazy.mts", content: 'export const lazy = import("optional-adapter");' },
      { path: "repo-main/node_modules/ignored/index.js", content: 'import "must-not-be-analyzed";' },
      { path: "repo-main/dist/server.js", content: 'import "must-not-be-analyzed-either";' },
      { path: "repo-main/scripts/release.sh", content: "echo never-run" },
    ]);
    const revision = "a".repeat(40);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sha: revision }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(archive, {
        status: 200,
        headers: { "content-length": String(archive.length) },
      }));

    const acquired = await acquireScanInput({
      mode: "repository",
      repositoryUrl: "https://github.com/example/archive-app",
      ref: "main",
    }, fetchMock);

    expect(acquired).toMatchObject({
      repositoryId: "example/archive-app",
      commitSha: revision,
      content: lockfile,
      staticAnalysis: {
        origin: "archive",
        entrypoints: ["src/server.ts"],
        files: [
          { path: "src/lazy.mts" },
          { path: "src/server.ts" },
        ],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves precomputed static and runtime evidence while replacing stale identity", async () => {
    const archive = zip([
      { path: "repo/package-lock.json", content: lockfile },
      { path: "repo/src/auto.ts", content: 'import "auto-package";' },
    ]);
    const acquired = await acquireScanInput({
      mode: "zip",
      archiveBase64: archive.toString("base64"),
      repositoryId: "fixture/archive-app",
      commitSha: "canonical-commit",
      observedAt: 10,
      staticAnalysis: {
        snapshotId: "123",
        repositoryId: "stale/repository",
        commitSha: "stale-commit",
        observedAt: 11,
        entrypoints: ["src/precomputed.ts"],
        files: [{ path: "src/precomputed.ts", source: 'require("fixture-package");' }],
      },
      runtimeTrace: {
        snapshotId: "456",
        runId: "fixture-run",
        startedAt: 12,
        command: "pnpm test",
        kind: "test",
        packages: [{
          name: "fixture-package",
          version: "1.0.0",
          firstLoadedAt: 13,
          loadCount: 1,
        }],
      },
    });

    expect(acquired.staticAnalysis).toEqual({
      origin: "precomputed",
      observedAt: 11,
      entrypoints: ["src/precomputed.ts"],
      files: [{ path: "src/precomputed.ts", source: 'require("fixture-package");' }],
    });
    expect(acquired.runtimeTrace).toMatchObject({ runId: "fixture-run", kind: "test" });
    expect(acquired.runtimeTrace).not.toHaveProperty("snapshotId");
  });

  it("blocks non-GitHub and credential-bearing repository URLs", async () => {
    await expect(acquireScanInput({
      mode: "repository",
      repositoryUrl: "https://127.0.0.1/repository/private",
    })).rejects.toThrow(/github\.com/u);
    await expect(acquireScanInput({
      mode: "repository",
      repositoryUrl: "https://token@github.com/example/repository",
    })).rejects.toThrow(/github\.com/u);
  });
});

interface ZipInput { path: string; content: string }

/** Minimal stored ZIP writer for deterministic acquisition tests. */
function zip(files: readonly ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const body = Buffer.from(file.content, "utf8");
    const checksum = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) === 0 ? 0 : 0xedb88320);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}
