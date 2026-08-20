# Production gate — 2026-08-20 NPT

## Result

**PENDING — do not cite this document as a production pass.**

The Vercel fallback surface and Cloudflare gateway have live evidence below, but
the durable Zerops topology is blocked before HydraDB can start. Two independently
provisioned Zerops Object Storage services rejected their generated credentials
with `SignatureDoesNotMatch`. Consequently, the production persistence,
indexer, strong-graph, restart, and Vercel-to-Zerops checks remain pending.

## Release identity

| Field | Value |
|---|---|
| Commit SHA | PENDING |
| Worktree clean | PENDING |
| Operator/time window | Automated/operator validation on 2026-08-20 NPT; final repository freeze pending |
| Public web | <https://hydratrace.vercel.app> |
| Zerops engine readiness URL | PENDING: `https://<engine>/ready` |
| Vercel fallback readiness | <https://hydratrace-engine.vercel.app/ready> |
| Convex | `https://accomplished-skunk-643.convex.cloud` |
| Cloudflare gateway | `https://hydratrace-ai-gateway.abinashyadav3-141.workers.dev` |

Approved topology variance: the public web and stateless fallback engine are on
Vercel; the durable graph engine is beside HydraDB in Zerops. There are no
GitHub Actions.

## Repository and local evidence already recorded

- [Local HydraDB gate](2026-08-16-hydradb-local-gate.md): persisted exact
  four-node/three-edge graph and path across restart; 16 successful/0 failed
  indexer cycles in the latest recorded rerun; eight fixed-seed shapes matched.
- Frozen local check on 2026-08-20: 38 test files / 161 tests, known-answer
  fixture gate, production web build, and the final local HydraDB persistence,
  indexer, restart, strong-path, and eight-shape gates passed. These do not
  substitute for the pending Zerops checks.
- [AI evaluation](2026-08-20-ai-evaluation.md): the original 4-file/28-test
  contract gate and the post-observation 2-file/30-test fallback rerun passed.

## Candidate-worktree preflight

| Check | Expected | Observed | Status |
|---|---|---|---|
| `pnpm install --frozen-lockfile` | Exit 0 | Exit 0 | Passed |
| `pnpm verify` | All typechecks/tests pass | 38 files / 161 tests | Passed |
| `pnpm scan:fixture` | 3 snapshots; 72 nodes; 102 relationships; repeat 0/0 | Exact expected values | Passed |
| `pnpm gate:hydradb` | Persistence, indexer, restart, strong path, 8 shapes pass | Final local run passed all phases | Passed |
| `pnpm --filter @hydratrace/web build` | Production export succeeds | Next.js static production build passed | Passed |
| `git diff --check` | No whitespace errors | Exit 0 on the candidate changes; final freeze still pending | Passed |
| Candidate-file secret scan | No credentials/private keys | No private-key, GitHub-token, AWS-key, JWT, Cloudflare-token, or Zerops-token patterns in tracked/new candidate files | Passed |

## Zerops infrastructure

| Check | Expected | Observed | Status |
|---|---|---|---|
| Object Storage S3 preflight | Bucket stat succeeds; no credential output | Both the original and a fresh replacement service rejected their Zerops-generated secret with `SignatureDoesNotMatch` under S3 Signature V4 and V2; latest support ID `YBkYNhAMQWupEYgkryiJbA` | **Blocked on Zerops platform support** |
| Graph node readiness | Private `/readyz` 200 | Latest init preflight failed against the replacement store; no running container | Blocked by Object Storage |
| Indexer readiness | Private `/readyz` 200 | Not deployed because the graph node cannot start safely | Blocked by Object Storage |
| Indexer cycles | Successful cycles advance; consecutive failures 0 | PENDING | Pending |
| Published generation | `DEPENDS_ON_INSTANCE` generation present | PENDING | Pending |
| Engine liveness | Public `/health` 200 | Zerops graph-backed engine not deployed | Blocked by Object Storage |
| Dependency readiness | `/ready` 200; provider HydraDB; indexer configured/healthy | Zerops graph-backed engine not deployed | Blocked by Object Storage |
| Operator status | `/v1/system` reports strong HydraDB and healthy indexer | Zerops graph-backed engine not deployed | Blocked by Object Storage |
| Private-port boundary | Bolt/graph admin/indexer admin/object storage not public | Node public-subdomain control remained disabled; final boundary check requires a successful deployment | Pending after platform repair |

