import { describe, expect, it, vi } from "vitest";
import {
  readHydraDbIndexerSnapshot,
  waitForHydraDbIndexerVisibility,
  type HydraDbIndexerSnapshot,
} from "./indexer-visibility.js";

const baseline: HydraDbIndexerSnapshot = {
  ready: true,
  successfulCycles: 7,
  consecutiveFailedCycles: 0,
  generationsPublished: { DEPENDS_ON_INSTANCE: 2 },
};

describe("HydraDB indexer visibility", () => {
  it("parses readiness, cycle, failure, and edge-generation metrics", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/readyz")) return new Response("ready", { status: 200 });
      return new Response([
        "# TYPE graph_indexer_ready gauge",
        "graph_indexer_ready 1",
        "graph_indexer_successful_cycles 12",
        "graph_indexer_consecutive_failed_cycles 0",
        'graph_indexer_generations_published{graph_id="default",edge_type="DEPENDS_ON_INSTANCE"} 3',
        'graph_indexer_generations_published{graph_id="default",edge_type="CONTAINS"} 4',
        'graph_indexer_generations_published{graph_id="another",edge_type="DEPENDS_ON_INSTANCE"} 99',
        "",
      ].join("\n"), { status: 200 });
    });

    await expect(readHydraDbIndexerSnapshot("http://indexer.internal/", fetchMock as typeof fetch))
      .resolves.toEqual({
        ready: true,
        successfulCycles: 12,
        consecutiveFailedCycles: 0,
        generationsPublished: { DEPENDS_ON_INSTANCE: 3, CONTAINS: 4 },
      });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits for a later healthy cycle with the required published generation", async () => {
    let clock = 0;
    const probe = vi.fn()
      .mockResolvedValueOnce({ ...baseline, ready: false })
      .mockResolvedValueOnce({
        ...baseline,
        successfulCycles: 8,
        consecutiveFailedCycles: 1,
      })
      .mockResolvedValueOnce({
        ...baseline,
        successfulCycles: 8,
        generationsPublished: { CONTAINS: 3 },
      })
      .mockResolvedValueOnce({
        ...baseline,
        successfulCycles: 8,
        generationsPublished: { DEPENDS_ON_INSTANCE: 3 },
      });

    const snapshot = await waitForHydraDbIndexerVisibility({
      probe,
      timeoutMs: 50,
      pollIntervalMs: 5,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    }, baseline, "DEPENDS_ON_INSTANCE");

    expect(snapshot.successfulCycles).toBe(8);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(clock).toBe(15);
  });

  it("fails closed at the bounded deadline with diagnostic state", async () => {
    let clock = 0;
    await expect(waitForHydraDbIndexerVisibility({
      probe: async () => baseline,
      timeoutMs: 10,
      pollIntervalMs: 4,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    }, baseline, "DEPENDS_ON_INSTANCE")).rejects.toThrow(
      /fresh healthy cycle.*successfulCycles=7/u,
    );
    expect(clock).toBe(10);
  });
});
