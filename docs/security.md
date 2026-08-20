# Security

## Trust boundaries

Lockfiles, source archives, repository text, runtime traces, advisory content,
package metadata, and model output are untrusted. HydraDB/Convex records are
authoritative only after schema validation and deterministic identity/provenance
checks. AI is explanatory and cannot decide exposure, reachability, risk, or
remediation success.

## Repository and archive acquisition

- Repository mode accepts only canonical HTTPS `github.com/owner/repository`
  URLs, rejects credentials/ports/query/fragment/additional path components,
  resolves the ref through GitHub, and scans the pinned 40-character commit.
- Remote archives are limited while streaming to 4,000,000 compressed bytes.
- ZIPs are limited to 10,000 entries and 50,000,000 expanded bytes. Encryption,
  absolute/drive/backslash paths, NUL bytes, and `..` traversal are rejected.
- Selected lockfiles are capped at 5 MB. Automatic source collection is capped
  at 2,000 files, 1 MB each, and 5 MB total; generated/vendor directories and
  source maps/minified files are excluded.
- Archives are inspected in memory. Repository scripts, package scripts, and
  source code are never executed by scanning.

Lockfile-only mode cannot claim static reachability unless the caller provides a
validated static-analysis document. Unresolved dynamic imports are preserved as
unknown evidence rather than guessed reachable/unreachable.

## API and workflow controls

- Fastify request bodies are capped at 5.5 MB; route schemas apply narrower
  limits, strict object validation, normalized paths, and bounded arrays.
- Public engine requests have a configurable per-instance one-minute rate limit
  (default 120) and an explicit CORS allowlist.
- Convex upload/schedule/dispatch/progress operations use a shared 32+ character
  secret and signed requests. Raw uploaded scan envelopes expire from Storage;
  normal table documents contain bounded state/projections, not source blobs.
- Scan IDs and idempotency keys are content-derived. Replays use canonical graph
  writes and durable checkpoints rather than launching duplicate ingestion.
- `/health` is liveness. `/ready` returns 503 when configured HydraDB/indexer
  dependencies fail, preventing a healthy-process response from hiding a broken graph.

## Remediation execution

Automatic candidate discovery requires exact source artifacts matching the
incident's repository, commit, lockfile SHA-256, and lockfile root manifest.
Registry existence/deprecation, exact OSV results, and a regenerated lockfile
must all succeed before a candidate becomes `LOCKFILE_VERIFIED`.

The built-in fictional demo is the sole exception to external-provider lookup:
only exact known snapshot/incident hashes may return a labeled
`built-in-fictional-fixture` candidate set and cached simulation. That path does
not claim the fictional packages exist in npm/OSV and cannot match arbitrary scans.

The npm simulation:

- supports `package-lock.json` only and changes an application-controlled
  direct dependency;
- runs as a non-root child process or returns inconclusive;
- uses a fresh temporary directory deleted in `finally`;
- runs `npm install --package-lock-only --ignore-scripts --audit=false --fund=false`;
- supplies a minimal child environment, private npm cache, 256 MB Node heap,
  bounded stdout/stderr, and a timeout;
- does not run project builds, tests, binaries, or lifecycle scripts.

This is bounded process isolation, not a kernel security sandbox. Do not weaken
the non-root check for arbitrary repositories. Overall `VERIFIED` also requires
fixed snapshots for every covered service and a strong HydraDB zero-path query.

## HydraDB and object storage

- Keep Bolt 7687, query HTTP 8443, graph admin 9090, and indexer admin 9091
  private to local loopback or the Zerops project network. Keep the R2 bucket
  private and require its bucket-scoped S3 credentials for every access.
- Only the Zerops engine connects to HydraDB; Vercel must not reach a public Bolt port.
- Use a random 32+ character graph token and the committed pinned HydraDB digest.
- HydraDB persists to the private Cloudflare R2 bucket
  `hydratrace-graph-production` in account
  `59b8589f738de5e4ab643bedd3a4b0a9`. Its Object Read & Write token is scoped
  only to that bucket and stored only in Zerops secret variables.
- Never print or copy R2 credentials to Vercel, evidence files, source, or
  command history. The account ID, bucket name, and S3 endpoint are identifiers,
  not credentials.
- Rotate any exposed credential, redeploy graph consumers, and rerun S3,
  persistence, indexer, and restart gates.

## AI controls

- The Worker fails closed when its shared secret is absent/short and rejects an
  invalid bearer token.
- An optional 32+ character rollover secret may be accepted only during a
  coordinated engine rotation. Remove it after all callers use the primary
  secret; a short configured rollover value fails closed, as does a missing or
  short primary value.
- Models receive a closed deterministic evidence set, no credentials and no
  executable tools. Output must be strict JSON and schema-valid.
- Returned evidence references are intersected with the allowed set; a
  non-empty answer with no supported reference is rejected.
- Severity is normalized to the contract. Provider errors/failures fall through
  to the next provider and finally the deterministic template.
- No model-generated command or Cypher is executed.

## Secrets

Keep these independent:

- HydraDB graph auth token;
- Cloudflare R2 bucket-scoped access-key pair;
- Convex/engine `HYDRATRACE_JOB_SHARED_SECRET`;
- Worker/engine `AI_GATEWAY_SHARED_SECRET`;
- optional NVIDIA key.

Use ignored local files and platform secret stores. Never place secrets in
`NEXT_PUBLIC_*` variables. Rotate both sides of a shared-secret relationship
and redeploy before accepting signed-flow evidence.

For the 2026-08-21 release, the Convex/Zerops job secret was aligned without
recording its value. Zerops uses the Worker primary AI secret, while the Vercel
fallback uses an independently rotated Worker rollover secret. Convex
production, Zerops, the Worker, and the fallback were redeployed; signed flows
passed and an unsigned protected fallback request returned 401. Converging the
fallback onto the primary value and removing the rollover value is a
non-blocking hardening follow-up.

## Release checks

Before release:

```powershell
git diff --check
pnpm verify
pnpm scan:fixture
pnpm gate:hydradb
```

The local persistence smoke wrapper allows 180 seconds for the verified cold
restart/read path; this is a timeout ceiling, not an expected steady-state
latency target.

Also scan tracked files for credential patterns, inspect deployment logs for
secret output, require unsigned dispatch/callback requests to return 401, verify
CORS from the production web origin, and complete the incognito browser gate.

## Failure behavior

- Parser/acquisition/schema failures return bounded structured 4xx responses.
- OSV failure returns enrichment `unavailable`, never a safe result; supplemental
  metadata failure returns `partial` without changing advisory truth.
- Provider/simulation uncertainty makes remediation `INCONCLUSIVE`.
- Path or graph hydration caps refuse an incomplete “all paths” or zero-path result.
- AI outage returns grounded deterministic output.
- Graph/indexer outage makes dependency readiness fail.
