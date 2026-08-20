# Implementation status — 2026-08-21

HydraTrace's product paths are implemented in the repository. The private
Cloudflare R2-backed HydraDB/indexer/Zerops engine, Worker and fallback
rollover, Convex dispatch, Vercel web routing, signed durable scan, and
functional public-browser workflow have passed. The stricter local HydraDB gate
and final responsive/accessibility browser audit also passed. No account changes
remain, and the only manual owner work is the
three-minute video and submission.

## Implemented in the repository

- package-lock and pnpm lockfile normalization, deterministic IDs, provenance,
  immutable snapshots, deployment manifests, and idempotent graph writes;
- graph-store-backed current and historical blast radius with bounded complete
  paths, environment/development filtering, and explicit truncation refusal;
- canonical public-GitHub, ZIP, and lockfile acquisition with bounded automatic
  source reachability for JavaScript and TypeScript;
- exact-version OSV enrichment and persisted incidents, with bounded
  npm-registry/deps.dev supplemental context and honest partial/unavailable states;
- static/runtime/unknown reachability, package neighborhoods, deterministic risk,
  timeline replay, evidence drawer, and Markdown/JSON/SARIF reports;
- provider-checked npm remediation candidate discovery, non-root lockfile-only
  simulation, weighted set cover, fixed-snapshot coverage, and strong zero-path
  verification;
- Convex scan uploads, atomic scheduling, signed dispatch/callbacks, ordered
  events, leases, watchdog reclaim, retries, cancellation, and engine checkpoints;
- dependency-aware `GET /ready`: HydraDB connectivity is required in HydraDB
  mode and the separate indexer is required whenever its admin URL is configured;
- grounded copilot, Cloudflare Workers AI gateway, optional NVIDIA fallback,
  evidence-reference filtering, and deterministic fallback;
- Next.js product UI, restorable fictional Acme dataset, and CLI with exact
  immutable snapshot/SHA baseline comparison.

## Recorded verification

These local and repository-backed facts are separate from the live release
surface recorded below:

| Check | Recorded result |
|---|---|
| Local HydraDB persistence gate | Passed on 2026-08-20; restart retained the exact four-node/three-edge fixture and three-hop path |
| Local separate indexer | 16 successful cycles, 0 failed, 2 published generations in the recorded rerun |
| HydraDB/reference path comparison | All complete paths matched for eight fixed-seed graph shapes |
| Known-answer fixture | 3 snapshots, 72 nodes, 102 relationships; repeat import created 0 nodes/0 relationships |
| AI contract subset | Original 4 files / 28 tests passed, including the 20-question grounding gate; post-observation fallback rerun passed 2 files / 30 tests |
| Current repository verification | 38 files / 169 tests passed; exact fixture and production web build passed in the recorded release run |
| Stricter local HydraDB handoff gate | Passed on a clean per-run prefix: write 4/3, repeat 0/0, restart repeat 0/0, exact strong 3-hop path, and 8/8 reference graph shapes |
| Final local indexer metrics | Ready 1; 8 successful cycles; 0 failed and consecutive-failed cycles; 3 published `DEPENDS_ON_INSTANCE` generations |
| Local cold-start allowance | Persistence smoke wrapper uses a 180-second ceiling for the verified cold read path |

See [the local HydraDB gate record](evidence/2026-08-16-hydradb-local-gate.md),
[the AI evaluation](evidence/2026-08-20-ai-evaluation.md), and
[the R2 cutover record](evidence/2026-08-21-r2-cutover.md). The final committed
identity still belongs in the release handoff.

## Live release gate

| Surface | Current status |
|---|---|
| Vercel web URL | <https://hydratrace.vercel.app> is deployed with the Zerops engine origin; functional public-browser workflow passed |
| Vercel fallback engine | <https://hydratrace-engine.vercel.app> is redeployed and ready as the stateless `in-memory-reference` boundary; unsigned protected request returned 401 |
| Cloudflare AI gateway | <https://hydratrace-ai-gateway.hydratrace-ai-gateway.workers.dev> is redeployed after rollover and served the grounded Zerops Copilot pass |
| Convex production control plane | `https://accomplished-skunk-643.convex.cloud` is deployed with aligned dispatch and job secret; production scan `3911362687601832470` completed on attempt 1 in 18.058s |
| Cloudflare R2 | Private bucket `hydratrace-graph-production` in account `59b8589f738de5e4ab643bedd3a4b0a9` is the active HydraDB durability layer |
| Zerops HydraDB node | Active against R2; durable demo state remained available through the restart gate |
| Zerops HydraDB indexer | Active and healthy in dependency-aware engine readiness |
| Zerops graph-backed engine | <https://hydratraceengine-2d0a-4100.prg1.zerops.app>; readiness, cold hydration, temporal queries, strong remediation, gateway Copilot, and durable scan passed |
| Vercel web → Zerops engine | Repoint, production redeploy, host display, CORS, functional browser flow, 390px overflow, graph legend, and accessibility reruns passed |
| Three-minute video/submission | Only remaining manual owner task after final automated reruns |