The replacement was created only after the original empty Object Storage service
had been checked and removed. The same independent signed-read/write failure on
the replacement establishes a managed-credential blocker; no secret value is
recorded here. The remaining Zerops rows must not be waived or replaced with the
stateless Vercel reference store.

## Exact graph and incident facts

Run on a fresh production namespace, then repeat the identical import.

| Check | Expected | Observed | Status |
|---|---|---|---|
| Fresh aggregate write | 72 nodes, 102 relationships | PENDING | Pending |
| Exact repeat | 0 nodes, 0 relationships created | PENDING | Pending |
| Production incident | 2 services, 3 complete paths, no truncation | Vercel reference fallback returned 2 services / 3 complete paths | Passed on fallback; Zerops pending |
| Production services | `checkout-api`, `payment-worker` | Both expected services returned on the fallback | Passed on fallback; Zerops pending |
| Development included | 3 services, 5 complete paths | Vercel reference fallback returned 3 services / 5 complete paths | Passed on fallback; Zerops pending |
| Temporal at `1786784640000` | only `checkout-api` | Vercel reference fallback returned only `checkout-api` and one path | Passed on fallback; Zerops pending |
| Safe analytics production path | excluded from affected production result | Analytics appeared only when development was included, not in the production result | Passed on fallback; Zerops pending |
| Reachability | checkout static; payment test-observed; unknowns preserved | Fallback returned checkout reachability 2 (static) and payment reachability 3 (test-observed) | Passed on fallback; Zerops pending |
| Repeat demo restore | same facts; no duplicate graph records | Local HydraDB: 8 snapshots, 2/3, 0 writes after restart; cached repeat 25 ms | Passed locally |

## Durable scan orchestration

| Check | Expected | Observed | Status |
|---|---|---|---|
| Web/engine scan acceptance | 202 `QUEUED` from Convex-backed route | Live Vercel endpoint returned 202 and durable scan `4284897158552418765` completed on attempt 1 | Passed |
| Ordered stages | QUEUED → DISPATCHING → ACKNOWLEDGED → ACQUIRING → PARSING → WRITING_GRAPH → ENRICHING → INDEXING → WAITING_FOR_INDEX → ANALYZING → COMPLETE | Event history returned all 11 stages in this exact order | Passed |
| Signed dispatch/callback | Production job completes with matching idempotency key | Signed Vercel ↔ Convex chain reached `COMPLETE`; acknowledgement and all engine callbacks were durably projected | Passed |
| Unsigned internal dispatch | 401 | Live Vercel engine returned 401 | Passed |
| Unsigned Convex progress callback | 401 | Live Convex HTTP callback returned 401 | Passed |
| Duplicate submission | same durable scan identity; no duplicate graph write | Two identical submissions returned scan `7396119732311414141`, the same idempotency key, one attempt, and one terminal result | Passed on fallback |
| Cancellation/retry projection | terminal state/events remain queryable | PENDING | Pending |

## Enrichment and remediation

| Check | Expected | Observed | Status |
|---|---|---|---|
| Exact OSV identity | query/result package+version order preserved | Live durable fixture scan checked 10 exact package versions successfully; identity/order and mismatch rejection remain covered by the frozen tests | Passed on fallback and in tests |
| External outage behavior | unavailable/partial, never false-safe | Bounded failure/partial behavior passed the frozen enrichment tests | Passed in tests |
| Demo candidate discovery | 3 `LOCKFILE_VERIFIED` candidates labeled `built-in-fictional-fixture`, cached simulation, no npm/OSV claim | Browser flow returned the three expected hash-pinned fictional-fixture candidates | Passed on fallback |
| Demo upgrades | checkout-framework 2.0.1; telemetry-core 3.2.1; queue-runtime 4.0.1 | PENDING | Pending |
| Plan coverage | every original production path covered | PENDING | Pending |
| Fixed-snapshot coverage | every affected service represented | PENDING | Pending |
| Strong verification | status VERIFIED; level STRONG_GRAPH; remaining paths 0 | Fallback correctly returned `INCONCLUSIVE` / `REFERENCE_GRAPH` with 0 remaining paths | Correct fallback boundary; Zerops pending |
| Unverified/tampered candidate | rejected or remains inconclusive | PENDING | Pending |

