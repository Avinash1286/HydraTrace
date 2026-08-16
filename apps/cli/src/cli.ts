#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

interface Options { [key: string]: string | boolean | undefined; }
const [command, ...tokens] = process.argv.slice(2);
const options = parseOptions(tokens);
const api = String(options.api ?? process.env.HYDRATRACE_API_URL ?? "http://127.0.0.1:4100").replace(/\/$/u, "");

try {
  if (command === "scan") await scan();
  else if (command === "incident") await incident(false);
  else if (command === "gate") await incident(true);
  else throw configurationError("Usage: hydratrace <scan|incident|gate> [options]");
} catch (error) {
  const value = error as Error & { exitCode?: number };
  process.stderr.write(`${value.message}\n`);
  process.exitCode = value.exitCode ?? 2;
}

async function scan(): Promise<void> {
  const lockfilePath = required("lockfile");
  const content = await readFile(lockfilePath, "utf8");
  const repositoryId = String(options.repository ?? "local/repository");
  const commitSha = String(options.commit ?? "working-tree");
  const body: Record<string, unknown> = { content, sourceRef: basename(lockfilePath), repositoryId, commitSha, observedAt: Date.now() };
  if (options.environment !== undefined) {
    const environment = String(options.environment);
    body.deploymentManifest = JSON.stringify({ schemaVersion: 1, organizationId: String(options.organization ?? "local"), repositoryId, serviceId: String(options.service ?? basename(process.cwd())), environment, commitSha, startedAt: String(options.startedAt ?? new Date().toISOString()), endedAt: null, lockfile: basename(lockfilePath) });
  }
  const result = await request("/v1/scans", { method: "POST", body });
  output(result);
}

async function incident(gate: boolean): Promise<void> {
  const packageName = required("package"); const version = required("version");
  const created = await request("/v1/incidents", { method: "POST", body: { ecosystem: "npm", packageName, affectedVersions: [version], ...(options.from === undefined ? {} : { startsAt: parseTime(String(options.from), "from") }), ...(options.to === undefined ? {} : { endsAt: parseTime(String(options.to), "to") }), ...(options.environment === undefined ? {} : { environments: [String(options.environment)] }) } });
  const result = await request(`/v1/incidents/${created.incident.id}/blast-radius${options.at === undefined ? "" : `?at=${parseTime(String(options.at), "at")}`}`);
  output(result);
  if (gate) {
    const blocking = (result.findings as Array<{ risk: { label: string }; reachability: number }>).some((finding) => ["Critical", "High"].includes(finding.risk.label) && finding.reachability >= 2);
    if (blocking) { const error = new Error("HydraTrace gate found a reachable high-risk exposure") as Error & { exitCode: number }; error.exitCode = 1; throw error; }
  }
}

async function request(path: string, init?: { method?: string; body?: unknown }): Promise<any> {
  const response = await fetch(`${api}${path}`, { method: init?.method ?? "GET", headers: init?.body === undefined ? {} : { "content-type": "application/json" }, ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  const value = await response.json() as any; if (!response.ok) throw new Error(`${response.status} ${value.message ?? value.error ?? response.statusText}`); return value;
}

function output(value: any): void {
  const format = String(options.format ?? "json");
  if (format === "json") process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (format === "sarif") process.stdout.write(`${JSON.stringify(toSarif(value), null, 2)}\n`);
  else if (format === "table") {
    if (Array.isArray(value.findings)) { process.stdout.write("SERVICE\tENVIRONMENT\tPACKAGE\tRISK\tPATHS\n"); for (const finding of value.findings) process.stdout.write(`${finding.serviceId}\t${finding.environment}\t${finding.affectedPackageName}@${finding.affectedVersion}\t${finding.risk.label}\t${finding.pathCount}\n`); }
    else process.stdout.write(`Scan ${value.scanId}: ${value.stage}\n`);
  } else throw configurationError("--format must be json, sarif, or table");
}

function toSarif(value: any): unknown { const findings = Array.isArray(value.findings) ? value.findings : []; return { version: "2.1.0", $schema: "https://json.schemastore.org/sarif-2.1.0.json", runs: [{ tool: { driver: { name: "HydraTrace", rules: [{ id: "HT-SUPPLY-CHAIN-EXPOSURE", shortDescription: { text: "Affected dependency path" } }] } }, results: findings.map((finding: any) => ({ ruleId: "HT-SUPPLY-CHAIN-EXPOSURE", level: finding.risk.label === "Critical" || finding.risk.label === "High" ? "error" : "warning", message: { text: `${finding.serviceId} contains ${finding.affectedPackageName}@${finding.affectedVersion} through ${finding.pathCount} path(s)` }, properties: { findingId: finding.findingId, evidenceRefs: finding.evidenceRefs } })) }] }; }
function parseOptions(values: string[]): Options { const output: Options = {}; for (let index = 0; index < values.length; index += 1) { const token = values[index]!; if (!token.startsWith("--")) throw configurationError(`Unexpected argument ${token}`); const key = token.slice(2); const next = values[index + 1]; if (next === undefined || next.startsWith("--")) output[key] = true; else { output[key] = next; index += 1; } } return output; }
function required(name: string): string { const value = options[name]; if (typeof value !== "string" || value.length === 0) throw configurationError(`--${name} is required`); return value; }
function parseTime(value: string, name: string): number { const parsed = Date.parse(value); if (!Number.isFinite(parsed)) throw configurationError(`--${name} must be an ISO timestamp`); return parsed; }
function configurationError(message: string): Error { const error = new Error(message) as Error & { exitCode: number }; error.exitCode = 3; return error; }
