# Local HydraDB infrastructure gate

HydraTrace pins the public HydraDB v0.1.1 multi-architecture image by digest:

```text
ghcr.io/hydra-db/hydradb:0.1.1@sha256:db78309a233be54662db29744047e985a39b51c45a270d1a1f47c31a62cdb709
```

The local stack runs a private graph node and a separate indexer against a persistent, S3-compatible MinIO bucket. This matches HydraDB's object-store design and avoids the v0.1.1 local-filesystem indexer limitation around conditional cursor updates. The HydraDB auth token is generated locally and ignored by Git; the committed MinIO credentials are development-only and are reachable only inside the Compose network.

MinIO is also pinned for reproducibility:

```text
quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e
quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727
```

## Run

1. Install and start Docker Desktop.
2. From PowerShell at the repository root, run:

```powershell
pnpm gate:hydradb
```

The TypeScript command is the cross-platform primary gate. The PowerShell script
remains available for Windows environments whose endpoint protection permits local
PowerShell automation.

The gate creates an immutable four-node/three-edge fixture, reads it back, verifies one exact three-hop path, checks idempotent re-import, requires at least three healthy indexer cycles with zero failures, restarts the graph node, proves persistence causally, performs one lossless strong path query, and confirms the indexer remains healthy afterward.

MinIO data and HydraDB caches are retained under `infra/local/data`. The script does not remove containers or data. Stop services without deleting storage using:

```powershell
docker compose -f .\infra\local\docker-compose.yml stop
```

Do not expose ports 7687, 8443, 9090, or 9091 beyond localhost.

Do not delete `infra/local/data/minio` while relying on the persistence evidence. `docker compose stop` is the safe shutdown command.
