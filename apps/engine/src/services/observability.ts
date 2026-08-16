import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

const counterNames = [
  "hydratrace_jobs_total",
  "hydratrace_packages_parsed_total",
  "hydratrace_graph_nodes_written_total",
  "hydratrace_graph_edges_written_total",
  "hydratrace_external_api_errors_total",
  "hydratrace_remediation_simulations_total",
  "hydratrace_ai_fallbacks_total",
] as const;

type CounterName = (typeof counterNames)[number];

export class EngineMetrics {
  readonly #counters = new Map<CounterName, number>(counterNames.map((name) => [name, 0]));
  readonly #jobDurations: number[] = [];
  readonly #requestDurations: number[] = [];

  increment(name: CounterName, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Metric increment must be nonnegative and finite");
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + amount);
  }

  observeJob(seconds: number): void { this.#observe(this.#jobDurations, seconds); }
  observeRequest(seconds: number): void { this.#observe(this.#requestDurations, seconds); }

  snapshot(): Record<string, number> {
    return {
      ...Object.fromEntries(this.#counters),
      hydratrace_job_duration_seconds_count: this.#jobDurations.length,
      hydratrace_job_duration_seconds_sum: sum(this.#jobDurations),
      hydratrace_job_duration_seconds_p95: percentile(this.#jobDurations, 0.95),
      hydratrace_http_request_duration_seconds_count: this.#requestDurations.length,
      hydratrace_http_request_duration_seconds_p95: percentile(this.#requestDurations, 0.95),
    };
  }

  prometheus(extra: Record<string, string | number>): string {
    const values = { ...this.snapshot(), ...extra };
    return `${Object.entries(values).map(([name, value]) => {
      if (typeof value === "number") return `# TYPE ${name} gauge\n${name} ${Number.isFinite(value) ? value : 0}`;
      return `hydratrace_info{${name}=${JSON.stringify(value)}} 1`;
    }).join("\n")}\n`;
  }

  #observe(target: number[], seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    target.push(seconds);
    if (target.length > 10_000) target.splice(0, target.length - 10_000);
  }
}

export function installRequestObservability(application: FastifyInstance, metrics: EngineMetrics): void {
  const starts = new WeakMap<object, number>();
  application.addHook("onRequest", async (request, reply) => {
    starts.set(request, performance.now());
    const inbound = request.headers["x-hydratrace-trace-id"];
    const traceId = typeof inbound === "string" && /^[A-Za-z0-9_.:-]{8,256}$/u.test(inbound)
      ? inbound
      : randomUUID();
    reply.header("x-hydratrace-trace-id", traceId);
  });
  application.addHook("onResponse", async (request) => {
    const started = starts.get(request);
    if (started !== undefined) metrics.observeRequest((performance.now() - started) / 1_000);
  });
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

