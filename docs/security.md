# Security

## Implemented controls

- Lockfiles are parsed as data. HydraTrace never runs repository lifecycle scripts.
- Remediation simulations use `npm install --package-lock-only --ignore-scripts` in
  an isolated temporary directory with a bounded runtime.
- Request bodies are schema-validated and capped at 5.5 MB; advisories are batched.
- The public engine has a configurable per-instance rate limit (120 requests/minute
  by default) and explicit CORS origins.
- HydraDB binds local ports to loopback; Zerops configuration keeps Bolt and admin
  endpoints on the private service network.
- Graph IDs are lossless signed 63-bit values; IDs are never passed through unsafe
  JavaScript JSON numbers on the strong HTTP path.
- AI output is strict-schema validated, citations are intersected with the allowed
  evidence set, provider calls time out, and repeated failures open a circuit.
- Secrets are read from ignored environment files or deployment secret stores.

## Operational requirements

- Do not expose HydraDB Bolt, indexer admin, MinIO, or object-storage credentials publicly.
- Use a random 32+ character HydraDB auth token and a separate AI gateway secret.
- Configure Vercel Firewall/rate limits for a public event and rotate leaked tokens.
- Treat the public Vercel graph store as ephemeral until the engine is deployed next
  to private HydraDB or connected through authenticated encrypted private networking.
- Run `git diff --check`, `pnpm verify`, `pnpm gate:hydradb`, and a secret scan before release.

## Failure behavior

- Parser or schema failures return structured 400 responses.
- Repeated imports create zero duplicate nodes or relationships.
- Scan events are mirrored to Convex; expired job leases are reclaimed every 30 seconds.
- OSV/npm/deps.dev responses are cached and provider failures do not change deterministic truth.
- AI outages return a grounded deterministic template.
- Remediation cannot report `PASSED` when strong reads are unavailable or paths remain.
