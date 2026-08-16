import {
  HydraDbGraphStore,
  hydraDbConnectionOptionsFromEnv,
  runHydraDbSmokeProbe,
} from "@hydratrace/hydradb-client";

const store = HydraDbGraphStore.connect(hydraDbConnectionOptionsFromEnv());
try {
  await store.verifyConnectivity();
  const first = await runHydraDbSmokeProbe(store);
  const second = await runHydraDbSmokeProbe(store);
  if (second.write.nodes.created !== 0 || second.write.relationships.created !== 0) {
    throw new Error("Repeated HydraDB smoke import was not idempotent");
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "passed",
        firstWrite: first.write,
        secondWrite: second.write,
        readNodeCount: second.readNodeCount,
        readRelationshipCount: second.readRelationshipCount,
        matchedNodeCount: second.matchedNodeCount,
        matchedRelationshipCount: second.matchedRelationshipCount,
        pathCount: second.pathCount,
        orderedPath: second.orderedPath,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await store.close();
}
