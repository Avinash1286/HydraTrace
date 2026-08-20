# HydraTrace

HydraTrace is an evidence-first software-supply-chain incident command system.
It turns exact npm lockfile topology into temporal deployment exposure, code and
runtime reachability, explainable risk, and remediation plans that are accepted
only after a zero-path graph verification.

- Public application: <https://hydratrace.vercel.app>
- Durable Zerops-engine readiness: <https://hydratraceengine-2d0a-4100.prg1.zerops.app/ready>
- Vercel fallback-engine health: <https://hydratrace-engine.vercel.app/ready>
- Operator view: <https://hydratrace.vercel.app/system>

The first URL is the UI. Engine URLs are APIs, so link to `/ready` or
`/v1/system` rather than presenting an engine's bare root as an application.

## What is implemented

- exact `package-lock.json` v2/v3 and `pnpm-lock.yaml` v6-v9 normalization;
- deterministic nonnegative 63-bit IDs and provenance on every imported fact;
- immutable snapshots, deployments, half-open time intervals, and historical replay;
- HydraDB v0.1.1 serialized Bolt scalar operations through the compatible
  `neo4j-driver` 5.27.0 negotiation path, plus lossless causal/strong HTTP path reads;
- graph-store-backed blast radius, bounded complete paths, truncation guards, and negative controls;
- repository/ZIP source acquisition, static JavaScript/TypeScript reachability,
  CommonJS/ESM runtime evidence, and explicit dynamic unknowns;
- exact-version OSV enrichment with bounded npm-registry/deps.dev context;
- maintainer, infrastructure, and name-similarity neighborhood reasons;
- deterministic risk components and evidence references;
- provider-checked, lockfile-only `--ignore-scripts` remediation simulation,
  weighted set cover, and strong zero-path verification;
- Markdown, JSON, and SARIF reports plus a command-line client;
- Convex-backed scan state/events, signed dispatch, leases, retries, and cancellation;
- grounded AI with Cloudflare Workers AI, optional NVIDIA NIM fallback, and a
  deterministic no-credential fallback;
- a responsive Next.js/Cytoscape incident workspace deployed on Vercel.

## Run locally without Docker

Requirements: Node.js 24+ and pnpm 10.33.0. Docker is not required for this
mode, and no API key is needed for the restorable Acme demo.

```powershell
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install --frozen-lockfile
pnpm verify
pnpm scan:fixture
pnpm start:engine
```

In another terminal:

```powershell
$env:NEXT_PUBLIC_HYDRATRACE_API_URL = "http://127.0.0.1:4100"
pnpm dev:web
```

Open <http://127.0.0.1:3000>, choose **Restore Acme demo**, and use the incident,
graph, timeline, evidence, package-neighborhood, report, and copilot views. This
mode uses the deterministic in-memory graph store. `/ready` still reports the
mode explicitly as `in-memory-reference`; `/health` is liveness only. Copilot
uses its grounded deterministic template when no AI provider is configured.

Normal scans may call the public OSV, npm-registry, and deps.dev APIs. Set
`HYDRATRACE_SCAN_ENRICHMENT=false` for an offline parser/graph run; that result is
correctly labeled `not-run`, never “no known advisories.”

## Run locally with real HydraDB

Docker Desktop is required only for this persistence-backed mode:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
pnpm gate:hydradb
```

The gate starts pinned HydraDB, indexer, and MinIO containers; proves
idempotency and exact counts; restarts the graph node; requires one exact
strong-consistency three-hop path; and compares every complete path for eight
fixed-seed graph shapes against an independent reference enumerator. Its
180-second smoke wrapper accommodates the verified cold-start read path. To make
the engine's readiness check include the local indexer, add this to `.env`:

```text
HYDRADB_INDEXER_ADMIN_URL=http://127.0.0.1:9091
```

Then start the same engine and web commands shown above. In HydraDB mode,
`GET /ready` returns `503` unless the graph connection succeeds and the
configured separate indexer is healthy. Stop the containers without deleting
the persisted graph:

```powershell
docker compose -f .\infra\local\docker-compose.yml stop
```

## Input and verification boundaries

- Repository acquisition accepts only canonical public `https://github.com/owner/repo`
  URLs. ZIP/repository archives are capped at 4 MB compressed and inspected in
  memory; repository or package scripts are never run.
