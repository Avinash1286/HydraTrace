# Local HydraDB infrastructure gate

HydraTrace pins the public HydraDB v0.1.1 multi-architecture image by digest:

```text
ghcr.io/hydra-db/hydradb:0.1.1@sha256:db78309a233be54662db29744047e985a39b51c45a270d1a1f47c31a62cdb709
```

The local stack runs a private graph node and a separate indexer against a shared durable directory. The auth token is generated locally and ignored by Git.

## Run

1. Install and start Docker Desktop.
2. From PowerShell at the repository root, run:

```powershell
.\infra\local\Invoke-PersistenceGate.ps1
```

The gate creates an immutable four-node/three-edge fixture, reads it back, verifies one exact three-hop path, checks idempotent re-import, waits for a relationship-specific index generation, restarts the graph node, and repeats the strong read.

Data is retained under `infra/local/data`. The script does not remove containers or data. Stop services without deleting storage using:

```powershell
docker compose -f .\infra\local\docker-compose.yml stop
```

Do not expose ports 7687, 8443, 9090, or 9091 beyond localhost.
