# Vercel deployment

HydraTrace uses Vercel's native Git integration instead of GitHub Actions. Every branch push creates a preview deployment, and a successful build from `main` becomes the production deployment.

Production URL: <https://hydratrace-engine.vercel.app>

## Project settings

Configure one Vercel project with these settings:

- Git repository: `Avinash1286/HydraTrace`
- Root Directory: `apps/engine`
- Include source files outside the Root Directory: enabled
- Framework: Fastify (pinned in `apps/engine/vercel.json`)
- Node.js: 24.x
- Production branch: `main`
- Build Command: leave unset
- Output Directory: leave unset

The nearest package's `vercel-build` hook runs `pnpm verify` and `pnpm scan:fixture` before Vercel bundles the Fastify function. A failed typecheck, test, or fixture assertion therefore fails the deployment.

The engine pins TypeScript 5.9 for Vercel's Fastify bundler while the workspace verification remains on TypeScript 7. This isolates a compiler-emission compatibility boundary without weakening the repository typecheck.

## CLI workflow

The CLI version is pinned in commands without adding it to the application bundle:

```powershell
pnpm dlx vercel@59.1.3 link --repo
pnpm dlx vercel@59.1.3 pull --yes --environment=preview
pnpm dlx vercel@59.1.3 build
pnpm dlx vercel@59.1.3 deploy
```

Use `pnpm dlx vercel@59.1.3 deploy --prod` only when intentionally creating a production deployment. The `.vercel` link directory and pulled environment files are ignored by Git.

## Runtime boundaries

The OSV response cache uses memory on Vercel because a Function's project filesystem is not durable. It remains a content-addressed file cache during ordinary local development.

Without `HYDRADB_BOLT_URI` and `HYDRADB_AUTH_TOKEN`, the deployed engine deliberately uses its reference in-memory graph store. This is suitable for endpoint and ingestion previews, but data can disappear between Function instances and must not be presented as production persistence.

The planned HydraDB node is private inside Zerops. Do not expose raw Bolt publicly merely to connect Vercel. A production connection requires an authenticated, encrypted network bridge or a separately deployed engine that can reach HydraDB privately. Until that exists, the local/Zerops persistence gate remains authoritative.
