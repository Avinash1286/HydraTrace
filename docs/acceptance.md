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
| Exact npm and pnpm versions/topology | Known-answer parser fixtures and exact counts | Passed in current repository verification |
| August 15 import gate | Three snapshots, 72 nodes, 102 relationships, repeat 0/0 | Passed in final repository gate |
| Deterministic IDs/provenance | Unit/property assertions and duplicate import | Passed in current repository verification |
| Durable local graph | Write, repeat, restart, and exact read | Passed in [local HydraDB record](evidence/2026-08-16-hydradb-local-gate.md) |
| Separate indexer | Ready, successful fresh cycles, no consecutive failures, published generation | Passed locally and healthy in the Zerops API gate |
| Current/historical blast radius | Exact service/deployment/path fixtures and temporal boundary | Passed in current repository verification |
| Graph-native production traversal | HydraDB-backed incident responses before and after restart | Passed in the R2-backed Zerops API gate |
| Safe/development negative controls | Exact fixture assertions | Passed in current repository verification |
| Repository/ZIP source reachability | Bounded acquisition plus static/runtime/unknown tests | Passed in current repository verification |
| Exact advisory enrichment | OSV identity/order/provenance and outage-state tests | Passed in current repository verification |
| Package neighborhoods | Maintainer/infrastructure/typosquat reasons | Passed in current repository verification |
| Provider-backed remediation candidates | Exact source match, registry/OSV rejection, real lockfile simulation | Passed in current repository verification |
| Overall remediation verification | Complete plan, all fixed services, strong zero-path query | Passed on Zerops: `VERIFIED`, `STRONG_GRAPH`, 0 remaining paths, 3 fixed snapshots |
| Convex retries/progress | Signed upload/schedule/dispatch/callback, ordered events, reclaim/retry/cancel | Production scan `3911362687601832470` completed on attempt 1 in 18.058s with exactly 11 monotonic events; the duplicate-acknowledgement race found by the first scan was fixed and regressed |
| Dependency-aware readiness | HydraDB/indexer failure returns 503 while `/health` remains liveness | Passed locally; live Zerops `/ready` returned 200 with graph and indexer healthy |
| Grounded AI/fallback | Schema, allowed references, abstention, auth, provider fallback | Original 4-file/28-test gate, post-fix 2-file/30-test rerun, four live provider answers, and the live deterministic-fallback retest passed; see [AI evaluation](evidence/2026-08-20-ai-evaluation.md) |
| Cloudflare Workers AI | Authenticated engine → Worker → model result with allowed evidence | Worker rollover and redeploy passed; Zerops returned a grounded/high gateway answer with 6 allowed references and 0 unknowns |
| Public application | Vercel web points to ready Zerops engine and full public workflow passes | Passed: final navigation, desktop/mobile overflow, graph legend, active-state accessibility, timeline label, and error-free browser reruns all used the Zerops engine |
| Graph/timeline/evidence/report UI | Current-commit browser interactions and downloaded reports | Graph, timeline, neighborhood, Copilot, and strong remediation passed; Markdown, JSON, and SARIF downloads were valid |
| Restorable demo | Two restores return the same facts without duplicate graph records | R2-backed cold restore retained 8 snapshots with zero duplicate writes and returned 2 production services / 3 paths; cold post-deploy remediation passed without a prior `/v1/demo` call |
| Vercel web instead of Zerops web | Public static UI on Vercel; engine remains beside private HydraDB | Approved variance |
| CI without GitHub Actions | Local/Vercel build gates and CLI; no Actions workflow | Approved variance |
| CLI baseline comparison | Exact immutable snapshot/SHA delta evaluation | Passed locally; symbolic `main` intentionally rejected |
| Three-minute video/submission | Recorded, audible, under three minutes, links checked incognito | Manual owner task |

## Production acceptance numbers

The release fixture requires:

- fresh aggregate write: 72 nodes and 102 relationships;
- repeat write: 0 nodes and 0 relationships created;
- production incident: 2 affected services and 3 complete paths;
- development included: 3 affected services and 5 complete paths;
- temporal boundary at `1786784640000`: only `checkout-api` is exposed;
- ordered scan stages through `COMPLETE`;
- remediation: every covered service has a fixed snapshot, remaining paths are
  zero, verification level is `STRONG_GRAPH`, and status is `VERIFIED`;
- the same facts remain after restarting the graph node and engine.

The repository fixture gate passed with 72 nodes, 102 relationships, and a 0/0
repeat. The R2-backed cold Zerops gate retained 8 durable snapshots with zero
duplicate writes; returned 2 services / 3 paths for production, 3 / 5 with
development, 0 / 0 before exposure, and 2 / 3 during exposure; and completed
remediation as `VERIFIED` / `STRONG_GRAPH` with 0 remaining paths and 3 fixed
snapshots. See [the August 21 R2 cutover record](evidence/2026-08-21-r2-cutover.md).

The prior Zerops-managed Object Storage failure is no longer the active
dependency: the durable stack uses the private Cloudflare R2 bucket
`hydratrace-graph-production`. Worker rollover, fallback redeploy, Convex
dispatch, Vercel web routing, the signed durable scan, and the functional public
browser walkthrough all passed. The final stricter local HydraDB gate passed
with restart idempotency, the exact strong path, all 8 property shapes, and a
fresh published indexer generation. The final responsive/accessibility browser
rerun also passed; the only manual owner task is the three-minute video and
submission.
