# Deployment

## Active deployments

- Web: <https://hydratrace.vercel.app>
- Engine: <https://hydratrace-engine.vercel.app>
- Convex production: `https://accomplished-skunk-643.convex.cloud`

The web deployment is a static Next.js export. The engine is a bundled Vercel Node
function; its build runs all typechecks/tests and the known-answer fixture gate.
There are intentionally no GitHub Actions workflows.

## Vercel

Production environment variables:

```text
web:    NEXT_PUBLIC_HYDRATRACE_API_URL=https://hydratrace-engine.vercel.app
engine: WEB_ORIGIN=https://hydratrace.vercel.app
engine: CONVEX_URL=https://accomplished-skunk-643.convex.cloud
engine: HYDRATRACE_JOB_SHARED_SECRET=<same 32+ character secret as Convex>
engine: HYDRATRACE_AUTO_SEED_DEMO=true
Convex: HYDRATRACE_ENGINE_DISPATCH_URL=https://hydratrace-engine.vercel.app
Convex: HYDRATRACE_JOB_SHARED_SECRET=<same secret as engine>
```

Deploy from each app directory:

```powershell
pnpm dlx vercel@59.1.3 deploy --prod --yes --cwd apps/engine
pnpm dlx vercel@59.1.3 deploy --prod --yes --cwd apps/web
```

## Cloudflare AI gateway

The Worker is ready in `apps/ai-gateway`. Account authorization is required:

```powershell
pnpm --filter @hydratrace/ai-gateway exec wrangler login
pnpm --filter @hydratrace/ai-gateway exec wrangler secret put AI_GATEWAY_SHARED_SECRET
pnpm --filter @hydratrace/ai-gateway exec wrangler secret put NVIDIA_API_KEY # optional
pnpm --filter @hydratrace/ai-gateway deploy
```

Then set `AI_GATEWAY_URL` and the same `AI_GATEWAY_SHARED_SECRET` in the Vercel
engine project and redeploy it. The Worker uses its Workers AI binding first and
NVIDIA only as fallback.

## Zerops private HydraDB

`infra/zerops/zerops.yaml` contains separate pinned graph-node and indexer setups.
The account owner must create/select a Zerops project, add one Object Storage service
named `hydratracegraph`, create runtime services `hydradbnode` and `hydradbindexer`,
and add a random `graphAuthToken` secret. Then:

```powershell
zcli login <ZEROPS_ACCESS_TOKEN>
zcli service push hydradbnode --setup hydradbnode --zerops-yaml-path infra/zerops/zerops.yaml
zcli service push hydradbindexer --setup hydradbindexer --zerops-yaml-path infra/zerops/zerops.yaml
```

Keep Bolt/admin private. For a production graph-backed engine, deploy the engine
inside the same project or use an authenticated encrypted private connection; do
not publish port 7687 merely to reach it from Vercel.
