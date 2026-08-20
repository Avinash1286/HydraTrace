import { stableIdFromCanonicalKey, type StableId } from "@hydratrace/domain";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "../../../../convex/_generated/dataModel.js";
import {
  type DurableScanBackend,
  type DurableScanEvent,
  type DurableScanRecord,
  type DurableScanSnapshot,
} from "./convex-scan-backend.js";
import {
  registerScanWorkflowRoutes,
  type ScanWorkflowInput,
} from "./scans.js";

const resolvedInput: ScanWorkflowInput = {
  content: JSON.stringify({
    name: "durable-app",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: { "": { name: "durable-app", version: "1.0.0" } },
  }),
  sourceRef: "package-lock.json",
  repositoryId: "fixture/durable",
  commitSha: "abc123",
  observedAt: 1,
  staticAnalysis: {
    origin: "precomputed",
    entrypoints: ["src/index.ts"],
    files: [{ path: "src/index.ts", source: "import 'durable-app'" }],
  },
  runtimeTrace: {
    runId: "run-1",
    startedAt: 2,
    command: "pnpm test",
    kind: "test",
    packages: [{
      name: "durable-app",
      version: "1.0.0",
      firstLoadedAt: 3,
      loadCount: 1,
    }],
  },
};

describe("durable scan public workflow", () => {
  it("schedules through Convex semantics and never executes in the request", async () => {
    const backend = new MemoryDurableBackend();
    const execute = vi.fn(async () => ({ shouldNotRun: true }));
    const application = Fastify();
    registerScanWorkflowRoutes(application, async () => resolvedInput, execute, undefined, backend);

    const first = await application.inject({ method: "POST", url: "/v1/scans", body: requestBody() });
    expect(first.statusCode, first.body).toBe(202);
    expect(first.json()).toMatchObject({ stage: "QUEUED", attempt: 0, eventCount: 1 });
    expect(execute).not.toHaveBeenCalled();
    expect(backend.scheduledInput).toMatchObject({
      staticAnalysis: { origin: "precomputed" },
      runtimeTrace: { runId: "run-1" },
    });

    const second = await application.inject({ method: "POST", url: "/v1/scans", body: requestBody() });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().scanId).toBe(first.json().scanId);
    expect(backend.scheduleCalls).toBe(2);
    expect(execute).not.toHaveBeenCalled();
    await application.close();
  });

  it("reads ordered durable status/events and preserves pagination", async () => {
    const backend = new MemoryDurableBackend();
    const application = Fastify();
    registerScanWorkflowRoutes(application, async () => resolvedInput, vi.fn(), undefined, backend);
    const scheduled = await application.inject({ method: "POST", url: "/v1/scans", body: requestBody() });
    const scanId = scheduled.json().scanId as StableId;
    backend.complete();

    const status = await application.inject({ method: "GET", url: `/v1/scans/${scanId}` });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toMatchObject({
      scanId,
      stage: "COMPLETE",
      attempt: 1,
      eventCount: 3,
      result: { counts: { resolutions: 1 } },
    });
    const events = await application.inject({
      method: "GET",
      url: `/v1/scans/${scanId}/events?offset=1&limit=1`,
    });
    expect(events.statusCode, events.body).toBe(200);
    expect(events.json()).toMatchObject({ total: 3, offset: 1, limit: 1 });
    expect(events.json().events.map(({ stage }: { stage: string }) => stage)).toEqual(["PARSING"]);
    expect(events.json().events[0].eventId).toMatch(/^\d+$/u);
    await application.close();
  });

  it("fails closed when configured durability is unavailable", async () => {
    const backend = new MemoryDurableBackend();
    backend.failure = new Error("control plane unavailable");
    const execute = vi.fn();
    const application = Fastify();
    registerScanWorkflowRoutes(application, async () => resolvedInput, execute, undefined, backend);

    const response = await application.inject({ method: "POST", url: "/v1/scans", body: requestBody() });
    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toMatchObject({
      error: "DURABLE_SCHEDULER_UNAVAILABLE",
      message: "control plane unavailable",
    });
    expect(execute).not.toHaveBeenCalled();
    await application.close();
  });

  it("binds evidence into idempotency and rejects unsafe or duplicate source paths", async () => {
    const stableIds: StableId[] = [];
    const backend: DurableScanBackend = {
      get: async () => undefined,
      cancel: async () => undefined,
      schedule: async (stableId, idempotencyKey) => {
        stableIds.push(stableId);
        return {
          created: true,
          record: record(stableId, idempotencyKey),
          events: [{ sequence: 0, stage: "QUEUED", at: 1, message: "Queued" }],
        };
      },
    };
    const application = Fastify();
    registerScanWorkflowRoutes(application, async (request) => ({
      ...resolvedInput,
      staticAnalysis: {
        origin: "precomputed",
        entrypoints: request.staticAnalysis!.entrypoints,
        files: request.staticAnalysis!.files,
      },
    }), vi.fn(), undefined, backend);
    const first = await application.inject({
      method: "POST",
      url: "/v1/scans",
      body: requestBody("import 'first'"),
    });
    const second = await application.inject({
      method: "POST",
      url: "/v1/scans",
      body: requestBody("import 'second'"),
    });
    expect(first.statusCode, first.body).toBe(202);
    expect(second.statusCode, second.body).toBe(202);
    expect(stableIds[0]).not.toBe(stableIds[1]);

    const unsafe = await application.inject({
      method: "POST",
      url: "/v1/scans",
      body: requestBody("source", [{ path: "../secret.ts", source: "source" }]),
    });
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json().error).toBe("INVALID_SCAN");
    const duplicate = await application.inject({
      method: "POST",
      url: "/v1/scans",
      body: requestBody("source", [
        { path: "./src/index.ts", source: "one" },
        { path: "src/index.ts", source: "two" },
      ]),
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("Duplicate normalized source path") }),
    ]));
    await application.close();
  });

  it("keeps the no-Convex local fallback deterministic and synchronous", async () => {
    const execute = vi.fn(async (_input, progress) => {
      progress("PARSING", "Parsed");
      return { counts: { resolutions: 1 } };
    });
    const application = Fastify();
    registerScanWorkflowRoutes(application, async () => resolvedInput, execute);
    const response = await application.inject({ method: "POST", url: "/v1/scans", body: requestBody() });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ stage: "COMPLETE", eventCount: 3 });
    expect(execute).toHaveBeenCalledOnce();
    await application.close();
  });
});

