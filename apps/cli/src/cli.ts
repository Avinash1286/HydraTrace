#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createHash } from "node:crypto";

interface Options { [key: string]: string | boolean | undefined; }
type ScanStage =
  | "QUEUED"
  | "DISPATCHING"
  | "ACKNOWLEDGED"
  | "ACQUIRING"
  | "PARSING"
  | "WRITING_GRAPH"
  | "ENRICHING"
  | "INDEXING"
  | "WAITING_FOR_INDEX"
  | "ANALYZING"
  | "COMPLETE"
  | "FAILED"
  | "RETRY_WAIT"
  | "CANCEL_REQUESTED"
  | "CANCELLED"
  | "CANCELED";

interface ScanStatus {
  scanId: string;
  stage: ScanStage;
  error?: string;
  [key: string]: unknown;
}

interface RequestDeadline {
  at: number;
  timeoutMs: number;
}

const scanStages = new Set<ScanStage>([
  "QUEUED", "DISPATCHING", "ACKNOWLEDGED", "ACQUIRING", "PARSING",
  "WRITING_GRAPH", "ENRICHING",
  "INDEXING", "WAITING_FOR_INDEX", "ANALYZING", "COMPLETE", "FAILED",
  "RETRY_WAIT", "CANCEL_REQUESTED", "CANCELLED", "CANCELED",
]);
const terminalScanStages = new Set<ScanStage>(["COMPLETE", "FAILED", "CANCELLED", "CANCELED"]);
const defaultScanTimeoutMs = 300_000;
const defaultPollIntervalMs = 1_000;
const [command, ...tokens] = process.argv.slice(2);
const options = parseOptions(tokens);
const api = String(options.api ?? process.env.HYDRATRACE_API_URL ?? "http://127.0.0.1:4100").replace(/\/$/u, "");

try {
  if (command === "--help" || command === "help") usage();
  else if (command === "scan") await scan();
  else if (command === "incident") await incident(false);
  else if (command === "gate") await incident(true);
  else throw configurationError("Usage: hydratrace <scan|incident|gate> [options]");
} catch (error) {
  const value = error as Error & { exitCode?: number };
  process.stderr.write(`${value.message}\n`);
  process.exitCode = value.exitCode ?? 2;
}

function usage(): void {
  process.stdout.write([
    "Usage: hydratrace <scan|incident|gate> [options]",
    "",
    "scan     --lockfile <path> [--repository <id>] [--commit <sha>] [--environment production] [--timeout-ms 300000]",
    "incident --package <name> --version <exact> [--from <ISO>] [--to <ISO>] [--format json|table|sarif]",
    "gate     Same options as incident [--fail-on reachable-high]",
    "         [--baseline <sha|snapshot:id> --current <sha|snapshot:id> --repository <id>]",
    "         Exact SHA selectors must be immutable 40/64-hex Git object IDs; symbolic branches are refused",
    "global   [--api <engine-url>] (or HYDRATRACE_API_URL)",
    "",
  ].join("\n"));
}

async function scan(): Promise<void> {
  const timeoutMs = integerOption("timeout-ms", defaultScanTimeoutMs, 3_600_000);
  const pollIntervalMs = integerOption("poll-interval-ms", defaultPollIntervalMs, 60_000);
  const deadline: RequestDeadline = { at: Date.now() + timeoutMs, timeoutMs };
  const lockfilePath = required("lockfile");
  const content = await readFile(lockfilePath, "utf8");
  const lockfileSha256 = createHash("sha256").update(content, "utf8").digest("hex");
  const repositoryId = String(options.repository ?? "local/repository");
  const commitSha = String(options.commit ?? "working-tree");
  const body: Record<string, unknown> = { content, sourceRef: basename(lockfilePath), repositoryId, commitSha, observedAt: Date.now() };
  if (options.environment !== undefined) {
    const environment = String(options.environment);
    body.deploymentManifest = JSON.stringify({ schemaVersion: 1, organizationId: String(options.organization ?? "local"), repositoryId, serviceId: String(options.service ?? basename(process.cwd())), environment, commitSha, startedAt: String(options.startedAt ?? new Date().toISOString()), endedAt: null, lockfile: basename(lockfilePath), lockfileSha256 });
  }
  const accepted = await request("/v1/scans", { method: "POST", body }, deadline);
  const result = await pollScanToTerminal(accepted, deadline, pollIntervalMs);
  output(result);
}

