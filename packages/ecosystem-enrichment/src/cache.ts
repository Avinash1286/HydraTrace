import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Hex } from "@hydratrace/domain";

export interface CachedHttpResponse<T> {
  fetchedAt: number;
  expiresAt: number;
  status: number;
  etag?: string;
  sha256: string;
  body: T;
}

export interface ResponseCache {
  get<T>(namespace: string, requestKey: string, now: number): Promise<CachedHttpResponse<T> | undefined>;
  put<T>(
    namespace: string,
    requestKey: string,
    response: Omit<CachedHttpResponse<T>, "sha256">,
  ): Promise<CachedHttpResponse<T>>;
}

export class FileResponseCache implements ResponseCache {
  public constructor(private readonly rootDirectory: string) {}

  public async get<T>(
    namespace: string,
    requestKey: string,
    now: number,
  ): Promise<CachedHttpResponse<T> | undefined> {
    const path = this.pathFor(namespace, requestKey);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as CachedHttpResponse<T>;
      if (parsed.expiresAt <= now) return undefined;
      const serializedBody = JSON.stringify(parsed.body);
      if (sha256Hex(serializedBody) !== parsed.sha256) return undefined;
      return parsed;
    } catch (error) {
      const code = isNodeError(error) ? error.code : undefined;
      if (code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  public async put<T>(
    namespace: string,
    requestKey: string,
    response: Omit<CachedHttpResponse<T>, "sha256">,
  ): Promise<CachedHttpResponse<T>> {
    const path = this.pathFor(namespace, requestKey);
    const entry: CachedHttpResponse<T> = {
      ...response,
      sha256: sha256Hex(JSON.stringify(response.body)),
    };
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(entry, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, path);
    return entry;
  }

  private pathFor(namespace: string, requestKey: string): string {
    const safeNamespace = namespace.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
    return join(this.rootDirectory, safeNamespace, `${sha256Hex(requestKey)}.json`);
  }
}

export class MemoryResponseCache implements ResponseCache {
  private readonly entries = new Map<string, CachedHttpResponse<unknown>>();

  public async get<T>(
    namespace: string,
    requestKey: string,
    now: number,
  ): Promise<CachedHttpResponse<T> | undefined> {
    const entry = this.entries.get(`${namespace}:${requestKey}`);
    return entry !== undefined && entry.expiresAt > now
      ? (entry as CachedHttpResponse<T>)
      : undefined;
  }

  public async put<T>(
    namespace: string,
    requestKey: string,
    response: Omit<CachedHttpResponse<T>, "sha256">,
  ): Promise<CachedHttpResponse<T>> {
    const entry: CachedHttpResponse<T> = {
      ...response,
      sha256: sha256Hex(JSON.stringify(response.body)),
    };
    this.entries.set(`${namespace}:${requestKey}`, entry as CachedHttpResponse<unknown>);
    return entry;
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
