# Convex control plane

This directory contains the durable scan/job state machine, idempotency indexes,
worker leases, retry limits, cancellation state, watchdog, incident records, and
AI response cache. The engine remains the deterministic analysis worker.

Cloud setup is intentionally not committed. Run `pnpm convex dev` and authenticate
when prompted; this generates `convex/_generated/` plus the deployment URL. Set the
resulting URL as `NEXT_PUBLIC_CONVEX_URL` for the web project.