async function incident(gate: boolean): Promise<void> {
  if (gate && options["fail-on"] !== undefined && options["fail-on"] !== "reachable-high") {
    throw configurationError("--fail-on must be reachable-high");
  }
  let comparisonRequest: { baseline: Record<string, string>; current: Record<string, string> } | undefined;
  if (gate && options.baseline !== undefined) {
    const baseline = comparisonSelector(required("baseline"), "baseline");
    const currentValue = options.current ?? options.commit;
    if (typeof currentValue !== "string" || currentValue.length === 0) {
      throw configurationError("--current is required with --baseline (or provide --commit as its alias)");
    }
    comparisonRequest = { baseline, current: comparisonSelector(currentValue, "current") };
  }
  const packageName = required("package"); const version = required("version");
  const created = await request("/v1/incidents", { method: "POST", body: { ecosystem: "npm", packageName, affectedVersions: [version], ...(options.from === undefined ? {} : { startsAt: parseTime(String(options.from), "from") }), ...(options.to === undefined ? {} : { endsAt: parseTime(String(options.to), "to") }), ...(options.environment === undefined ? {} : { environments: [String(options.environment)] }) } });
  const incidentId = String(created.incident.id);
  if (comparisonRequest !== undefined) {
    const comparisonResponse = await request(
      `/v1/incidents/${encodeURIComponent(incidentId)}/comparison`,
      {
        method: "POST",
        body: {
          baseline: comparisonRequest.baseline,
          current: comparisonRequest.current,
          ...(options.environment === undefined
            ? {}
            : { environments: [String(options.environment)] }),
        },
      },
    );
    output(comparisonResponse);
    const status = comparisonStatus(comparisonResponse);
    if (status === "BLOCK") throw gateError("HydraTrace baseline gate found a new reachable high-risk path", 1);
    if (status === "INCONCLUSIVE") throw gateError("HydraTrace baseline comparison is inconclusive and failed closed", 2);
    return;
  }
  const at = options.at === undefined ? undefined : parseTime(String(options.at), "at");
  const result = gate
    ? await completeBlastRadius(incidentId, at)
    : await request(blastRadiusPath(incidentId, at));
  output(result);
  if (gate) {
    const blocking = (result.findings as Array<{ risk: { label: string }; reachability: number }>).some((finding) =>
      ["Critical", "High"].includes(finding.risk.label) && [2, 3, 4].includes(finding.reachability));
    if (blocking) throw gateError("HydraTrace gate found a reachable high-risk exposure", 1);
  }
}

function comparisonSelector(value: string, name: "baseline" | "current"): Record<string, string> {
  if (/^snapshot:\d+$/u.test(value)) {
    return { kind: "snapshot", snapshotId: value.slice("snapshot:".length) };
  }
  if (/^scan:\d+$/u.test(value)) {
    return { kind: "scan", scanId: value.slice("scan:".length) };
  }
  const commitSha = value.startsWith("commit:") ? value.slice("commit:".length) : value;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(commitSha)) {
    throw configurationError(
      `--${name} must be snapshot:<id>, scan:<id>, or an exact 40/64-hex commit SHA; symbolic refs such as ${JSON.stringify(value)} are mutable`,
    );
  }
  const repositoryId = required("repository");
  return { kind: "commit", repositoryId, commitSha: commitSha.toLowerCase() };
}

function comparisonStatus(value: unknown): "PASS" | "BLOCK" | "INCONCLUSIVE" {
  if (value === null || typeof value !== "object") {
    throw new Error("HydraTrace API returned an invalid baseline comparison");
  }
  const comparison = (value as Record<string, unknown>).comparison;
  if (comparison === null || typeof comparison !== "object") {
    throw new Error("HydraTrace API returned an invalid baseline comparison");
  }
  const status = (comparison as Record<string, unknown>).status;
  if (status !== "PASS" && status !== "BLOCK" && status !== "INCONCLUSIVE") {
    throw new Error("HydraTrace API returned an invalid baseline comparison status");
  }
  const record = comparison as Record<string, unknown>;
  const baseline = record.baseline;
  const current = record.current;
  const paths = record.newBlockingPaths;
  const reasons = record.reasons;
  if (
    !validComparisonEvidenceSummary(baseline) ||
    !validComparisonEvidenceSummary(current) ||
    !Array.isArray(paths) ||
    !Array.isArray(reasons) ||
    (status === "PASS" && (paths.length !== 0 || reasons.length !== 0)) ||
    (status === "BLOCK" && (paths.length === 0 || reasons.length !== 0)) ||
    (status === "INCONCLUSIVE" && reasons.length === 0)
  ) {
    throw new Error("HydraTrace API returned an internally inconsistent baseline comparison");
  }
  return status;
}

