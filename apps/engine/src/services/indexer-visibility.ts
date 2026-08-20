// Convex reclaims jobs without a heartbeat after 120 seconds. Leave enough
// headroom for the terminal callback even when the indexer is unavailable.
export const INDEXER_VISIBILITY_TIMEOUT_MS = 90_000;
export const INDEXER_VISIBILITY_POLL_INTERVAL_MS = 1_000;

export interface HydraDbIndexerSnapshot {
  ready: boolean;
  successfulCycles: number;
  consecutiveFailedCycles: number;
  generationsPublished: Readonly<Record<string, number>>;
}

export interface HydraDbIndexerMonitor {
  probe: () => Promise<HydraDbIndexerSnapshot>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface HydraDbIndexerMonitorOptions {
  fetch?: typeof fetch;
  graphId?: string;
}

export function hydraDbIndexerMonitor(
  adminUrl: string,
  options: HydraDbIndexerMonitorOptions = {},
): HydraDbIndexerMonitor {
  const normalized = adminUrl.trim().replace(/\/$/u, "");
  if (normalized.length === 0) {
    throw new Error("HYDRADB_INDEXER_ADMIN_URL is required for HydraDB scan completion");
  }
  const graphId = options.graphId?.trim() || "default";
  return {
    probe: () => readHydraDbIndexerSnapshot(normalized, options.fetch ?? fetch, graphId),
  };
}

export async function readHydraDbIndexerSnapshot(
  adminUrl: string,
  fetchImplementation: typeof fetch = fetch,
  graphId = "default",
): Promise<HydraDbIndexerSnapshot> {
  const normalized = adminUrl.trim().replace(/\/$/u, "");
  if (normalized.length === 0) throw new Error("HydraDB indexer admin URL is empty");
  const [health, metricsResponse] = await Promise.all([
    fetchImplementation(`${normalized}/readyz`, { signal: AbortSignal.timeout(2_000) }),
    fetchImplementation(`${normalized}/metrics`, { signal: AbortSignal.timeout(2_000) }),
  ]);
  if (!metricsResponse.ok) {
    throw new Error(`HydraDB indexer metrics returned HTTP ${metricsResponse.status}`);
  }
  const metrics = await metricsResponse.text();
  const readyMetric = requiredMetric(metrics, "graph_indexer_ready");
  const successfulCycles = requiredMetric(metrics, "graph_indexer_successful_cycles");
  const consecutiveFailedCycles = requiredMetric(
    metrics,
    "graph_indexer_consecutive_failed_cycles",
  );
  const generationsPublished: Record<string, number> = {};
  for (const sample of metricSamples(metrics, "graph_indexer_generations_published")) {
    const sampleGraphId = labelValue(sample.labels, "graph_id");
    if (sampleGraphId !== undefined && sampleGraphId !== graphId) continue;
    const edgeType = labelValue(sample.labels, "edge_type") ?? "*";
    generationsPublished[edgeType] =
      (generationsPublished[edgeType] ?? 0) + sample.value;
  }
  return {
    ready: health.ok && readyMetric === 1,
    successfulCycles,
    consecutiveFailedCycles,
    generationsPublished,
  };
}

export async function waitForHydraDbIndexerVisibility(
  monitor: HydraDbIndexerMonitor,
  baseline: HydraDbIndexerSnapshot,
  requiredGenerationEdgeType?: string,
): Promise<HydraDbIndexerSnapshot> {
  const timeoutMs = monitor.timeoutMs ?? INDEXER_VISIBILITY_TIMEOUT_MS;
  const pollIntervalMs = monitor.pollIntervalMs ?? INDEXER_VISIBILITY_POLL_INTERVAL_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("HydraDB indexer visibility timeout must be a positive integer");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error("HydraDB indexer poll interval must be a positive integer");
  }
  const now = monitor.now ?? Date.now;
  const sleep = monitor.sleep ?? delay;
  const deadline = now() + timeoutMs;
  let lastState = describeSnapshot(baseline, requiredGenerationEdgeType);
  let lastError: string | undefined;

  while (true) {
    try {
      const snapshot = await monitor.probe();
      lastState = describeSnapshot(snapshot, requiredGenerationEdgeType);
      lastError = undefined;
      const generationVisible = requiredGenerationEdgeType === undefined
        ? Object.values(snapshot.generationsPublished).some((count) => count > 0)
        : (snapshot.generationsPublished[requiredGenerationEdgeType] ?? 0) > 0;
      if (
        snapshot.ready &&
        snapshot.consecutiveFailedCycles === 0 &&
        snapshot.successfulCycles > baseline.successfulCycles &&
        generationVisible
      ) {
        return snapshot;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  throw new Error(
    `HydraDB indexer did not expose a fresh healthy cycle and published generation within ${timeoutMs} ms. ` +
      `Last state: ${lastError ?? lastState}`,
  );
}

interface MetricSample {
  labels?: string;
  value: number;
}

function requiredMetric(metrics: string, name: string): number {
  const samples = metricSamples(metrics, name);
  if (samples.length === 0) throw new Error(`HydraDB indexer metric ${name} is missing`);
  return Math.max(...samples.map(({ value }) => value));
}

function metricSamples(metrics: string, name: string): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const rawLine of metrics.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{([^}]*)\})?\s+([^\s]+)(?:\s+\d+)?$/u.exec(line);
    if (match?.[1] !== name) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`HydraDB indexer metric ${name} is not a nonnegative finite number`);
    }
    samples.push({
      ...(match[2] === undefined ? {} : { labels: match[2] }),
      value,
    });
  }
  return samples;
}

function labelValue(labels: string | undefined, name: string): string | undefined {
  if (labels === undefined) return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`(?:^|,)\\s*${escaped}="((?:\\\\.|[^"])*)"`, "u").exec(labels);
  if (match?.[1] === undefined) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

function describeSnapshot(
  snapshot: HydraDbIndexerSnapshot,
  requiredGenerationEdgeType: string | undefined,
): string {
  const generation = requiredGenerationEdgeType === undefined
    ? Object.values(snapshot.generationsPublished).reduce((total, count) => total + count, 0)
    : snapshot.generationsPublished[requiredGenerationEdgeType] ?? 0;
  return `ready=${snapshot.ready} successfulCycles=${snapshot.successfulCycles} ` +
    `consecutiveFailedCycles=${snapshot.consecutiveFailedCycles} generation=${generation}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
