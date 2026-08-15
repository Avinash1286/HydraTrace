# Implementation status

## August 15–16 foundation

Completed locally:

- fresh Git and pnpm workspace baseline;
- deterministic nonnegative 63-bit canonical IDs;
- exact graph schema and evidence provenance contracts;
- `package-lock.json` v2/v3 parser;
- `pnpm-lock.yaml` v6–v9 parser, including peer contexts and preserved workspace links;
- immutable snapshot, resolution, package, package-version, deployment, and service graph records;
- idempotent in-memory reference store and HydraDB adapter contract;
- Acme Commerce fixtures with exact expected paths and negative controls;
- deployment-manifest normalization;
- OSV querybatch pagination, full-record retrieval, and content-addressed caching;
- Fastify health, readiness, exact lockfile-ingestion, and OSV endpoints;
- pinned local and Zerops HydraDB node/indexer configurations.

Reproducible checks:

```text
pnpm verify         TypeScript plus deterministic unit/integration tests
pnpm scan:fixture   Three repositories, exact graph counts, zero duplicate retry
pnpm smoke:osv      Real exact-version OSV query with local response cache
```

Infrastructure-dependent gate:

```powershell
.\infra\local\Invoke-PersistenceGate.ps1
```

That gate cannot run until Docker Desktop is installed and started. The equivalent Zerops gate requires the user's Zerops project, private Object Storage service, and secret configuration. A listening port or readiness response does not count as completion; persistence, relationship-specific indexing, and the exact three-hop path must all pass.

## Not part of this milestone

Blast-radius incident queries, temporal replay, reachability, neighborhood intelligence, remediation, Convex orchestration, the web product, and AI are subsequent milestones. The current engine endpoints are an ingestion foundation, not a finished public API.