- Repository and ZIP scans can infer entrypoints and analyze bounded JavaScript
  and TypeScript source. A lockfile-only upload has no source reachability unless
  a static-analysis document or runtime trace is supplied.
- OSV exact package/version queries establish advisory matches. npm metadata and
  deps.dev are supplemental and cannot turn an OSV failure into a safe result.
- Automatic remediation currently supports npm `package-lock.json`. It requires
  the exact `package.json` and matching lockfile for every affected snapshot,
  refuses provider uncertainty, and runs as a non-root process with scripts disabled.
- The explicitly fictional restore uses a separate, hash-pinned
  `built-in-fictional-fixture` candidate set and cached simulation. It never
  claims those demonstration versions exist in npm or OSV.
- `LOCKFILE_VERIFIED` means the regenerated lockfile contains no affected path.
  Overall `VERIFIED` additionally requires fixed snapshots for every covered
  service and a strong HydraDB query returning zero remaining paths.

See [Security](docs/security.md) for the enforced bounds and
[Implementation status](docs/implementation-status.md) for current live-gate status.

## Useful commands

| Command | Purpose |
|---|---|
| `pnpm verify` | Root, web, and Worker typechecks plus deterministic tests |
| `pnpm scan:fixture` | Three known-answer imports and duplicate-write proof |
| `pnpm gate:hydradb` | Live persistence/indexer/restart/strong-path gate |
| `pnpm property:hydradb` | Live fixed-seed HydraDB/reference path comparison |
| `pnpm benchmark -- --profile=large` | Exact 250k-node/1m-edge reference benchmark |
| `pnpm cli -- --help` | Scan, incident, gate, JSON/table/SARIF CLI |
| `pnpm exec convex dev --once` | Validate and push the development control plane |
| `pnpm exec convex deploy` | Push the production Convex deployment |

## Hosting decision

The implementation deliberately varies from `plan.md` in two approved ways:

1. The public web application is on Vercel, with a stateless Vercel engine kept
   as a fallback. The durable graph-backed engine belongs beside HydraDB in Zerops;
   HydraDB persists to the private Cloudflare R2 bucket
   `hydratrace-graph-production` in account
   `59b8589f738de5e4ab643bedd3a4b0a9`.
2. There are no GitHub Actions. Verification runs locally and in the Vercel
   build/deploy path; the CLI remains available for operator-controlled CI.

Raw HydraDB Bolt/HTTP/admin ports and object storage stay private. Vercel never
connects to a publicly exposed Bolt port. See [Deployment](docs/deployment.md)
and [Vercel notes](docs/vercel.md) for the exact topology and environment matrix.

The live cutover is complete. The Vercel web application points to the
R2-backed Zerops engine, the Worker and stateless Vercel fallback were
redeployed with the configured primary/rollover credentials, and Convex
production dispatches to Zerops. A
production scan completed on its first attempt with exactly 11 monotonic events,
and the public browser passed the graph, timeline, neighborhood, Copilot,
strong-remediation, report-download, mobile-overflow, and accessibility flows.
The final local HydraDB gate also passed. The only remaining manual owner work is the
three-minute video and submission. See the
[August 21 R2 cutover evidence](docs/evidence/2026-08-21-r2-cutover.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Implementation status](docs/implementation-status.md)
- [Correctness gates](docs/correctness.md)
- [Acceptance audit](docs/acceptance.md)
- [Graph model](docs/graph-model.md)
- [HydraDB compatibility](docs/hydradb-compatibility.md)
- [Benchmarks](docs/benchmarks.md)
- [Security](docs/security.md)
- [Deployment](docs/deployment.md)
- [Three-minute demo](docs/demo-script.md)
- [Attribution](docs/attribution.md)

## License

Original HydraTrace application code is Apache-2.0 licensed. HydraDB and every
other dependency retain their own licenses; see [Attribution](docs/attribution.md).
