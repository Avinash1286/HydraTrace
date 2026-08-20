import { InMemoryGraphStore } from "@hydratrace/hydradb-client";
import { describe, expect, it } from "vitest";
import { buildEngine } from "./engine.js";

describe("archive source scan", () => {
  it("rejects unsafe or ambiguous precomputed source paths", async () => {
    const graphStore = new InMemoryGraphStore();
    const application = buildEngine({
      graphStore,
      scanEnrichmentEnabled: false,
    });
    const response = await application.inject({
      method: "POST",
      url: "/v1/scans",
      body: {
        mode: "lockfile",
        content: packageLock(),
        sourceRef: "package-lock.json",
        repositoryId: "fixture/unsafe-source",
        commitSha: "unsafe-source",
        observedAt: 1,
        staticAnalysis: {
          entrypoints: ["../src/server.ts"],
          files: [
            { path: "src/server.ts", source: "export {};" },
            { path: "./src/server.ts", source: "export {};" },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "INVALID_SCAN" });
    await application.close();
  });

  it("automatically carries static-import evidence into incident results", async () => {
    const observedAt = Date.parse("2026-08-15T09:00:00.000Z");
    const archive = zip([
      { path: "fixture/package-lock.json", content: packageLock() },
      { path: "fixture/package.json", content: JSON.stringify({
        name: "source-app",
        version: "1.0.0",
        scripts: { start: "node src/server.js" },
      }) },
      { path: "fixture/src/server.ts", content: 'import helper from "compromised-helper"; helper();' },
      { path: "fixture/src/dead.ts", content: 'import "unreachable-package";' },
    ]);
    const graphStore = new InMemoryGraphStore();
    const application = buildEngine({
      graphStore,
      scanEnrichmentEnabled: false,
    });

    const scan = await application.inject({
      method: "POST",
      url: "/v1/scans",
      body: {
        mode: "zip",
        archiveBase64: archive.toString("base64"),
        repositoryId: "fixture/source-app",
        commitSha: "source-commit",
        observedAt,
        environment: "production",
        deploymentStartedAt: observedAt,
      },
    });
    expect(scan.statusCode, scan.body).toBe(201);
    expect(scan.json().result.reachability).toEqual({
      evidenceAccepted: 1,
      staticAnalysis: {
        origin: "archive",
        analyzedFiles: 1,
        packageObservations: 1,
        unknownDynamicBehavior: false,
        evidenceAccepted: 1,
      },
    });

    const incident = await application.inject({
      method: "POST",
      url: "/v1/incidents",
      body: {
        ecosystem: "npm",
        packageName: "compromised-helper",
        affectedVersions: ["1.4.2"],
        startsAt: observedAt - 1,
        environments: ["production"],
      },
    });
    expect(incident.statusCode, incident.body).toBe(201);
    const blast = await application.inject({
      method: "GET",
      url: `/v1/incidents/${incident.json().incident.id}/blast-radius?at=${observedAt}`,
    });
    expect(blast.statusCode, blast.body).toBe(200);
    expect(blast.json().findings).toEqual([
      expect.objectContaining({
        serviceId: "source-app",
        reachability: 2,
        reachabilityEvidence: [
          expect.objectContaining({ source: "static", evidenceRefs: [expect.stringMatching(/^E-STATIC-/u)] }),
        ],
      }),
    ]);
    await application.close();
    const restarted = buildEngine({ graphStore, scanEnrichmentEnabled: false });
    const durableBlast = await restarted.inject({
      method: "GET",
      url: `/v1/incidents/${incident.json().incident.id}/blast-radius?at=${observedAt}`,
    });
    expect(durableBlast.statusCode, durableBlast.body).toBe(200);
    expect(durableBlast.json().findings[0]).toMatchObject({
      serviceId: "source-app",
      reachability: 2,
      reachabilityEvidence: [expect.objectContaining({ source: "static" })],
    });
    await restarted.close();
  });
});

function packageLock(): string {
  return JSON.stringify({
    name: "source-app",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "source-app",
        version: "1.0.0",
        dependencies: { "compromised-helper": "1.4.2" },
      },
      "node_modules/compromised-helper": { version: "1.4.2" },
    },
  });
}

interface ZipInput { path: string; content: string }

/** Minimal stored ZIP writer; test content is inert and never extracted. */
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
