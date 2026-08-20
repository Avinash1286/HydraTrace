# Acceptance audit

Status terms:

- **Passed** — recorded evidence exists for the current implementation area.
- **Implemented / final rerun pending** — code and focused tests exist, but the
  frozen-worktree release command has not yet been captured.
- **Pending live gate** — account infrastructure or current-commit deployment
  still needs direct evidence.
- **Passed on fallback** — verified on the public stateless reference surface,
  but not evidence for the required durable HydraDB topology.
- **Approved variance** — intentionally differs from `plan.md`.
- **Manual** — cannot be completed by repository automation.

| Plan claim | Evidence required | Status |
|---|---|---|
| Exact npm and pnpm versions/topology | Known-answer parser fixtures and exact counts | Passed in frozen local gate |
| August 15 import gate | Three snapshots, 72 nodes, 102 relationships, repeat 0/0 | Passed; recapture in final gate |
| Deterministic IDs/provenance | Unit/property assertions and duplicate import | Passed in frozen local gate |
| Durable local graph | Write, repeat, restart, and exact read | Passed in [local HydraDB record](evidence/2026-08-16-hydradb-local-gate.md) |
| Separate indexer | Ready, successful fresh cycles, no consecutive failures, published generation | Passed locally; Zerops pending |
| Current/historical blast radius | Exact service/deployment/path fixtures and temporal boundary | Passed in frozen local gate |
| Graph-native production traversal | HydraDB-backed incident responses before and after restart | Pending live Zerops gate |
| Safe/development negative controls | Exact fixture assertions | Passed in frozen local gate |
| Repository/ZIP source reachability | Bounded acquisition plus static/runtime/unknown tests | Passed in frozen local gate |
| Exact advisory enrichment | OSV identity/order/provenance and outage-state tests | Passed in frozen local gate |
| Package neighborhoods | Maintainer/infrastructure/typosquat reasons | Passed in frozen local gate |
| Provider-backed remediation candidates | Exact source match, registry/OSV rejection, real lockfile simulation | Passed in frozen local gate |
| Overall remediation verification | Complete plan, all fixed services, strong zero-path query | Implemented; live HydraDB workflow pending |
| Convex retries/progress | Signed upload/schedule/dispatch/callback, ordered events, reclaim/retry/cancel | Production scan completed on attempt 1 with all 11 ordered stages; unsigned engine dispatch and Convex callback each returned 401 |
| Dependency-aware readiness | HydraDB/indexer failure returns 503 while `/health` remains liveness | Passed locally; Zerops pending |
| Grounded AI/fallback | Schema, allowed references, abstention, auth, provider fallback | Original 4-file/28-test gate, post-fix 2-file/30-test rerun, four live provider answers, and the live deterministic-fallback retest passed; see [AI evaluation](evidence/2026-08-20-ai-evaluation.md) |
| Cloudflare Workers AI | Authenticated engine → Worker → model result with allowed evidence | Deployed Worker health/auth passed; four provider-backed grounded answers passed |
| Public application | Vercel web points to ready Zerops engine and full incognito workflow passes | Public fallback walkthrough passed; final Zerops repoint and incognito gate pending |
| Graph/timeline/evidence/report UI | Current-commit browser interactions and downloaded reports | Overview, incident, timeline, graph, reports, and Copilot passed on the Vercel fallback; durable Zerops proof pending |
| Restorable demo | Two restores return the same facts without duplicate graph records | Passed locally; public fallback renders 2 production services / 3 paths; production durable rerun pending |
| Vercel web instead of Zerops web | Public static UI on Vercel; engine remains beside private HydraDB | Approved variance |
| CI without GitHub Actions | Local/Vercel build gates and CLI; no Actions workflow | Approved variance |
| CLI baseline comparison | Exact immutable snapshot/SHA delta evaluation | Passed locally; symbolic `main` intentionally rejected |
| Three-minute video/submission | Recorded, audible, under three minutes, links checked incognito | Manual owner task |

## Production acceptance numbers

The final live fixture must demonstrate:

- fresh aggregate write: 72 nodes and 102 relationships;
- repeat write: 0 nodes and 0 relationships created;
- production incident: 2 affected services and 3 complete paths;
- development included: 3 affected services and 5 complete paths;
- temporal boundary at `1786784640000`: only `checkout-api` is exposed;
- ordered scan stages through `COMPLETE`;
- remediation: every covered service has a fixed snapshot, remaining paths are
  zero, verification level is `STRONG_GRAPH`, and status is `VERIFIED`;
- the same facts remain after restarting the graph node and engine.

Observed values belong only in
[the production-gate record](evidence/2026-08-20-production-gate.md). Until that
record is complete, HydraTrace must not be described as production-complete.

The blocking live dependency is Zerops-managed Object Storage: both the original
empty service and a fresh replacement rejected the generated secret with
`SignatureDoesNotMatch` under signed S3 V4 and V2 requests. Zerops support ID
`YBkYNhAMQWupEYgkryiJbA` tracks the latest failed node deployment. The passing
Vercel reference surface does not waive the pending persistence, indexer,
restart, and `STRONG_GRAPH` rows.
