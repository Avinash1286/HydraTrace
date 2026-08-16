# Vercel deployment notes

HydraTrace uses Vercel CLI/native projects and intentionally has no GitHub Actions.

## Engine

Project root: `apps/engine`. Workspace TypeScript packages are bundled with esbuild
into one Vercel Node function because Vercel's Fastify file tracer does not retain
uncompiled pnpm workspace source reliably. The placeholder `api/index.mjs` is replaced
during `vercel-build`; the build first runs `pnpm verify` and `pnpm scan:fixture`.

Production: <https://hydratrace-engine.vercel.app>

## Web

Project root: `apps/web`. It is a static Next.js export (`out/`) because the dashboard
has no server-only route. This also avoids shipping an unnecessary Next server function.

Production: <https://hydratrace.vercel.app>

## Runtime boundaries

Convex is the persistent serverless scan control plane. The Vercel engine's reference
graph store is intentionally ephemeral until a private route to HydraDB exists. Raw
Bolt must not be exposed publicly. Deploy an engine beside HydraDB in Zerops or use an
authenticated encrypted private network bridge.