The current durable values are in
[the R2 cutover record](evidence/2026-08-21-r2-cutover.md). Its live passes use
the expected response, graph state, signed workflow, and browser behavior rather
than treating an allocated URL as evidence.

The Vercel fallback passed readiness, unsigned-request rejection, and its
stateless boundary. On the production Zerops route, the browser passed graph,
timeline, package-neighborhood, grounded Copilot, and `VERIFIED` /
`STRONG_GRAPH` remediation with zero remaining paths; Markdown, JSON, and SARIF
downloads were valid. A cold post-deploy API run also discovered 3 candidates,
built the exact proposal, and verified zero paths in 12.558s without calling
`/v1/demo` first.

## Approved plan variances

1. **Vercel hosts the web application.** The original plan placed the web
   service on Zerops. The deployed design keeps the public static Next.js UI on
   Vercel, runs the durable graph-backed engine beside HydraDB in Zerops, and
   retains a stateless Vercel engine as fallback.
2. **No GitHub Actions.** The repository intentionally contains no Actions
   workflow. Verification runs through local release commands and Vercel's
   build/deploy gate. The CLI can be invoked by an operator-controlled CI system.

The CLI's `gate` command evaluates current exposure or compares two exact
immutable snapshot IDs/40-or-64-hex commit SHAs. It fails closed for incomplete,
changing, or non-strong graph evidence. Symbolic refs such as `main` are
rejected because branch names are not durable snapshot identities.

## Exact functional boundaries

### Source and reachability

- Repository mode accepts only canonical public GitHub HTTPS repositories and
  pins a branch/tag/ref to the returned 40-character commit SHA.
- ZIP/repository input is limited to 4 MB compressed, 50 MB expanded, 10,000
  entries, 2,000 relevant source files, 1 MB per source file, and 5 MB aggregate
  source. Source is inspected in memory and never executed.
- Automatic entrypoints come from bounded package metadata, common server/worker
  names, and Next.js/pages conventions. If no entrypoint can be established,
  automatic static evidence is absent rather than guessed.
- The analyzer follows supplied relative JavaScript/TypeScript modules and
  literal import/export/`require`/`require.resolve`/`import()` references.
  Unresolved dynamic expressions become `UNKNOWN_DYNAMIC_BEHAVIOR`.
- Lockfile-only mode has installed topology, not source reachability, unless the
  caller supplies a validated static-analysis document or runtime trace.

### Enrichment

- Only npm package versions are enriched. OSV is queried with every exact
  lockfile package/version and is the advisory source of truth.
- npm registry and deps.dev are supplemental only for versions with an OSV
  match, capped at 16 packages per scan. Their failure yields `partial` and
  cannot change exposure truth.
- OSV failure yields `unavailable` with no “no known advisory” claim. Setting
  `HYDRATRACE_SCAN_ENRICHMENT=false` yields `disabled/not-run`.
- Cache storage is filesystem-backed on long-running Node deployments and
  memory-only on Vercel. A cold deployment may therefore require public API
  availability.

### Remediation

- Automatic discovery supports npm `package-lock.json`, stable semver releases,
  and application-controlled direct dependencies. pnpm remediation simulation
  is not implemented.
- Every affected snapshot needs its exact `package.json` and `package-lock.json`;
  repository, commit, lockfile SHA-256, and root manifest must match.
- Candidate exploration is bounded to 10 versions per dependency and 25
  simulations; provider errors or a reached bound make the result inconclusive.
- Simulation runs `npm install --package-lock-only --ignore-scripts` in a
  temporary directory with a sanitized environment, 256 MB Node heap, bounded
  output, timeout, and non-root requirement. It does not run project builds or tests.
- A regenerated lockfile may be labeled `LOCKFILE_VERIFIED`. Overall
  `VERIFIED` additionally requires fixed snapshots covering every affected
  service and a strong HydraDB query with zero remaining paths.
- The restore dataset uses explicitly fictional package identities. Only exact
  built-in snapshot hashes may use the labeled `built-in-fictional-fixture`
  candidate evidence and cached simulation; this path makes no npm/OSV claim.
  Nonmatching scans still require live registry/OSV/simulation evidence or return
  inconclusive.
