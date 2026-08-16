# HydraDB local persistence gate — 2026-08-16 NPT

## Result

Passed on Windows with Docker Desktop 4.86.0 / Engine 29.7.2 using:

```text
ghcr.io/hydra-db/hydradb:0.1.1@sha256:db78309a233be54662db29744047e985a39b51c45a270d1a1f47c31a62cdb709
quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e
quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727
```

Command:

```powershell
pnpm gate:hydradb
```

Final output:

```text
HydraDB persistence, idempotency, indexing, and three-hop path gate passed.
```

## Observed proof

- Initial write: 4 nodes and 3 relationships created.
- Immediate repeat: 0 nodes and 0 relationships created; all 4/3 records already existed.
- Causal read: exactly 4 nodes, 3 relationships, and 1 path.
- Strong HTTP read: exactly one ordered three-hop path with lossless 63-bit IDs.
- Ordered path: `5041991480064782097 -> 8424545952126751068 -> 4380326079291741543 -> 7779488087436019082`.
- After graph-node restart: the same 4 nodes, 3 relationships, and exact ordered path remained; both writes created 0 records.
- Post-gate indexer admin endpoint: HTTP 200.
- Post-gate indexer metrics: ready 1; 11 cycles; 11 successful; 0 failed; 0 consecutive failures; 1 `DEPENDS_ON_INSTANCE` generation published.

## Repository checks from the same run

```text
pnpm verify        -> typecheck passed; 53/53 tests passed
pnpm scan:fixture  -> 3 snapshots; 72 nodes; 102 relationships; repeat created 0/0
```

The earlier filesystem-backed indexer attempt is not counted as evidence: HydraDB v0.1.1 published its first generation and then lost readiness because its local object-store adapter does not support the conditional cursor update used by later cycles. The committed gate uses persistent MinIO, requires at least three healthy cycles with zero consecutive failures, restarts the node, and finishes with a strong exact-path query.
