# Implementation status — 2026-08-16

## Complete and verified

- canonical IDs, provenance, temporal contracts, package-lock and pnpm parsing;
- idempotent graph conversion/writes and deployment-manifest validation;
- exact/temporal blast radius, bounded paths, risk, reachability, neighborhood reasons;
- safe remediation simulation, set cover, before/after diff, strong zero-path verification;
- OSV, deps.dev, and npm metadata clients with bounded caches;
- CLI, Markdown/JSON/SARIF reports, grounded copilot, deterministic fallback;
- Convex development and production deployments with durable scan events;
- Next.js dashboard and Fastify engine production deployments on Vercel;
- live pinned HydraDB/MinIO/indexer persistence and strong-read gate;
- deterministic 10k reference benchmark and live HydraDB benchmark.

Verification snapshot:

```text
pnpm verify         19 files / 53 tests passed
pnpm scan:fixture   3 snapshots, 72 nodes, 102 relationships, retry 0/0
pnpm gate:hydradb   persistence, idempotency, indexer, restart, strong path passed
Vercel              web + engine HTTP 200; production scan completed
Convex              production scan returned 7 durable ordered events
```

## Account-owned activation remaining

The code is complete, but two external deployments cannot be activated without
the account owner:

1. Cloudflare: authorize `wrangler`, set the gateway secret, and deploy the Worker.
2. Zerops: provide an access token/project, Object Storage, two services, and graph secret.

The public Vercel engine currently uses its in-memory reference graph while Convex
durably stores workflow state. It must not be described as production graph
persistence until the private Zerops HydraDB connection is activated.
