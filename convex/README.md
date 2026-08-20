# Convex control plane

This directory contains the durable scan/job state machine, idempotency indexes,
worker leases, retry limits, cancellation state, watchdog, incident records, and
AI response cache. The engine remains the deterministic analysis worker.

Cloud setup is intentionally not committed. Run `pnpm convex dev` and authenticate
when prompted; this generates `convex/_generated/` plus the deployment URL. Set the
cloud URL as `CONVEX_URL` on the engine. The public scan endpoint resolves a bounded
input, obtains a private upload URL over a signed HTTP action, uploads one scan-input
envelope, then calls a signed atomic schedule action and returns `202 QUEUED`; the web
UI polls the engine's durable status projection. Convex dispatches signed work to the
engine and accepts only signed progress callbacks. Raw source/lockfile bytes never
enter Convex function arguments or table documents and expire from storage after 24h.

Set `HYDRATRACE_ENGINE_DISPATCH_URL` and the same 32+ character
`HYDRATRACE_JOB_SHARED_SECRET` in Convex. The scheduler uses Convex's
platform-provided `CONVEX_SITE_URL` for its callback, so public scheduling calls
cannot redirect signed progress messages to an attacker-controlled URL.
