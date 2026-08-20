import { describe, expect, it, vi } from "vitest";

import { progress as recordProgress } from "../../../convex/callbacks.js";
import { acknowledge, startAttempt } from "../../../convex/jobs.js";

type Row = Record<string, unknown> & { _id?: string };
type TestMutation<Args, Result> = {
  _handler: (ctx: unknown, args: Args) => Promise<Result>;
};

const startAttemptHandler = (startAttempt as unknown as TestMutation<
  { jobId: string; requestId: string },
  { attempt: number; attemptId: string } | null
>)._handler;
const acknowledgeHandler = (acknowledge as unknown as TestMutation<
  { jobId: string; attemptId: string; engineJobId: string; statusCode: number },
  boolean
>)._handler;
const recordProgressHandler = (recordProgress as unknown as TestMutation<
  {
    requestId: string;
    jobId: string;
    engineJobId: string;
    stage: string;
    message: string;
    at: number;
  },
  boolean
>)._handler;

class MemoryDatabase {
  readonly rows = new Map<string, Row>();
  readonly tables = new Map<string, Row[]>();
  #nextId = 1;

  async get(id: string): Promise<Row | null> {
    return this.rows.get(id) ?? null;
  }

  async patch(id: string, value: Row): Promise<void> {
    const current = this.rows.get(id);
    if (current === undefined) throw new Error(`Unknown test document ${id}`);
    Object.assign(current, value);
  }

  async insert(table: string, value: Row): Promise<string> {
    const id = `${table}:${this.#nextId++}`;
    const row = { _id: id, ...value };
    this.rows.set(id, row);
    const entries = this.tables.get(table) ?? [];
    entries.push(row);
    this.tables.set(table, entries);
    return id;
  }

  query(table: string): {
    withIndex: (
      index: string,
      select: (query: { eq: (field: string, value: string) => unknown }) => unknown,
    ) => { collect: () => Promise<Row[]>; unique: () => Promise<Row | null> };
  } {
    return {
      withIndex: (_index, select) => {
        let field = "";
        let value = "";
        select({
          eq: (selectedField, selectedValue) => {
            field = selectedField;
            value = selectedValue;
            return undefined;
          },
        });
        const selected = (): Row[] =>
          (this.tables.get(table) ?? []).filter((row) => row[field] === value);
        return {
          collect: async () => selected(),
          unique: async () => {
            const matches = selected();
            if (matches.length > 1) throw new Error(`Expected one ${table} row, received ${matches.length}`);
            return matches[0] ?? null;
          },
        };
      },
    };
  }

  seed(id: string, value: Row): void {
    this.rows.set(id, { _id: id, ...value });
  }

  seedTable(table: string, value: Row): void {
    const row = { ...value };
    const entries = this.tables.get(table) ?? [];
    entries.push(row);
    this.tables.set(table, entries);
  }
}

