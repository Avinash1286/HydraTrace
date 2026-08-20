# Vercel deployment notes

HydraTrace uses two Vercel projects and intentionally contains no GitHub
Actions workflow.

## Web project

- Project root: `apps/web`
- Production UI: <https://hydratrace.vercel.app>
- Output: static Next.js export in `out/`
- Required production variable:
  `NEXT_PUBLIC_HYDRATRACE_API_URL=https://<public-zerops-engine>`

The API origin is compiled into the browser bundle. Redeploy the web project
after changing it. It is public configuration, not a place for a token.

```powershell
pnpm dlx vercel@59.1.3 deploy --prod --yes --cwd apps/web
```

## Fallback-engine project

- Project root: `apps/engine`
- Health URL: <https://hydratrace-engine.vercel.app/ready>
- Runtime: bundled Vercel Node function
- Graph provider: in-memory reference unless a supported private graph route is
  explicitly added

The engine's `vercel-build` first runs `pnpm verify` and
`pnpm scan:fixture`, then bundles the Fastify application and workspace
packages with esbuild. This is a stateless fallback/demo boundary. Convex may
durably hold scan workflow state, but the Vercel function does not make the
graph itself durable and must never connect to a publicly exposed Bolt port.

Recommended production variables:

```text
WEB_ORIGIN=https://hydratrace.vercel.app
CONVEX_URL=https://accomplished-skunk-643.convex.cloud
HYDRATRACE_JOB_SHARED_SECRET=<same 32+ character value as Convex>
HYDRATRACE_AUTO_SEED_DEMO=true
AI_GATEWAY_URL=https://hydratrace-ai-gateway.abinashyadav3-141.workers.dev
AI_GATEWAY_SHARED_SECRET=<same 32+ character value as the Worker>
```

Provider-backed AI is optional. If the gateway is absent/unavailable, the engine
returns a grounded deterministic answer. External scan enrichment can be
disabled explicitly with `HYDRATRACE_SCAN_ENRICHMENT=false`; that does not mean
the package was checked and found safe.

```powershell
pnpm dlx vercel@59.1.3 deploy --prod --yes --cwd apps/engine
```

Redeploy after rotating either shared secret. Scope secrets to the environments
that require them and never put them in a `NEXT_PUBLIC_*` variable.

## Why the production graph engine is not Vercel

HydraDB Bolt/HTTP/admin ports and Zerops Object Storage are private. Publishing
those ports merely so a Vercel function can connect would violate the security
boundary. The durable graph-backed engine therefore runs in the same Zerops
project as HydraDB and the separate indexer. Vercel hosts the user-facing static
web and a clearly labeled fallback engine only.

## Verification

After every production deployment:

1. Open the web URL in an incognito window.
2. Confirm the sidebar names the expected engine host.
3. Request the fallback engine's `/ready` and verify it says
   `in-memory-reference`; do not mistake that for HydraDB.
4. Request the configured Zerops engine's `/ready` and require HydraDB plus a
   healthy indexer before treating the application as production-ready.
5. Complete restore, incident, graph, timeline, evidence, report, remediation,
   and copilot checks from the web URL.

The engine bare root is a JSON discovery route. Public documentation and demos
must link the web UI or an explicit health/operator path, never the engine root
as though it were a page.

## No GitHub Actions

This is an explicit project decision, not a missing deployment file. Vercel
builds are invoked through the linked projects/CLI, and their engine build runs
the repository verification gates. The HydraTrace CLI is available if another
operator-owned CI system needs a present-exposure gate. Baseline comparison
accepts exact immutable snapshot IDs or 40/64-character commit SHAs and rejects
symbolic branch names such as `main`.
