import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScanStage } from "./scans.js";

export interface DurableJobStatus {
  jobId: string;
  idempotencyKey: string;
  engineJobId: string;
  state: "ACKNOWLEDGED" | ScanStage;
  checkpointStage: "ACKNOWLEDGED" | ScanStage;
  updatedAt: number;
  result?: unknown;
  error?: string;
}

export interface JobStatusStore {
  get(idempotencyKey: string): Promise<DurableJobStatus | undefined>;
  put(status: DurableJobStatus): Promise<void>;
}

export class MemoryJobStatusStore implements JobStatusStore {
  readonly #jobs = new Map<string, DurableJobStatus>();

  async get(idempotencyKey: string): Promise<DurableJobStatus | undefined> {
    const value = this.#jobs.get(idempotencyKey);
    return value === undefined ? undefined : structuredClone(value);
  }

  async put(status: DurableJobStatus): Promise<void> {
    this.#jobs.set(status.idempotencyKey, structuredClone(status));
  }
}

/**
 * Durable engine-side checkpoints for the long-running Zerops process. Each
 * update is atomically renamed so a process interruption cannot leave a
 * partially-written checkpoint. The idempotency key is a validated SHA-256,
 * so it is also safe to use as the filename.
 */
export class FileJobStatusStore implements JobStatusStore {
  constructor(readonly directory: string) {}

  async get(idempotencyKey: string): Promise<DurableJobStatus | undefined> {
    validateKey(idempotencyKey);
    try {
      return JSON.parse(await readFile(join(this.directory, `${idempotencyKey}.json`), "utf8")) as DurableJobStatus;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async put(status: DurableJobStatus): Promise<void> {
    validateKey(status.idempotencyKey);
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, `${status.idempotencyKey}.json`);
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(status)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  }
}

export function jobStatusStoreFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): JobStatusStore {
  const directory = environment.HYDRATRACE_JOB_STATE_DIR?.trim();
  return directory === undefined || directory === ""
    ? new MemoryJobStatusStore()
    : new FileJobStatusStore(directory);
}

function validateKey(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("Job idempotency key must be a SHA-256 hex value");
}
