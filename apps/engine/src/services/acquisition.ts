import { sha256Hex } from "@hydratrace/domain";
import { Buffer } from "node:buffer";
import type { Readable } from "node:stream";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { ScanWorkflowInput, ScanWorkflowRequest } from "./scans.js";

// Base64 expands input by roughly 4/3. This keeps the encoded request within
// the Vercel Functions body limit.
const MAX_ARCHIVE_BYTES = 4_000_000;
const MAX_ARCHIVE_FILES = 10_000;
const MAX_EXPANDED_BYTES = 50_000_000;
const MAX_SELECTED_FILE_BYTES = 5_000_000;

interface ArchiveSelection {
  lockfilePath: string;
  content: string;
  deploymentManifest?: string;
  rootPackage?: { name: string; version: string };
}

/**
 * Resolves every supported scan mode to the same bounded lockfile contract.
 * Archives are inspected in memory and repository code is never executed.
 */
export async function acquireScanInput(
  request: ScanWorkflowRequest,
  fetchImplementation: typeof fetch = fetch,
): Promise<ScanWorkflowInput> {
  if (request.mode === "lockfile") {
    const content = request.content!;
    const digest = sha256Hex(content);
    const sourceRef = request.sourceRef ?? inferLockfileName(content);
    const repositoryId = request.repositoryId ?? `upload/${digest.slice(0, 16)}`;
    const commitSha = request.commitSha ?? `upload-${digest.slice(0, 16)}`;
    return finishInput(request, {
      content,
      sourceRef,
      repositoryId,
      commitSha,
      observedAt: request.observedAt ?? Date.now(),
      ...(request.rootPackage === undefined ? {} : { rootPackage: request.rootPackage }),
      ...(request.deploymentManifest === undefined
        ? {}
        : { deploymentManifest: request.deploymentManifest }),
    });
  }

  let archive: Buffer;
  let repositoryId = request.repositoryId;
  let commitSha = request.commitSha;
  if (request.mode === "repository") {
    const repository = parseGitHubRepositoryUrl(request.repositoryUrl!);
    repositoryId = `${repository.owner}/${repository.name}`;
    const revision = await resolveGitHubRevision(
      repository,
      request.ref ?? "HEAD",
      fetchImplementation,
    );
    commitSha = revision;
    archive = await downloadLimited(
      `https://codeload.github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/zip/${encodeURIComponent(revision)}`,
      fetchImplementation,
    );
  } else {
    archive = decodeArchive(request.archiveBase64!);
  }

  const selection = await readArchive(archive, request.lockfilePath);
  const digest = sha256Hex(selection.content);
  repositoryId ??= `upload/${sha256Hex(archive.toString("base64")).slice(0, 16)}`;
  commitSha ??= `upload-${digest.slice(0, 16)}`;
  return finishInput(request, {
    content: selection.content,
    sourceRef: selection.lockfilePath,
    repositoryId,
    commitSha,
    observedAt: request.observedAt ?? Date.now(),
    ...((request.rootPackage ?? selection.rootPackage) === undefined
      ? {}
      : { rootPackage: request.rootPackage ?? selection.rootPackage! }),
    ...((request.deploymentManifest ?? selection.deploymentManifest) === undefined
      ? {}
      : { deploymentManifest: request.deploymentManifest ?? selection.deploymentManifest! }),
  });
}

function finishInput(
  request: ScanWorkflowRequest,
  input: ScanWorkflowInput,
): ScanWorkflowInput {
  if (input.deploymentManifest !== undefined || request.environment === undefined) {
    return input;
  }
  const startedAt = request.deploymentStartedAt ?? input.observedAt;
  const endedAt = request.deploymentEndedAt ?? null;
  const deploymentManifest = JSON.stringify({
    schemaVersion: 1,
    organizationId: request.organizationId ?? "local",
    repositoryId: input.repositoryId,
    serviceId: request.serviceId ?? input.repositoryId.split("/").at(-1) ?? "service",
    environment: request.environment,
    commitSha: input.commitSha,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: endedAt === null ? null : new Date(endedAt).toISOString(),
    lockfile: input.sourceRef,
  });
  return { ...input, deploymentManifest };
}

function inferLockfileName(content: string): string {
  try {
    const value = JSON.parse(content) as { lockfileVersion?: unknown };
    return value.lockfileVersion === undefined ? "pnpm-lock.yaml" : "package-lock.json";
  } catch {
    return "pnpm-lock.yaml";
  }
}

function decodeArchive(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new Error("archiveBase64 must be canonical base64");
  }
  const archive = Buffer.from(value, "base64");
  if (archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) {
    throw new Error(`ZIP archive must be between 1 and ${MAX_ARCHIVE_BYTES} bytes`);
  }
  if (archive[0] !== 0x50 || archive[1] !== 0x4b) {
    throw new Error("Uploaded archive is not a ZIP file");
  }
  return archive;
}

interface GitHubRepository { owner: string; name: string }

function parseGitHubRepositoryUrl(value: string): GitHubRepository {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Only canonical HTTPS public github.com repository URLs are accepted");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error("Repository URL must have the form https://github.com/owner/repository");
  }
  const owner = parts[0]!;
  const name = parts[1]!.replace(/\.git$/u, "");
  if (!/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(name)) {
    throw new Error("Repository owner or name contains unsupported characters");
  }
  return { owner, name };
}

