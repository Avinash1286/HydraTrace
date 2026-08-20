import {
  createHydraDbSmokeFixture,
  HydraDbGraphStore,
  hydraDbConnectionOptionsFromEnv,
  runHydraDbSmokeProbe,
} from "@hydratrace/hydradb-client";

const store = HydraDbGraphStore.connect(hydraDbConnectionOptionsFromEnv());
try {
  await store.verifyConnectivity();
  process.stdout.write("HydraDB smoke: write/read/path probe started.\n");
  const first = await runHydraDbSmokeProbe(store);
  process.stdout.write("HydraDB smoke: write/read/path probe passed.\n");
  const secondWrite = await store.write(createHydraDbSmokeFixture().records);
  if (secondWrite.nodes.created !== 0 || secondWrite.relationships.created !== 0) {
    throw new Error("Repeated HydraDB smoke import was not idempotent");
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "passed",
        firstWrite: first.write,
        secondWrite,
        readNodeCount: first.readNodeCount,
        readRelationshipCount: first.readRelationshipCount,
        matchedNodeCount: first.matchedNodeCount,
        matchedRelationshipCount: first.matchedRelationshipCount,
        pathCount: first.pathCount,
        orderedPath: first.orderedPath,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await store.close();
}
