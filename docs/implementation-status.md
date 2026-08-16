# Implementation status — 2026-08-16

## Complete and verified

- canonical IDs, provenance, temporal contracts, package-lock and pnpm parsing;
- idempotent graph conversion/writes and deployment-manifest validation;
- exact/temporal blast radius, bounded paths, risk, reachability, neighborhood reasons;
- safe remediation simulation, set cover, before/after diff, strong zero-path verification;
- OSV, deps.dev, and npm metadata clients with bounded caches;
- CLI, Markdown/JSON/SARIF reports, grounded copilot, deterministic fallback;
- Convex development and production deployments with Storage uploads, signed dispatch,
  ordered callbacks, leases, watchdog reclaim, and five-attempt retry scheduling;
- Next.js dashboard and Fastify engine production deployments on Vercel;
- live pinned HydraDB/MinIO/indexer persistence and strong-read gate;
- exact Small/Medium/Large reference benchmarks and a separate live HydraDB control.

Verification snapshot:

```text
pnpm verify         22 files / 84 tests passed
pnpm scan:fixture   3 snapshots, 72 nodes, 102 relationships, retry 0/0
pnpm gate:hydradb   persistence, idempotency, indexer, restart, strong path passed
Vercel              web + engine + /system HTTP 200; rendered workflow checked
Convex              production Storage scan completed with 9 signed progress events
Benchmark           250,000 nodes / 1,000,000 edges reference profile completed
```

## Account-owned activation remaining

The code is complete, but two external deployments cannot be activated without
the account owner:

1. Cloudflare: authorize `wrangler`, set the gateway secret, and deploy the Worker.
2. Zerops: provide an access token/project, Object Storage, two services, and graph secret.

The public Vercel engine currently uses its in-memory reference graph while Convex
durably stores workflow state. It must not be described as production graph
persistence until the private Zerops HydraDB connection is activated.
