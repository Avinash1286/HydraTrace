# Implementation status — 2026-08-20

HydraTrace's product paths are implemented in the repository. Submission
readiness is intentionally tracked separately from implementation: the public
Vercel fallback and Cloudflare path have live evidence, while the final Zerops
persistence/indexer/engine gate, final frozen-tree deployments, and incognito
walkthrough must all pass before the project is called production-complete.

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

These are repository-backed facts, not claims about the unfinished Zerops gate:

| Check | Recorded result |
|---|---|
| Local HydraDB persistence gate | Passed on 2026-08-20; restart retained the exact four-node/three-edge fixture and three-hop path |
| Local separate indexer | 16 successful cycles, 0 failed, 2 published generations in the recorded rerun |
| HydraDB/reference path comparison | All complete paths matched for eight fixed-seed graph shapes |
| Known-answer fixture | 3 snapshots, 72 nodes, 102 relationships; repeat import created 0 nodes/0 relationships |
| AI contract subset | Original 4 files / 28 tests passed, including the 20-question grounding gate; post-observation fallback rerun passed 2 files / 30 tests |
| Frozen-tree local verification | 38 files / 161 tests, fixture gate, production web build, and final local HydraDB persistence/indexer/restart gate passed |

See [the local HydraDB gate record](evidence/2026-08-16-hydradb-local-gate.md)
and [the AI evaluation](evidence/2026-08-20-ai-evaluation.md). The final release
rerun and deployed commit identity still belong in the production-gate record
after the current worktree is frozen.

## Live release gate

| Surface | Current status |
|---|---|
| Vercel web URL | Public candidate-release deployment passed overview, incident, timeline, graph, reports, remediation-boundary, Copilot, and engineering-page walkthroughs |
| Vercel fallback engine | Candidate release deployment `dpl_8FvaJASsmqFxAzNXZmmyEcfZ2z9T` is ready as `in-memory-reference`; its Vercel build passed 38 files / 161 tests and the exact fixture gate |
| Cloudflare AI gateway | Version `e71fa895-6ca7-4e43-81a4-201f8a8863c1` deployed; health passed, unsigned generate returned 401, and four grounded provider answers succeeded |
| Convex production control plane | Current scheduler/schema deployed; signed scan completed on attempt 1 with all 11 ordered stages; exact duplicate reused one identity; unsigned callback and dispatch each returned 401 |
| Zerops object storage | **Platform blocked:** two independently provisioned services rejected their generated secrets with `SignatureDoesNotMatch`; latest support ID `YBkYNhAMQWupEYgkryiJbA` |
| Zerops HydraDB node | Latest init preflight failed against replacement storage; no running container, so persistence/restart proof cannot start |
| Zerops HydraDB indexer | Not deployed while the graph node is unavailable; successful-cycle/generation proof pending |
| Zerops graph-backed engine | Not deployed while HydraDB is unavailable; public URL, readiness, scan, and restart proof pending |
| Vercel web → Zerops engine | Environment repoint, production redeploy, CORS, and incognito browser flow pending |
| Three-minute video/submission | Manual owner task after all live checks pass |

The live evidence fields are in
[the production-gate record](evidence/2026-08-20-production-gate.md). A URL being
allocated is not a pass: the record requires the expected response, graph state,
and restart behavior.

The Vercel fallback also passed its CORS boundary: the public Vercel origin was
allowed and an unapproved origin was not. Markdown, JSON, and SARIF report
downloads returned 200. Remediation correctly remained `INCONCLUSIVE` with
`REFERENCE_GRAPH`; only the pending HydraDB deployment can satisfy the planned
`VERIFIED` / `STRONG_GRAPH` acceptance condition.

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