## AI

| Check | Expected | Observed | Status |
|---|---|---|---|
| Engine → Worker authentication | Success only with current shared secret | Four live provider-backed questions succeeded; unsigned Worker generate request returned 401 | Passed |
| Provider-backed response | provider identifies Cloudflare gateway path | Four live answers identified `hydratrace-ai-gateway` | Passed |
| Evidence grounding | every returned reference belongs to supplied set | All five live answers returned only allowed references; injected `E-INVENTED` was removed | Passed |
| Unknown preservation | production runtime unknown remains visible | Runtime answer retained no-production-runtime confirmation and one unknown | Passed |
| Provider failure | deterministic grounded fallback remains usable | After redeploy, the live deterministic fallback answered the analytics production negative directly, preserved scoped uncertainty, and returned only allowed references | Passed |

Cloudflare Worker version `e71fa895-6ca7-4e43-81a4-201f8a8863c1` is deployed.
`/health` returned success, and unsigned `/v1/generate` returned 401.

## Restart persistence

After all preceding facts pass, restart the graph node and engine without
deleting/replacing Object Storage.

| Check | Expected | Observed | Status |
|---|---|---|---|
| Graph node restart | returns ready against same object store | PENDING | Pending |
| Engine restart | returns dependency-ready | PENDING | Pending |
| Counts after restart | same graph counts | PENDING | Pending |
| Incident after restart | same 2 services / 3 paths | PENDING | Pending |
| Indexer after restart | fresh successful cycle; 0 consecutive failures | PENDING | Pending |
| Remediation record after restart | VERIFIED / STRONG_GRAPH / 0 remains queryable | PENDING | Pending |

## Vercel and browser

| Check | Expected | Observed | Status |
|---|---|---|---|
| Web API origin | rendered app names final Zerops engine host | App names `hydratrace-engine.vercel.app`, the intentional reference fallback | Passed for fallback; Zerops repoint pending |
| CORS | Vercel origin succeeds; unapproved origin not allowed | `https://hydratrace.vercel.app` received allow-origin; `https://example.invalid` did not | Passed |
| Incognito load | no authentication/cache prerequisite | Public browser walkthrough passed; separate final incognito capture not recorded | Pending final capture |
| Restore | completes and shows 3 paths | Fallback overview showed 3 paths and 2 production services | Passed on fallback |
| Incident/evidence | cards, exact path, drawer render | Incident center showed 2 services and 3 complete paths | Passed on fallback |
| Timeline | temporal controls change exposure | Full event list and temporal view rendered and responded | Passed on fallback |
| Graph | nodes/edges render and remain responsive | 9 visible nodes, 9 relationships, and 3 displayed/exact paths | Passed on fallback |
| Reports | Markdown, JSON, SARIF downloads work | All returned 200 with the expected content types (782, 8443, and 2037 bytes) | Passed on fallback |
| Remediation | READY → VERIFIED visible from UI | Candidate flow worked; verification honestly remained `INCONCLUSIVE` / `REFERENCE_GRAPH` | Correct fallback boundary; Zerops pending |
| Copilot | answer, refs, unknowns, provider visible | Browser answer rendered with deterministic-template provider and 10 allowed references | Passed on fallback |
| Engineering page | HydraDB strong/indexer state visible | Correctly reported `in-memory-reference`, `reference`, indexer not configured | Passed for fallback; Zerops pending |
| Browser console/network | no unexpected error/5xx | PENDING | Pending |

## Final decision

The public Vercel fallback is usable and its tested surface passes, but it is not
the planned durable graph topology and cannot produce `STRONG_GRAPH` verification.
Set this record to **PASSED** only after Zerops repairs or rotates the managed
Object Storage credentials, every required durable row above has an observed
value, the deployed commit matches the frozen repository, and no release-blocking
error remains. If any row is skipped, record why and keep the overall result pending.
