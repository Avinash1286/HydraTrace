import { Buffer } from "node:buffer";
import { createHmac, randomUUID } from "node:crypto";
import { sha256Hex, stableIdFromCanonicalKey, type StableId } from "@hydratrace/domain";
import { ConvexHttpClient } from "convex/browser";
import { z } from "zod";
import { api } from "../../../../convex/_generated/api.js";
import type { Id } from "../../../../convex/_generated/dataModel.js";
import type { ScanStage, ScanWorkflowInput } from "./scans.js";

export interface DurableScanRecord {
  _id: Id<"scans">;
  stableId: string;
  idempotencyKey: string;
  repositoryId: string;
  commitSha: string;
  stage: string;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  result?: unknown;
  error?: string;
}

export interface DurableScanEvent {
  sequence: number;
  stage: string;
  at: number;
  message: string;
}

export interface DurableScanSnapshot {
  record: DurableScanRecord;
  events: DurableScanEvent[];
}

export interface DurableScheduleResult extends DurableScanSnapshot {
  created: boolean;
}

/**
 * The public scan routes depend on this narrow contract so their durable and
 * deterministic in-memory paths can be tested without a live Convex project.
 */
export interface DurableScanBackend {
  get(stableId: StableId): Promise<DurableScanSnapshot | undefined>;
  schedule(
    stableId: StableId,
    idempotencyKey: string,
    input: ScanWorkflowInput,
  ): Promise<DurableScheduleResult>;
  cancel(stableId: StableId): Promise<DurableScanSnapshot | undefined>;
}

interface ConvexScanBackendOptions {
  siteUrl?: string;
  fetchImplementation?: typeof fetch;
}

const uploadUrlResponseSchema = z.object({ uploadUrl: z.string().url() }).passthrough();
const storageResponseSchema = z.object({ storageId: z.string().min(1) }).passthrough();
const scheduleResponseSchema = z.object({ created: z.boolean() }).passthrough();

export class ConvexScanBackend implements DurableScanBackend {
  readonly #client: ConvexHttpClient;
  readonly #fetch: typeof fetch;
  readonly #secret: string;
  readonly #siteUrl: string;

  constructor(
    convexUrl: string,
    sharedSecret: string,
    options: ConvexScanBackendOptions = {},
  ) {
    if (sharedSecret.length < 32) {
      throw new Error("HYDRATRACE_JOB_SHARED_SECRET must contain at least 32 characters when CONVEX_URL is configured");
    }
    this.#client = new ConvexHttpClient(normalizeBaseUrl(convexUrl, "CONVEX_URL"));
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#secret = sharedSecret;
    this.#siteUrl = resolveSiteUrl(convexUrl, options.siteUrl);
  }

  async get(stableId: StableId): Promise<DurableScanSnapshot | undefined> {
    const record = await this.#client.query(api.scans.get, { stableId });
    if (record === null) return undefined;
    const events = await this.#client.query(api.scans.events, { scanId: record._id });
    return { record, events };
  }