class MemoryDurableBackend implements DurableScanBackend {
  snapshot?: DurableScanSnapshot;
  scheduledInput?: ScanWorkflowInput;
  scheduleCalls = 0;
  failure?: Error;

  async get(stableId: StableId): Promise<DurableScanSnapshot | undefined> {
    this.#throwIfFailed();
    return this.snapshot?.record.stableId === stableId ? structuredClone(this.snapshot) : undefined;
  }

  async schedule(
    stableId: StableId,
    idempotencyKey: string,
    input: ScanWorkflowInput,
  ): Promise<DurableScanSnapshot & { created: boolean }> {
    this.#throwIfFailed();
    this.scheduleCalls += 1;
    this.scheduledInput = structuredClone(input);
    const created = this.snapshot === undefined;
    this.snapshot ??= {
      record: record(stableId, idempotencyKey),
      events: [{ sequence: 0, stage: "QUEUED", at: 10, message: "Scan accepted by durable scheduler" }],
    };
    return { ...structuredClone(this.snapshot), created };
  }

  async cancel(stableId: StableId): Promise<DurableScanSnapshot | undefined> {
    const current = await this.get(stableId);
    if (current === undefined) return undefined;
    current.record.stage = "CANCELED";
    current.events.push({ sequence: current.events.length, stage: "CANCELED", at: 20, message: "Canceled" });
    this.snapshot = current;
    return structuredClone(current);
  }

  complete(): void {
    if (this.snapshot === undefined) throw new Error("Schedule a scan first");
    this.snapshot.record = {
      ...this.snapshot.record,
      stage: "COMPLETE",
      attempt: 1,
      updatedAt: 30,
      result: { counts: { resolutions: 1 } },
    };
    this.snapshot.events.push(
      { sequence: 1, stage: "PARSING", at: 20, message: "Parsed" },
      { sequence: 2, stage: "COMPLETE", at: 30, message: "Complete" },
    );
  }

  #throwIfFailed(): void {
    if (this.failure !== undefined) throw this.failure;
  }
}

function record(stableId: StableId, idempotencyKey: string): DurableScanRecord {
  return {
    _id: "scan-convex-id" as Id<"scans">,
    stableId,
    idempotencyKey,
    repositoryId: resolvedInput.repositoryId,
    commitSha: resolvedInput.commitSha,
    stage: "QUEUED",
    attempt: 0,
    createdAt: 10,
    updatedAt: 10,
  };
}

function requestBody(
  source = resolvedInput.staticAnalysis!.files[0]!.source,
  files: Array<{ path: string; source: string }> = [{ path: "src/index.ts", source }],
): Record<string, unknown> {
  return {
    content: resolvedInput.content,
    sourceRef: resolvedInput.sourceRef,
    repositoryId: resolvedInput.repositoryId,
    commitSha: resolvedInput.commitSha,
    observedAt: resolvedInput.observedAt,
    staticAnalysis: {
      entrypoints: resolvedInput.staticAnalysis!.entrypoints,
      files,
    },
    runtimeTrace: resolvedInput.runtimeTrace,
  };
}
