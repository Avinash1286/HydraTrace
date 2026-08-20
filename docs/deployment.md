# Deployment

## Production topology

```text
Browser
  -> Vercel static web
       -> Zerops public engine
            -> private HydraDB node
            -> private HydraDB indexer
            -> private Cloudflare R2 bucket
            -> Convex durable scheduler
            -> authenticated Cloudflare AI gateway

Vercel fallback engine
  -> in-memory reference graph (no production graph-persistence claim)
```

Active service inventory:

- Web: <https://hydratrace.vercel.app>
- Vercel fallback-engine health: <https://hydratrace-engine.vercel.app/ready>
- Convex production: `https://accomplished-skunk-643.convex.cloud`
- Cloudflare gateway: `https://hydratrace-ai-gateway.hydratrace-ai-gateway.workers.dev`
- Cloudflare account: `59b8589f738de5e4ab643bedd3a4b0a9`
- Private R2 bucket: `hydratrace-graph-production`
- Zerops engine readiness: <https://hydratraceengine-2d0a-4100.prg1.zerops.app/ready>

Only the web URL is a user application. Engine roots return API metadata/JSON;
link an engine as `https://<engine>/ready` or `https://<engine>/v1/system`, not
as a second UI.

The live routing cutover is passed: the Worker and Vercel fallback are
redeployed, Convex production dispatches to Zerops, and the public Vercel web
bundle names the Zerops engine as its API origin. Production scan
`3911362687601832470` completed on attempt 1 with exactly 11 monotonic events,
and the functional public browser workflow passed. The final stricter local
HydraDB gate passed; the responsive/accessibility rerun remains an automated
handoff check.

## Approved variances from `plan.md`

- The public web application is a static Next.js export on Vercel rather than a
  Zerops Node service. The graph-backed engine still runs inside Zerops beside
  private HydraDB.
- A stateless Vercel engine remains available as a fallback/demo boundary. It is
  never described as persistent HydraDB.
- There are no GitHub Actions. Local release commands and the Vercel build are
  the deployment gates; the CLI can be used in operator-owned CI.

## Environment matrix

Never commit values from this table. Use deployment secret stores or ignored
local files. `NEXT_PUBLIC_*` values are embedded in browser JavaScript and must
never contain secrets.

| Target | Variable | Requirement |
|---|---|---|
| Vercel web | `NEXT_PUBLIC_HYDRATRACE_API_URL` | Required; final public Zerops engine origin, no trailing path |
| Zerops engine | `WEB_ORIGIN` | Required; `https://hydratrace.vercel.app` |
| Zerops engine | `CONVEX_URL` | Required for durable scans; Convex cloud URL |
| Zerops engine + Convex | `HYDRATRACE_JOB_SHARED_SECRET` | Required for durable jobs; identical random 32+ character value |
| Convex | `HYDRATRACE_ENGINE_DISPATCH_URL` | Required; final public Zerops engine origin |
| Zerops engine | `AI_GATEWAY_URL` | Required for provider-backed copilot; Worker origin |
| Zerops engine + Worker | `AI_GATEWAY_SHARED_SECRET` | Required for Worker use; identical random 32+ character value |
| Worker | `NVIDIA_API_KEY` | Optional secondary provider |
| Zerops engine | `HYDRATRACE_JOB_STATE_DIR` | Recommended; persistent checkpoint path |
| Zerops engine | `HYDRATRACE_AUTO_SEED_DEMO` | `false`; restore only on explicit UI/API request |
| Any engine | `HYDRATRACE_SCAN_ENRICHMENT` | Optional; set `false` only for explicitly offline scans |
| Any engine | `OSV_BASE_URL` | Optional; defaults to the public OSV API |
| Any engine | `ENGINE_RATE_LIMIT_PER_MINUTE` | Optional positive integer; default 120 |
| Vercel fallback engine | `HYDRATRACE_AUTO_SEED_DEMO` | Optional; `true` is acceptable only for this stateless demo boundary |
| Zerops HydraDB node | `r2AccessKeyId` | Required secret; R2 Object Read & Write token scoped only to the production bucket |
| Zerops HydraDB node | `r2SecretAccessKey` | Required secret; matching one-time R2 secret access key |

The Zerops graph variables are supplied by
[`infra/zerops/zerops.yaml`](../infra/zerops/zerops.yaml): private Bolt/HTTP/admin
addresses, strong consistency, indexer admin URL, graph identity, and the
service-scoped graph token. The storage endpoint is the S3-compatible endpoint
for Cloudflare account `59b8589f738de5e4ab643bedd3a4b0a9`; the bucket is
`hydratrace-graph-production`, and the region is `auto`. The node receives the
bucket-scoped R2 key pair from Zerops secret storage, and the indexer receives
the same values through scoped cross-service references. Never print or copy
those credentials into Vercel.

Local in-memory mode requires none of the secrets above. HydraDB local mode uses
the values in `.env.example` plus
`HYDRADB_INDEXER_ADMIN_URL=http://127.0.0.1:9091`.

## Deployment order

1. Run the frozen-worktree local gates:

   ```powershell
   pnpm install --frozen-lockfile
   pnpm verify
   pnpm scan:fixture
   pnpm gate:hydradb
   git diff --check
   ```

