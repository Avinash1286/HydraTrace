# Acceptance audit

| Plan claim | Evidence | Status |
|---|---|---|
| Exact npm versions/topology | Three lockfile fixture suites and exact counts | Passed |
| Exact/current/historical blast radius | Incident and seeded property-graph tests | Passed |
| Safe/dev-only negative controls | Known-answer fixture assertions | Passed |
| Idempotent durable graph | Live write twice, restart, read again | Passed |
| Separate healthy indexer | Admin readiness and zero failed cycles | Passed |
| Convex retries/progress | Lease/reclaim code and 7 production scan events | Passed |
| Reachability/neighborhood reasons | Static/runtime and neighborhood tests | Passed |
| Remediation coverage/verification | Exact/greedy tests and strong zero-path guard | Passed |
| Grounded AI/fallback | Schema/citation/circuit/fallback tests | Passed |
| Public application | Vercel web/engine HTTP 200 and production scan | Passed |
| Graph/timeline/evidence/report UI | Production browser DOM and interaction checks | Passed |
| CI gate | Vercel build runs verify + fixture gate; no GitHub Action by request | Passed |
| Private production HydraDB | Zerops code/config ready; account activation required | Blocked on owner |
| Cloudflare AI Worker | Worker code/typecheck ready; account login/secrets required | Blocked on owner |
| Three-minute video/submission | Script ready in `docs/demo-script.md` | Manual owner task |

The public Vercel deployment is honest about its boundary: Convex workflow state is
durable, while graph persistence is still the reference store until private Zerops
activation. The local live HydraDB evidence is not presented as a Vercel database claim.
