# Benchmarks

Measurements must identify the implementation under test. Reference-store numbers
are not presented as HydraDB performance.

## 2026-08-16 reference graph run

Command: `pnpm benchmark -- 10000`

| Measurement | Result |
|---|---:|
| Resolution instances generated | 10,000 |
| Canonical graph node records | 30,001 |
| Graph relationships | 39,999 |
| Idempotent reference-store write | 715.40 ms |
| Bounded 16-hop path query | 9.27 ms |
| Returned paths | 1 |
| Process RSS after run | 246,591,488 bytes |

Environment: Windows, Node.js 24.15.0, in-process `InMemoryGraphStore`. This is a
correctness/reference measurement used to detect regressions. The HydraDB result is
recorded separately because it includes Bolt serialization, database execution, and
strong-consistency object-store reads.

The generator is deterministic and can be rerun with a different size:

```powershell
pnpm benchmark -- 10000
$env:HYDRADB_BOLT_URI = "bolt://127.0.0.1:7687"
$env:HYDRADB_HTTP_URL = "http://127.0.0.1:8443"
$env:HYDRADB_AUTH_TOKEN_FILE = "infra/local/secrets/auth-token"
$env:HYDRADB_NAMESPACE = "development"
$env:HYDRADB_CONSISTENCY = "strong"
pnpm benchmark -- 1000 --hydradb
```

## 2026-08-16 live HydraDB run

Command: the environment above with `pnpm benchmark -- 100 --hydradb`.

| Measurement | Result |
|---|---:|
| Resolution instances generated | 100 |
| Canonical graph node records | 301 |
| Graph relationships | 399 |
| First write through Bolt to MinIO | 58,013.31 ms |
| Strong 16-hop path through HTTP | 1,191.39 ms |
| Returned paths | 1 |
| Client process RSS after run | 81,317,888 bytes |

Environment: Windows 11, Docker Desktop, Node.js 24.15.0, pinned HydraDB
v0.1.1, separate indexer, and local persistent MinIO. The measurement includes
network serialization, object-storage work, and strong-reader refresh.

A 1,000-resolution first-write run was also attempted and is recorded as a
capacity finding rather than a successful benchmark: a write batch exceeded
HydraDB v0.1.1's fixed 29,999 ms query-runtime limit. HydraTrace therefore uses
ten-record read batches for this release and treats large imports as resumable,
idempotent jobs. No throughput claim is made from the failed run.
