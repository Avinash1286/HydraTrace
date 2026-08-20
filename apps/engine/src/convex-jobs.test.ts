import { describe, expect, it } from "vitest";

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
    ) => { collect: () => Promise<Row[]> };
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
        return {
          collect: async () => (this.tables.get(table) ?? []).filter((row) => row[field] === value),
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
});