2. Deploy the Cloudflare gateway and set its strong shared secret:

   ```powershell
   pnpm --filter @hydratrace/ai-gateway exec wrangler whoami
   pnpm --filter @hydratrace/ai-gateway exec wrangler secret put AI_GATEWAY_SHARED_SECRET
   pnpm --filter @hydratrace/ai-gateway exec wrangler secret put NVIDIA_API_KEY
   pnpm --filter @hydratrace/ai-gateway deploy
   ```

   Before changing a secret or deploying, require `wrangler whoami` to show an
   identity authorized for Cloudflare account
   `59b8589f738de5e4ab643bedd3a4b0a9`; the `account_id` in `wrangler.jsonc`
   selects a target but does not grant access. Use the matching Cloudflare
   profile or scoped token. `NVIDIA_API_KEY` is optional. Workers AI is provided
   through the committed `AI` binding. The engine must receive the same gateway
   primary secret. During a zero-downtime multi-caller rotation, temporarily
   install the old value as `AI_GATEWAY_ROLLOVER_SHARED_SECRET`, redeploy the
   Worker, move callers to the primary value, and then remove the rollover
   secret.

3. Provision the private Cloudflare R2 bucket, `hydradbnode`, `hydradbindexer`,
   and `hydratraceengine`. Create an R2 Object Read & Write token scoped only to
   `hydratrace-graph-production`, then install its values in the node's Zerops
   secret slots without printing them. For a fresh Zerops project, use
   [`infra/zerops/import.yaml`](../infra/zerops/import.yaml); for an existing
   project, verify exact service targets before importing or replacing anything.

4. Deploy in dependency order from the repository root:

   ```powershell
   zcli service push hydradbnode -P <project-id> --setup hydradbnode --zerops-yaml-path infra/zerops/zerops.yaml --working-dir .
   zcli service push hydradbindexer -P <project-id> --setup hydradbindexer --zerops-yaml-path infra/zerops/zerops.yaml --working-dir .
   zcli service push hydratraceengine -P <project-id> --setup hydratraceengine --zerops-yaml-path infra/zerops/zerops.yaml --working-dir .
   ```

   The graph-node deployment includes a direct S3 preflight and cannot start if
   the injected R2 credentials fail authentication.

5. Require these private/live checks before repointing users:

   - R2 preflight passes without printing credentials.
   - HydraDB `/readyz` succeeds.
   - Indexer `/readyz` succeeds, successful cycles advance, consecutive
     failures are zero, and a graph generation is published.
   - Engine `/ready` returns 200 with `provider: HydraDB` and healthy indexer.
   - A fresh fixture write, repeat import, incident query, and graph-node restart
     return the expected values in the current release evidence.

6. Deploy the current Convex functions, then set/recheck its production variables:

   ```powershell
   pnpm exec convex deploy
   pnpm exec convex env set HYDRATRACE_ENGINE_DISPATCH_URL https://hydratraceengine-2d0a-4100.prg1.zerops.app --prod
   pnpm exec convex env set HYDRATRACE_JOB_SHARED_SECRET --prod
   ```

   Enter secrets through the CLI prompt/stdin or dashboard so they do not appear
   in shell history or captured logs.

7. Set the Vercel web API origin to the Zerops engine and redeploy. The variable
   is build-time public configuration, so changing it without a redeploy does
   not update the static export:

   ```powershell
   pnpm dlx vercel@59.1.3 env add NEXT_PUBLIC_HYDRATRACE_API_URL production --cwd apps/web
   pnpm dlx vercel@59.1.3 deploy --prod --yes --cwd apps/web
   ```

   Set the variable value to
   `https://hydratraceengine-2d0a-4100.prg1.zerops.app`.

8. Redeploy the Vercel fallback engine after rotating its shared secrets:

   ```powershell
   pnpm dlx vercel@59.1.3 deploy --prod --yes --project hydratrace-engine --scope avinash1286s-projects --cwd apps/engine
   ```

   The explicit project and scope are required when
   `apps/engine/.vercel/project.json` is absent; do not accept an interactive
   prompt that would create or deploy a different project.

9. Run the live and browser checklist against the exact deployed commit. The
   2026-08-21 cutover passed routing, signed-scan, and functional public-browser
   checks; repeat these after any deployment and record response data rather
   than inferring a pass from HTTP 200. See
   [the R2 cutover record](evidence/2026-08-21-r2-cutover.md).

## Health contract

- `GET /health` is process liveness. It intentionally does not prove HydraDB.
- `GET /ready` is dependency-aware. In HydraDB mode it verifies graph
  connectivity and, when `HYDRADB_INDEXER_ADMIN_URL` is configured, requires a
  healthy separate indexer. Failure returns 503 with structured graph/indexer state.
- `GET /v1/system` is operator detail, not a load-balancer health check.
- The in-memory fallback can be ready while reporting
  `provider: in-memory-reference`; that is not production graph durability.

## Rollback and secret rotation

- Vercel: promote a previously verified deployment or run `vercel rollback`.
- Zerops: redeploy the prior known-good application version; do not delete the
  R2 bucket during application rollback.
- If a job or AI shared secret changes, update both communicating sides before
  running the signed-flow gate. Old values must be removed.
- If R2 credentials are exposed, rotate/replace the bucket-scoped credentials and
  rerun the S3, persistence, indexer, and restart gates.