async function resolveGitHubRevision(
  repository: GitHubRepository,
  ref: string,
  fetchImplementation: typeof fetch,
): Promise<string> {
  const response = await fetchImplementation(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/commits/${encodeURIComponent(ref)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "HydraTrace/0.1",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) throw new Error(`GitHub commit lookup failed with HTTP ${response.status}`);
  const value = await response.json() as { sha?: unknown };
  if (typeof value.sha !== "string" || !/^[0-9a-f]{40}$/u.test(value.sha)) {
    throw new Error("GitHub did not return a canonical commit SHA");
  }
  return value.sha;
}

async function downloadLimited(url: string, fetchImplementation: typeof fetch): Promise<Buffer> {
  const response = await fetchImplementation(url, {
    headers: { "user-agent": "HydraTrace/0.1" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`Repository archive download failed with HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
    throw new Error(`Repository archive exceeds the ${MAX_ARCHIVE_BYTES}-byte limit`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ARCHIVE_BYTES) throw new Error(`Repository archive exceeds the ${MAX_ARCHIVE_BYTES}-byte limit`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return decodeArchive(Buffer.concat(chunks).toString("base64"));
}

async function readArchive(archive: Buffer, requestedPath?: string): Promise<ArchiveSelection> {
  const zip = await openZip(archive);
  try {
    const entries = await listEntries(zip);
    const lockfiles = entries.filter(({ fileName }) => /(^|\/)(package-lock\.json|pnpm-lock\.ya?ml)$/u.test(fileName));
    const lockfile = selectEntry(lockfiles, requestedPath);
    if (lockfile === undefined) {
      throw new Error(requestedPath === undefined ? "ZIP does not contain a supported lockfile" : `ZIP does not contain lockfile ${requestedPath}`);
    }
    const directory = lockfile.fileName.includes("/") ? lockfile.fileName.slice(0, lockfile.fileName.lastIndexOf("/") + 1) : "";
    const manifest = entries.find(({ fileName }) => fileName === `${directory}hydratrace-deployment.json`);
    const packageJson = entries.find(({ fileName }) => fileName === `${directory}package.json`);
    const content = await readEntry(zip, lockfile);
    const deploymentManifest = manifest === undefined ? undefined : await readEntry(zip, manifest);
    const rootPackage = packageJson === undefined ? undefined : parseRootPackage(await readEntry(zip, packageJson));
    return {
      lockfilePath: stripArchiveRoot(lockfile.fileName),
      content,
      ...(deploymentManifest === undefined ? {} : { deploymentManifest }),
      ...(rootPackage === undefined ? {} : { rootPackage }),
    };
  } finally {
    zip.close();
  }
}

function openZip(archive: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true, autoClose: false, decodeStrings: true }, (error, zip) => {
      if (error !== null) reject(error);
      else if (zip === undefined) reject(new Error("Unable to open ZIP archive"));
      else resolve(zip);
    });
  });
}

function listEntries(zip: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    let expandedBytes = 0;
    zip.on("entry", (entry: Entry) => {
      try {
        validateArchivePath(entry.fileName);
        if ((entry.generalPurposeBitFlag & 1) !== 0) throw new Error("Encrypted ZIP entries are not supported");
        expandedBytes += entry.uncompressedSize;
        if (entries.length >= MAX_ARCHIVE_FILES) throw new Error(`ZIP contains more than ${MAX_ARCHIVE_FILES} entries`);
        if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error(`ZIP expands beyond ${MAX_EXPANDED_BYTES} bytes`);
        entries.push(entry);
        zip.readEntry();
      } catch (error) {
        reject(error);
        zip.close();
      }
    });
    zip.once("error", reject);
    zip.once("end", () => resolve(entries));
    zip.readEntry();
  });
}

function validateArchivePath(path: string): void {
  if (
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path) ||
    path.split("/").some((part) => part === "..")
  ) {
    throw new Error(`Unsafe ZIP path ${JSON.stringify(path)}`);
  }
}

function selectEntry(entries: readonly Entry[], requestedPath?: string): Entry | undefined {
  if (requestedPath !== undefined) {
    validateArchivePath(requestedPath);
    const normalized = requestedPath.replace(/^\.\//u, "");
    return entries.find(({ fileName }) => fileName === normalized || fileName.endsWith(`/${normalized}`));
  }
  return [...entries].sort((left, right) => {
    const leftDepth = left.fileName.split("/").length;
    const rightDepth = right.fileName.split("/").length;
    return leftDepth - rightDepth || left.fileName.localeCompare(right.fileName);
  })[0];
}

function readEntry(zip: ZipFile, entry: Entry): Promise<string> {
  if (entry.uncompressedSize > MAX_SELECTED_FILE_BYTES) {
    throw new Error(`${entry.fileName} exceeds the ${MAX_SELECTED_FILE_BYTES}-byte file limit`);
  }
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error !== null) { reject(error); return; }
      if (stream === undefined) { reject(new Error(`Unable to read ${entry.fileName}`)); return; }
      readUtf8(stream, entry.uncompressedSize).then(resolve, reject);
    });
  });
}

async function readUtf8(stream: Readable, declaredSize: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += value.length;
    if (size > MAX_SELECTED_FILE_BYTES) throw new Error("Selected ZIP entry exceeds its size limit");
    chunks.push(value);
  }
  if (size !== declaredSize) throw new Error("Selected ZIP entry size did not match its central-directory record");
  return Buffer.concat(chunks).toString("utf8");
}

function parseRootPackage(content: string): { name: string; version: string } | undefined {
  try {
    const value = JSON.parse(content) as { name?: unknown; version?: unknown };
    return typeof value.name === "string" && typeof value.version === "string"
      ? { name: value.name, version: value.version }
      : undefined;
  } catch {
    return undefined;
  }
}

function stripArchiveRoot(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : path;
}
