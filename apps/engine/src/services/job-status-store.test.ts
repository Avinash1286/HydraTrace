import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileJobStatusStore, MemoryJobStatusStore } from "./job-status-store.js";

const key = "a".repeat(64);
const status = {
  jobId: "job-1",
  idempotencyKey: key,
  engineJobId: "123",
  state: "PARSING" as const,
  checkpointStage: "PARSING" as const,
  updatedAt: 42,
};

describe("job status checkpoints", () => {
  it("clones memory checkpoints so callers cannot mutate stored state", async () => {
    const store = new MemoryJobStatusStore();
    await store.put(status);
    const loaded = await store.get(key);
    expect(loaded).toEqual(status);
    loaded!.state = "FAILED";
    expect((await store.get(key))?.state).toBe("PARSING");
  });

  it("survives an engine process restart through atomic files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hydratrace-job-state-"));
    await new FileJobStatusStore(directory).put(status);
    const restarted = new FileJobStatusStore(directory);
    expect(await restarted.get(key)).toEqual(status);
    expect(JSON.parse(await readFile(join(directory, `${key}.json`), "utf8"))).toEqual(status);
  });

  it("rejects unsafe checkpoint filenames", async () => {
    await expect(new MemoryJobStatusStore().get("../escape")).resolves.toBeUndefined();
    const directory = await mkdtemp(join(tmpdir(), "hydratrace-job-state-"));
    await expect(new FileJobStatusStore(directory).get("../escape")).rejects.toThrow(/SHA-256/u);
  });
});