function validComparisonEvidenceSummary(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const summary = value as Record<string, unknown>;
  return typeof summary.evidenceFingerprint === "string" &&
    /^[0-9a-f]{64}$/u.test(summary.evidenceFingerprint) &&
    [summary.totalFindings, summary.totalPaths, summary.blockingPaths].every(
      (count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
    );
}

async function completeBlastRadius(incidentId: string, at?: number): Promise<any> {
  const pageSize = 100;
  let offset = 0;
  let expectedTotal: number | undefined;
  let firstPage: any;
  const findings: unknown[] = [];
  while (expectedTotal === undefined || findings.length < expectedTotal) {
    if (offset > 100_000) throw new Error("HydraTrace gate cannot safely paginate more than 100000 findings");
    const page = await request(blastRadiusPath(incidentId, at, offset, pageSize));
    if (typeof page !== "object" || page === null || !Array.isArray(page.findings) ||
      !Number.isSafeInteger(page.totalFindings) || page.totalFindings < 0) {
      throw new Error("HydraTrace API returned an invalid blast-radius page");
    }
    const pageTotal = page.totalFindings as number;
    if (expectedTotal === undefined) {
      expectedTotal = pageTotal;
      firstPage = page;
    } else if (pageTotal !== expectedTotal) {
      throw new Error("HydraTrace blast radius changed while the gate was paginating; retry the gate");
    }
    findings.push(...page.findings);
    if (findings.length > expectedTotal) {
      throw new Error("HydraTrace API returned overlapping blast-radius pages");
    }
    if (findings.length === expectedTotal) break;
    if (page.findings.length === 0) {
      throw new Error("HydraTrace API returned an incomplete blast-radius page");
    }
    offset = findings.length;
  }
  return { ...firstPage, offset: 0, limit: findings.length, findings };
}

function blastRadiusPath(incidentId: string, at?: number, offset?: number, limit?: number): string {
  const query = new URLSearchParams();
  if (at !== undefined) query.set("at", String(at));
  if (offset !== undefined) query.set("offset", String(offset));
  if (limit !== undefined) query.set("limit", String(limit));
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  return `/v1/incidents/${encodeURIComponent(incidentId)}/blast-radius${suffix}`;
}

async function pollScanToTerminal(
  accepted: unknown,
  deadline: RequestDeadline,
  pollIntervalMs: number,
): Promise<ScanStatus> {
  let status = scanStatus(accepted);
  while (!terminalScanStages.has(status.stage)) {
    const remaining = deadline.at - Date.now();
    if (remaining <= 0) throw scanTimeout(deadline.timeoutMs);
    await delay(Math.min(pollIntervalMs, remaining));
    if (Date.now() >= deadline.at) throw scanTimeout(deadline.timeoutMs);
    status = scanStatus(await request(`/v1/scans/${encodeURIComponent(status.scanId)}`, undefined, deadline));
  }
  if (status.stage !== "COMPLETE") {
    const detail = status.error === undefined ? "no server error detail" : status.error;
    throw new Error(`HydraTrace scan ${status.scanId} ended ${status.stage}: ${detail}`);
  }
  return status;
}

async function request(
  path: string,
  init?: { method?: string; body?: unknown },
  deadline?: RequestDeadline,
): Promise<any> {
  const remaining = deadline === undefined ? undefined : deadline.at - Date.now();
  if (remaining !== undefined && remaining <= 0) throw scanTimeout(deadline!.timeoutMs);
  const signal = remaining === undefined ? undefined : AbortSignal.timeout(Math.max(1, remaining));
  let response: Response;
  try {
    response = await fetch(`${api}${path}`, {
      method: init?.method ?? "GET",
      headers: init?.body === undefined ? {} : { "content-type": "application/json" },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted && deadline !== undefined) throw scanTimeout(deadline.timeoutMs);
    throw error;
  }
  let value: any;
  try {
    value = await response.json() as any;
  } catch {
    throw new Error(`${response.status} HydraTrace API returned a non-JSON response`);
  }
  if (!response.ok) throw new Error(`${response.status} ${value.message ?? value.error ?? response.statusText}`);
  return value;
}

function output(value: any): void {
  const format = String(options.format ?? "json");
  if (format === "json") process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (format === "sarif") process.stdout.write(`${JSON.stringify(toSarif(value), null, 2)}\n`);
  else if (format === "table") {
    if (value?.comparison !== undefined) {
      const comparison = value.comparison as {
        status: string;
        baseline?: { blockingPaths?: number };
        current?: { blockingPaths?: number };
        newBlockingPaths?: Array<{
          serviceId: string;
          environment: string;
          affectedPackageName: string;
          affectedVersion: string;
          path: Array<{ packageName: string; version: string }>;
        }>;
      };
      process.stdout.write(
        `STATUS\tBASELINE_BLOCKING\tCURRENT_BLOCKING\tNEW_BLOCKING\n${comparison.status}\t${comparison.baseline?.blockingPaths ?? 0}\t${comparison.current?.blockingPaths ?? 0}\t${comparison.newBlockingPaths?.length ?? 0}\n`,
      );
      for (const path of comparison.newBlockingPaths ?? []) {
        process.stdout.write(
          `${path.serviceId}\t${path.environment}\t${path.affectedPackageName}@${path.affectedVersion}\t${path.path.map(({ packageName, version }) => `${packageName}@${version}`).join(" -> ")}\n`,
        );
      }
    }
    else if (Array.isArray(value.findings)) { process.stdout.write("SERVICE\tENVIRONMENT\tPACKAGE\tRISK\tPATHS\n"); for (const finding of value.findings) process.stdout.write(`${finding.serviceId}\t${finding.environment}\t${finding.affectedPackageName}@${finding.affectedVersion}\t${finding.risk.label}\t${finding.pathCount}\n`); }
    else process.stdout.write(`Scan ${value.scanId}: ${value.stage}\n`);
  } else throw configurationError("--format must be json, sarif, or table");
}

function toSarif(value: any): unknown {
  const comparisonPaths = Array.isArray(value?.comparison?.newBlockingPaths)
    ? value.comparison.newBlockingPaths
    : undefined;
  const findings = comparisonPaths ?? (Array.isArray(value.findings) ? value.findings : []);
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: { driver: { name: "HydraTrace", rules: [{ id: "HT-SUPPLY-CHAIN-EXPOSURE", shortDescription: { text: "Affected dependency path" } }] } },
      results: findings.map((finding: any) => ({
        ruleId: "HT-SUPPLY-CHAIN-EXPOSURE",
        level: comparisonPaths !== undefined || finding.risk?.label === "Critical" || finding.risk?.label === "High" ? "error" : "warning",
        message: {
          text: comparisonPaths === undefined
            ? `${finding.serviceId} contains ${finding.affectedPackageName}@${finding.affectedVersion} through ${finding.pathCount} path(s)`
            : `${finding.serviceId} introduces a reachable ${finding.affectedPackageName}@${finding.affectedVersion} path`,
        },
        properties: comparisonPaths === undefined
          ? { findingId: finding.findingId, evidenceRefs: finding.evidenceRefs }
          : { signature: finding.signature, environment: finding.environment, path: finding.path },
      })),
    }],
  };
}
function parseOptions(values: string[]): Options { const output: Options = {}; for (let index = 0; index < values.length; index += 1) { const token = values[index]!; if (!token.startsWith("--")) throw configurationError(`Unexpected argument ${token}`); const key = token.slice(2); const next = values[index + 1]; if (next === undefined || next.startsWith("--")) output[key] = true; else { output[key] = next; index += 1; } } return output; }
function required(name: string): string { const value = options[name]; if (typeof value !== "string" || value.length === 0) throw configurationError(`--${name} is required`); return value; }
function integerOption(name: string, fallback: number, maximum: number): number { const value = options[name]; if (value === undefined) return fallback; if (typeof value !== "string" || !/^\d+$/u.test(value)) throw configurationError(`--${name} must be a positive integer`); const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw configurationError(`--${name} must be between 1 and ${maximum}`); return parsed; }
function parseTime(value: string, name: string): number { const parsed = Date.parse(value); if (!Number.isFinite(parsed)) throw configurationError(`--${name} must be an ISO timestamp`); return parsed; }
function scanStatus(value: unknown): ScanStatus { if (typeof value !== "object" || value === null) throw new Error("HydraTrace API returned an invalid scan status"); const candidate = value as Record<string, unknown>; const scanId = candidate.scanId; const stage = candidate.stage; if ((typeof scanId !== "string" && typeof scanId !== "number") || !scanStages.has(stage as ScanStage)) throw new Error("HydraTrace API returned an invalid scan status"); return { ...candidate, scanId: String(scanId), stage: stage as ScanStage, ...(typeof candidate.error === "string" ? { error: candidate.error } : {}) }; }
function scanTimeout(timeoutMs: number): Error { return new Error(`HydraTrace scan timed out after ${timeoutMs} ms`); }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function gateError(message: string, exitCode: 1 | 2): Error { const error = new Error(message) as Error & { exitCode: number }; error.exitCode = exitCode; return error; }
function configurationError(message: string): Error { const error = new Error(message) as Error & { exitCode: number }; error.exitCode = 3; return error; }
