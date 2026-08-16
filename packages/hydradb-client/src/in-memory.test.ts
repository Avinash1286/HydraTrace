import { stableIdFromCanonicalKey, type StableId } from "@hydratrace/domain";
import type {
  GraphNodeRecord,
  GraphRecords,
  GraphRelationshipRecord,
} from "@hydratrace/graph-schema";
import { describe, expect, it } from "vitest";
import { GraphConflictError, MissingGraphEndpointError } from "./graph-store.js";
import { InMemoryGraphStore } from "./in-memory.js";
import { createHydraDbSmokeFixture, runHydraDbSmokeProbe } from "./smoke.js";

describe("InMemoryGraphStore", () => {
  it("reports exact created and existing counts for an idempotent import", async () => {
    const store = new InMemoryGraphStore();
    const fixture = createHydraDbSmokeFixture();

    const first = await store.write(fixture.records);
    const second = await store.write(fixture.records);

    expect(first).toEqual({
      nodes: { created: 4, existing: 0, total: 4 },
      relationships: { created: 3, existing: 0, total: 3 },
    });
    expect(second).toEqual({
      nodes: { created: 0, existing: 4, total: 4 },
      relationships: { created: 0, existing: 3, total: 3 },
    });
  });

  it("returns the exact ordered bounded dependency path", async () => {
    const store = new InMemoryGraphStore();
    const fixture = createHydraDbSmokeFixture();
    const result = await runHydraDbSmokeProbe(store);

    expect(result.pathCount).toBe(1);
    expect(result.orderedPath).toEqual(fixture.expectedPath);
  });

  it("selects nodes and relationships by graph-native predicates", async () => {
    const store = new InMemoryGraphStore();
    const fixture = createHydraDbSmokeFixture();
    await store.write(fixture.records);
    const target = fixture.records.nodes.at(-1)!;
    if (target.label !== "Resolution") throw new Error("invalid fixture target");

    const nodes = await store.matchNodes({
      label: "Resolution",
      equals: { packageName: target.properties.packageName, version: target.properties.version },
      limit: 10,
    });
    const relationships = await store.matchRelationships({
      type: "DEPENDS_ON_INSTANCE",
      to: { id: target.id, label: "Resolution" },
      limit: 10,
    });

    expect(nodes.map(({ id }) => id)).toEqual([target.id]);
    expect(relationships).toHaveLength(1);
    expect(relationships[0]?.to.id).toBe(target.id);
  });

  it("reuses canonical facts observed by a later import run", async () => {
    const store = new InMemoryGraphStore();
    const fixture = createHydraDbSmokeFixture();
    await store.write(fixture.records);
    const laterNodes = fixture.records.nodes.map((node) => ({
      ...node,
      properties: {
        ...node.properties,
        observedAt: 1_786_704_000_000,
        importRunId: stableIdFromCanonicalKey("later-import"),
      },
    })) as GraphNodeRecord[];

    await expect(
      store.write({ nodes: laterNodes, relationships: fixture.records.relationships }),
    ).resolves.toMatchObject({
      nodes: { created: 0, existing: 4 },
      relationships: { created: 0, existing: 3 },
    });
    const stored = await store.getNodes([fixture.records.nodes[0]?.id as StableId]);
    expect(stored[0]?.properties).toMatchObject({ observedAt: 0 });
  });

  it("preserves first-seen metadata for a content-addressed snapshot", async () => {
    const store = new InMemoryGraphStore();
    const snapshotId = stableIdFromCanonicalKey("snapshot:stable");
    const snapshot: GraphNodeRecord<"LockfileSnapshot"> = {
      id: snapshotId,
      label: "LockfileSnapshot",
      properties: {
        ecosystem: "npm",
        lockfileType: "package-lock",
        contentHash: "a".repeat(64),
        sha256: "a".repeat(64),
        repositoryId: "repo",
        commitSha: "commit",
        sourceRef: "package-lock.json",
        parserVersion: "0.1.0",
        createdAt: 1,
      },
    };
    await store.write({ nodes: [snapshot], relationships: [] });
    await expect(
      store.write({
        nodes: [
          {
            ...snapshot,
            properties: { ...snapshot.properties, createdAt: 2 },
          },
        ],
        relationships: [],
      }),
    ).resolves.toMatchObject({ nodes: { created: 0, existing: 1 } });
    const stored = await store.getNodes([snapshotId]);
    expect(stored[0]?.properties).toMatchObject({ createdAt: 1 });
  });

  it("rejects canonical-ID conflicts without partially committing", async () => {
    const store = new InMemoryGraphStore();
    const fixture = createHydraDbSmokeFixture();
    const first = fixture.records.nodes[0];
    if (first === undefined || first.label !== "Resolution") {
      throw new Error("invalid test fixture");
    }
    const conflict: GraphNodeRecord<"Resolution"> = {
      ...first,
      properties: { ...first.properties, installPath: "different" },
    };

    await expect(
      store.write({ nodes: [first, conflict], relationships: [] }),
    ).rejects.toBeInstanceOf(GraphConflictError);
    await expect(store.getNodes([first.id])).resolves.toEqual([]);
  });

  it("rejects missing endpoints atomically", async () => {
    const store = new InMemoryGraphStore();
    const fixture = createHydraDbSmokeFixture();
    const node = fixture.records.nodes[0];
    const relationship = fixture.records.relationships[0];
    if (node === undefined || relationship === undefined) {
      throw new Error("invalid test fixture");
    }
    const records: GraphRecords = { nodes: [node], relationships: [relationship] };

    await expect(store.write(records)).rejects.toBeInstanceOf(
      MissingGraphEndpointError,
    );
    await expect(store.getNodes([node.id])).resolves.toEqual([]);
  });

  it("enumerates multiple simple paths and honors the limit", async () => {
    const store = new InMemoryGraphStore();
    const makeId = (name: string): StableId =>
      stableIdFromCanonicalKey(`path-test:${name}`);
    const [a, b, c, d] = ["a", "b", "c", "d"].map(makeId) as [
      StableId,
      StableId,
      StableId,
      StableId,
    ];
    const template = createHydraDbSmokeFixture().records.nodes[0];
    if (template === undefined || template.label !== "Resolution") {
      throw new Error("invalid test fixture");
    }
    const nodes = [a, b, c, d].map(
      (id): GraphNodeRecord<"Resolution"> => ({ ...template, id }),
    );
    const relationship = (
      from: StableId,
      to: StableId,
    ): GraphRelationshipRecord<"DEPENDS_ON_INSTANCE"> => ({
      ...createHydraDbSmokeFixture().records.relationships[0],
      id: stableIdFromCanonicalKey(`path-test:${from}:${to}`),
      type: "DEPENDS_ON_INSTANCE",
      from: { id: from, label: "Resolution" },
      to: { id: to, label: "Resolution" },
    } as GraphRelationshipRecord<"DEPENDS_ON_INSTANCE">);
    await store.write({
      nodes,
      relationships: [
        relationship(a, b),
        relationship(b, d),
        relationship(a, c),
        relationship(c, d),
      ],
    });

    const paths = await store.findPaths({
      from: { id: a, label: "Resolution" },
      to: { id: d, label: "Resolution" },
      relationshipType: "DEPENDS_ON_INSTANCE",
      maxDepth: 2,
      limit: 1,
    });
    expect(paths).toHaveLength(1);
    expect(paths[0]?.nodeIds).toHaveLength(3);
  });
});
