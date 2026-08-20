# Deployment

## Production topology

```text
Browser
  -> Vercel static web
       -> Zerops public engine
            -> private HydraDB node
            -> private HydraDB indexer
            -> private Zerops Object Storage
            -> Convex durable scheduler
            -> authenticated Cloudflare AI gateway

Vercel fallback engine
  -> in-memory reference graph (no production graph-persistence claim)
```

Active service inventory:

- Web: <https://hydratrace.vercel.app>
- Vercel fallback-engine health: <https://hydratrace-engine.vercel.app/ready>
- Convex production: `https://accomplished-skunk-643.convex.cloud`
- Cloudflare gateway: `https://hydratrace-ai-gateway.abinashyadav3-141.workers.dev`
- Zerops engine: record the final `/ready` URL in the production-gate evidence

Only the web URL is a user application. Engine roots return API metadata/JSON;
link an engine as `https://<engine>/ready` or `https://<engine>/v1/system`, not
as a second UI.

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

The Zerops graph variables are supplied by
[`infra/zerops/zerops.yaml`](../infra/zerops/zerops.yaml): private Bolt/HTTP/admin
addresses, strong consistency, indexer admin URL, graph identity, and the
service-scoped graph token. Both HydraDB services consume the Object Storage
endpoint, bucket, and complete access-key pair through Zerops' generated
cross-service references, including `${hydratracegraph_secretAccessKey}`.
Never print or copy those credentials into Vercel.

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
   pnpm --filter @hydratrace/ai-gateway exec wrangler secret put AI_GATEWAY_SHARED_SECRET
   pnpm --filter @hydratrace/ai-gateway exec wrangler secret put NVIDIA_API_KEY
   pnpm --filter @hydratrace/ai-gateway deploy
   ```

   `NVIDIA_API_KEY` is optional. Workers AI is provided through the committed
   `AI` binding. The engine must receive the same gateway shared secret.

3. Provision Zerops Object Storage, `hydradbnode`, `hydradbindexer`, and
   `hydratraceengine`. For a fresh project, use
   [`infra/zerops/import.yaml`](../infra/zerops/import.yaml); for an existing
   project, verify exact service targets before importing or replacing anything.

4. Deploy in dependency order from the repository root:

   ```powershell
   zcli service push hydradbnode -P <project-id> --setup hydradbnode --zerops-yaml-path infra/zerops/zerops.yaml --working-dir .
   zcli service push hydradbindexer -P <project-id> --setup hydradbindexer --zerops-yaml-path infra/zerops/zerops.yaml --working-dir .
   zcli service push hydratraceengine -P <project-id> --setup hydratraceengine --zerops-yaml-path infra/zerops/zerops.yaml --working-dir .
   ```

   The graph-node deployment includes a direct S3 preflight and cannot start if
   the injected Object Storage credentials fail both supported signing modes.

5. Require these private/live checks before repointing users:

   - Object Storage preflight passes without printing credentials.
   - HydraDB `/readyz` succeeds.
   - Indexer `/readyz` succeeds, successful cycles advance, consecutive
     failures are zero, and a graph generation is published.
   - Engine `/ready` returns 200 with `provider: HydraDB` and healthy indexer.
   - A fresh fixture write, repeat import, incident query, and graph-node restart
     return the expected values in the production-gate record.

6. Deploy the current Convex functions, then set/recheck its production variables:

   ```powershell
   pnpm exec convex deploy --yes
   pnpm exec convex env set HYDRATRACE_ENGINE_DISPATCH_URL https://<zerops-engine> --prod
   pnpm exec convex env set HYDRATRACE_JOB_SHARED_SECRET <same-secret> --prod
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

8. Redeploy the Vercel fallback engine after rotating its shared secrets:

   ```powershell
   pnpm dlx vercel@59.1.3 deploy --prod --yes --cwd apps/engine
   ```

9. Run the complete live and incognito-browser checklist in
   [the production-gate record](evidence/2026-08-20-production-gate.md). Record
   deployment IDs and the exact commit; do not replace pending fields with a
   pass based only on HTTP 200.

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
- Zerops: redeploy the prior known-good application version; do not delete
  Object Storage during application rollback.
- If a job or AI shared secret changes, update both communicating sides before
  running the signed-flow gate. Old values must be removed.
- If Object Storage credentials are exposed, rotate/replace the credentials and
  rerun the S3, persistence, indexer, and restart gates.