describe("Convex dispatch event projection", () => {
  it("projects DISPATCHING and ACKNOWLEDGED once, in scan-event order", async () => {
    const now = Date.now();
    const jobId = "jobs:active";
    const scanId = "scans:active";
    const db = new MemoryDatabase();
    db.seed(jobId, {
      scanId,
      status: "QUEUED",
      attempt: 0,
      availableAt: now - 1,
      idempotencyKey: "scan-idempotency-key",
    });
    db.seed(scanId, {
      stage: "QUEUED",
      currentStage: "QUEUED",
      attempt: 0,
      updatedAt: now - 1,
    });
    db.seedTable("scanEvents", {
      scanId,
      sequence: 0,
      stage: "QUEUED",
      at: now - 1,
      message: "Scan accepted by durable scheduler",
    });
    db.seedTable("jobEvents", {
      jobId,
      sequence: 0,
      state: "QUEUED",
      at: now - 1,
      message: "Job queued",
      traceId: "scan-idempotency-key",
    });
    const ctx = { db };

    const started = await startAttemptHandler(ctx, {
      jobId,
      requestId: "dispatch-request",
    });
    expect(started).toMatchObject({ attempt: 1 });
    expect(await startAttemptHandler(ctx, {
      jobId,
      requestId: "replayed-dispatch-request",
    })).toBeNull();

    expect(await acknowledgeHandler(ctx, {
      jobId,
      attemptId: started!.attemptId,
      engineJobId: "engine-job-1",
      statusCode: 202,
    })).toBe(true);
    expect(await acknowledgeHandler(ctx, {
      jobId,
      attemptId: started!.attemptId,
      engineJobId: "engine-job-1",
      statusCode: 202,
    })).toBe(false);

    const scanEvents = db.tables.get("scanEvents") ?? [];
    expect(scanEvents.map(({ sequence, stage }) => ({ sequence, stage }))).toEqual([
      { sequence: 0, stage: "QUEUED" },
      { sequence: 1, stage: "DISPATCHING" },
      { sequence: 2, stage: "ACKNOWLEDGED" },
    ]);
    const attempt = db.rows.get(started!.attemptId as string) ?? {};
    expect(scanEvents[1]?.at).toBe(attempt.startedAt);
    expect(scanEvents[2]?.at).toBe(attempt.completedAt);
    expect((db.rows.get(scanId) ?? {}).stage).toBe("ACKNOWLEDGED");
  });

  it("coalesces the engine acknowledgement callback with the dispatch acknowledgement", async () => {
    const dispatchAt = 1_000;
    const engineAcknowledgedAt = 1_050;
    const dispatchResponseAt = 1_100;
    const callbackReceivedAt = 1_200;
    const clock = vi.spyOn(Date, "now").mockReturnValue(dispatchAt);
    try {
      const jobId = "jobs:callback-race";
      const scanId = "scans:callback-race";
      const db = new MemoryDatabase();
      db.seed(jobId, {
        scanId,
        status: "QUEUED",
        attempt: 0,
        availableAt: dispatchAt - 1,
        idempotencyKey: "callback-race-key",
      });
      db.seed(scanId, {
        stage: "QUEUED",
        currentStage: "QUEUED",
        attempt: 0,
        updatedAt: dispatchAt - 1,
      });
      db.seedTable("scanEvents", {
        scanId,
        sequence: 0,
        stage: "QUEUED",
        at: dispatchAt - 1,
        message: "Scan accepted by durable scheduler",
      });
      db.seedTable("jobEvents", {
        jobId,
        sequence: 0,
        state: "QUEUED",
        at: dispatchAt - 1,
        message: "Job queued",
        traceId: "callback-race-key",
      });
      const ctx = { db, scheduler: { runAfter: vi.fn() } };

      const started = await startAttemptHandler(ctx, {
        jobId,
        requestId: "callback-race-dispatch",
      });
      clock.mockReturnValue(dispatchResponseAt);
      expect(await acknowledgeHandler(ctx, {
        jobId,
        attemptId: started!.attemptId,
        engineJobId: "engine-job-race",
        statusCode: 202,
      })).toBe(true);

      clock.mockReturnValue(callbackReceivedAt);
      const callback = {
        requestId: "callback:engine-job-race:ACKNOWLEDGED:1050",
        jobId,
        engineJobId: "engine-job-race",
        stage: "ACKNOWLEDGED",
        message: "Engine acknowledged the job",
        at: engineAcknowledgedAt,
      };
      expect(await recordProgressHandler(ctx, callback)).toBe(true);
      expect(await recordProgressHandler(ctx, callback)).toBe(false);

      const scanEvents = db.tables.get("scanEvents") ?? [];
      expect(scanEvents.map(({ sequence, stage, at }) => ({ sequence, stage, at }))).toEqual([
        { sequence: 0, stage: "QUEUED", at: dispatchAt - 1 },
        { sequence: 1, stage: "DISPATCHING", at: dispatchAt },
        { sequence: 2, stage: "ACKNOWLEDGED", at: engineAcknowledgedAt },
      ]);
      expect(scanEvents.every((event, index) =>
        index === 0 || Number(event.at) >= Number(scanEvents[index - 1]!.at))).toBe(true);
      expect((db.tables.get("jobEvents") ?? []).map(({ sequence, state, at }) => ({ sequence, state, at }))).toEqual([
        { sequence: 0, state: "QUEUED", at: dispatchAt - 1 },
        { sequence: 1, state: "DISPATCHING", at: dispatchAt },
        { sequence: 2, state: "ACKNOWLEDGED", at: engineAcknowledgedAt },
      ]);
      expect(db.tables.get("auditEvents")).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps acknowledgements from separate dispatch attempts distinct", async () => {
    const jobId = "jobs:retry";
    const scanId = "scans:retry";
    const db = new MemoryDatabase();
    db.seed(jobId, {
      scanId,
      status: "DISPATCHING",
      attempt: 2,
      idempotencyKey: "retry-key",
    });
    db.seed(scanId, {
      stage: "DISPATCHING",
      currentStage: "DISPATCHING",
      attempt: 2,
      updatedAt: 50,
    });
    for (const event of [
      { sequence: 0, stage: "QUEUED", at: 10 },
      { sequence: 1, stage: "DISPATCHING", at: 20 },
      { sequence: 2, stage: "ACKNOWLEDGED", at: 30 },
      { sequence: 3, stage: "RETRY_WAIT", at: 40 },
      { sequence: 4, stage: "DISPATCHING", at: 50 },
    ]) db.seedTable("scanEvents", { scanId, message: event.stage, ...event });
    for (const event of [
      { sequence: 0, state: "QUEUED", at: 10 },
      { sequence: 1, state: "DISPATCHING", at: 20 },
      { sequence: 2, state: "ACKNOWLEDGED", at: 30 },
      { sequence: 3, state: "RETRY_WAIT", at: 40 },
      { sequence: 4, state: "DISPATCHING", at: 50 },
    ]) db.seedTable("jobEvents", { jobId, message: event.state, traceId: "retry-key", ...event });

    expect(await recordProgressHandler(
      { db, scheduler: { runAfter: vi.fn() } },
      {
        requestId: "callback:engine-job-retry:ACKNOWLEDGED:60",
        jobId,
        engineJobId: "engine-job-retry",
        stage: "ACKNOWLEDGED",
        message: "Engine acknowledged the job",
        at: 60,
      },
    )).toBe(true);

    expect((db.tables.get("scanEvents") ?? []).map(({ stage }) => stage)).toEqual([
      "QUEUED", "DISPATCHING", "ACKNOWLEDGED", "RETRY_WAIT", "DISPATCHING", "ACKNOWLEDGED",
    ]);
    expect((db.tables.get("jobEvents") ?? []).map(({ state }) => state)).toEqual([
      "QUEUED", "DISPATCHING", "ACKNOWLEDGED", "RETRY_WAIT", "DISPATCHING", "ACKNOWLEDGED",
    ]);
  });
});
