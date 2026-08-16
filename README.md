# HydraTrace

HydraTrace is an evidence-first software-supply-chain incident command system.
It turns exact npm lockfile topology into temporal deployment exposure, code and
runtime reachability, explainable risk, and remediation plans that are accepted
only after a zero-path graph verification.

Production demo: <https://hydratrace.vercel.app>

Engine API: <https://hydratrace-engine.vercel.app>

Operator status: <https://hydratrace.vercel.app/system>

## What is implemented

- exact `package-lock.json` v2/v3 and `pnpm-lock.yaml` v6-v9 normalization;
- deterministic nonnegative 63-bit IDs and provenance on every imported fact;
- immutable snapshots, deployments, half-open time intervals, and historical replay;
- HydraDB v0.1.1 Bolt writes/causal reads plus lossless strong HTTP path reads;
- exact blast radius, complete bounded paths, truncation flags, and negative controls;
- static TypeScript reachability, CommonJS/ESM runtime evidence, and honest dynamic unknowns;
- maintainer, infrastructure, and name-similarity neighborhood reasons;
- deterministic risk components and evidence references;
- lockfile-only, `--ignore-scripts` remediation simulation and exact/greedy set cover;
- Markdown, JSON, and SARIF reports plus a command-line client;
- Convex-backed scan state/events, leases, retries, incidents, and AI-run cache;
- grounded AI with Cloudflare Workers AI, NVIDIA NIM fallback, and deterministic fallback;
- a responsive Next.js/Cytoscape incident workspace deployed on Vercel.

## Run locally

Requirements: Node.js 24+, pnpm 10.33.0, and Docker Desktop for the live graph gate.

```powershell
pnpm install
pnpm verify
pnpm scan:fixture
pnpm gate:hydradb
pnpm start:engine
```

In another terminal:

```powershell
$env:NEXT_PUBLIC_HYDRATRACE_API_URL = "http://127.0.0.1:4100"
pnpm dev:web
```

`pnpm gate:hydradb` starts pinned HydraDB, indexer, and MinIO containers; proves
idempotency and exact counts; restarts the graph node; and requires one exact
strong-consistency three-hop path. Stop without deleting data with:

```powershell
docker compose -f infra/local/docker-compose.yml stop
```

## Useful commands

| Command | Purpose |
|---|---|
| `pnpm verify` | Root, web, and Worker typechecks plus deterministic tests |
| `pnpm scan:fixture` | Three known-answer imports and duplicate-write proof |
| `pnpm gate:hydradb` | Live persistence/indexer/restart/strong-path gate |
| `pnpm benchmark -- --profile=large` | Exact 250k-node/1m-edge reference benchmark |
| `pnpm cli -- --help` | Scan, incident, gate, JSON/table/SARIF CLI |
| `pnpm exec convex dev --once` | Validate and push the development control plane |
| `pnpm exec convex deploy --yes` | Push the production Convex deployment |

## Documentation

- [Architecture](docs/architecture.md)
- [Correctness gates](docs/correctness.md)
- [Acceptance audit](docs/acceptance.md)
- [Graph model](docs/graph-model.md)
- [HydraDB compatibility](docs/hydradb-compatibility.md)
- [Benchmarks](docs/benchmarks.md)
- [Security](docs/security.md)
- [Deployment](docs/deployment.md)
- [Attribution](docs/attribution.md)

## Deployment boundary

The public Vercel engine is a stateless compute/demo layer. Convex durably stores
scan orchestration, but graph persistence remains authoritative only in the
local or private Zerops HydraDB deployment. Raw Bolt must not be exposed to the
public internet to connect Vercel. See `docs/deployment.md` for the remaining
account-owned Cloudflare and Zerops activation steps.

## License

Original HydraTrace application code is Apache-2.0 licensed. Dependencies retain
their own licenses; see `docs/attribution.md`.