  async schedule(
    stableId: StableId,
    idempotencyKey: string,
    input: ScanWorkflowInput,
  ): Promise<DurableScheduleResult> {
    const existing = await this.get(stableId);
    if (existing !== undefined) return { ...existing, created: false };

    let uploadedStorageId: string | undefined;
    try {
      // Keep lockfile/source bytes out of Convex function arguments and table
      // documents. The private storage object is the single durable envelope
      // consumed by the dispatch action.
      const envelope = JSON.stringify(input);
      const envelopeBytes = Buffer.byteLength(envelope, "utf8");
      if (envelopeBytes > 15_000_000) {
        throw new Error("Resolved scan input exceeds the 15 MB durable-envelope limit");
      }
      const uploadRequest = await this.#signedPost("/scans/upload-url", {});
      const { uploadUrl } = uploadUrlResponseSchema.parse(uploadRequest);
      const uploadResponse = await this.#fetch(uploadUrl, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: envelope,
        signal: AbortSignal.timeout(30_000),
      });
      if (!uploadResponse.ok) {
        throw new Error(`Convex storage upload returned HTTP ${uploadResponse.status}`);
      }
      const storage = storageResponseSchema.parse(await uploadResponse.json());
      uploadedStorageId = storage.storageId;
      const scheduledValue = await this.#signedPost("/scans/schedule", {
        storageId: storage.storageId,
        stableId,
        idempotencyKey,
        repositoryId: input.repositoryId,
        commitSha: input.commitSha,
        fileName: "hydratrace-scan-input.json",
        contentType: "application/json; charset=utf-8",
        byteLength: envelopeBytes,
        sha256: sha256Hex(envelope),
      });
      const scheduled = scheduleResponseSchema.parse(scheduledValue);
      const snapshot = await this.get(stableId);
      if (snapshot === undefined) throw new Error("Convex scheduled a scan but did not return its durable record");
      return { ...snapshot, created: scheduled.created };
    } catch (error) {
      if (uploadedStorageId !== undefined) {
        await this.#signedPost("/scans/discard-storage", {
          storageId: uploadedStorageId,
        }).catch(() => undefined);
      }
      throw error;
    }
  }

  async cancel(stableId: StableId): Promise<DurableScanSnapshot | undefined> {
    const current = await this.get(stableId);
    if (current === undefined) return undefined;
    await this.#signedPost("/scans/cancel", { scanId: current.record._id });
    return await this.get(stableId);
  }

  async #signedPost(path: string, value: Record<string, unknown>): Promise<unknown> {
    const body = JSON.stringify(value);
    const timestamp = String(Date.now());
    const requestId = `engine:${path.replaceAll("/", ".")}:${randomUUID()}`;
    const signature = createHmac("sha256", this.#secret)
      .update(`${timestamp}.${requestId}.${body}`, "utf8")
      .digest("hex");
    const response = await this.#fetch(`${this.#siteUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hydratrace-timestamp": timestamp,
        "x-hydratrace-request-id": requestId,
        "x-hydratrace-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const responseBody = await response.json() as { message?: unknown; error?: unknown };
    if (!response.ok) {
      throw new Error(
        typeof responseBody.message === "string"
          ? responseBody.message
          : typeof responseBody.error === "string"
            ? responseBody.error
            : `Convex signed endpoint returned HTTP ${response.status}`,
      );
    }
    return responseBody;
  }
}

export function durableEvents(
  stableId: StableId,
  events: readonly DurableScanEvent[],
): Array<{ eventId: StableId; stage: ScanStage; at: number; message: string }> {
  return events.map((event) => ({
    eventId: stableIdFromCanonicalKey(
      `scan-event:${stableId}:${event.sequence}:${event.stage}`,
    ),
    stage: event.stage as ScanStage,
    at: event.at,
    message: event.message,
  }));
}

function normalizeBaseUrl(value: string, name: string): string {
  const trimmed = value.trim().replace(/\/$/u, "");
  const url = new URL(trimmed);
  if (!(["https:", "http:"].includes(url.protocol)) || url.username !== "" || url.password !== "") {
    throw new Error(`${name} must be an HTTP(S) URL without credentials`);
  }
  return url.toString().replace(/\/$/u, "");
}

function resolveSiteUrl(convexUrl: string, configuredSiteUrl?: string): string {
  if (configuredSiteUrl !== undefined && configuredSiteUrl.trim() !== "") {
    return normalizeBaseUrl(configuredSiteUrl, "CONVEX_SITE_URL");
  }
  const url = new URL(normalizeBaseUrl(convexUrl, "CONVEX_URL"));
  if (url.hostname.endsWith(".convex.cloud")) {
    url.hostname = `${url.hostname.slice(0, -".convex.cloud".length)}.convex.site`;
    return url.toString().replace(/\/$/u, "");
  }
  if (
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    /^\d+$/u.test(url.port)
  ) {
    url.port = String(Number(url.port) + 1);
    return url.toString().replace(/\/$/u, "");
  }
  throw new Error("CONVEX_SITE_URL is required when CONVEX_URL is not a convex.cloud or local development URL");
}
