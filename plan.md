# HydraTrace — No-Compromise Implementation Plan

## 1. Final product definition

**Hackathon track:** Track 2A — Supply-chain blast radius
**Project name:** HydraTrace
**Positioning:**

> **HydraTrace is a temporal, reachability-aware software-supply-chain incident command system that traces a compromised package to every affected deployment, reconstructs complete evidence paths, ranks actual exploitability, and generates the smallest verified remediation plan.**

The project will deeply support the **npm ecosystem** rather than spreading engineering effort across both npm and PyPI. The official track explicitly allows building either an npm or PyPI dependency graph. The judging criteria are technical execution, graph-native HydraDB usage, product completeness, result quality, and originality.

### Submission deadline

The official deadline is:

- **August 20, 2026 at 11:59 PM Pacific Time**
- **August 21, 2026 at 12:44 PM Nepal Time**

Our internal code freeze should be **August 20 at 11:00 PM Nepal Time**, leaving more than thirteen hours for recording, uploading, link verification, README review, and submission.

A complete submission requires:

1. Public GitHub repository
2. Demo video no longer than three minutes
3. Completed submission form
4. Clear HydraDB integration
5. Setup instructions, attribution, environment requirements, and an open-source license

The repository must not contain participant-authored commits from before August 12, 2026.

---

# 2. Budget decision

## The available $13 Zerops credit is enough

Use a **Zerops Lightweight Core**, which has no core charge, and allocate fixed resources to five services. Zerops charges CPU, RAM, and disk by actual minute-level usage, while its object storage is S3-compatible and costs $0.01 per GB per 30 days.

| Service | CPU | RAM | Disk | Approx. 30-day equivalent | Approx. seven-day cost |
|---|---:|---:|---:|---:|---:|
| HydraDB graph node | 1 shared CPU | 2 GB | 10 GB | $7.60 | $1.77 |
| HydraDB indexer | 1 shared CPU | 1.5 GB | 5 GB | $5.60 | $1.31 |
| Analysis engine and resolution worker | 1 shared CPU | 1.5 GB | 5 GB | $5.60 | $1.31 |
| Next.js web application | 1 shared CPU | 0.5 GB | 2 GB | $2.40 | $0.56 |
| Object storage | — | — | 5 GB | $0.05 | About $0.01 |
| **Expected total** |  |  |  | **$21.25/month equivalent** | **About $4.96** |

Allowing for builds, temporary resource increases, failed deployments, and testing, reserve approximately **$6–$8**. The remaining $13 should therefore be sufficient, although exact usage will depend on actual runtime allocation.

Use fixed resource limits and a Zerops daily-spending warning of approximately **$1.50 per day**. Zerops notes that the warning does not automatically shut down the project, so resource usage must still be monitored manually.

## Other platform cost

| Platform | Usage | Expected cost |
|---|---|---:|
| Convex | Job control plane, realtime status and durable scheduling | $0 |
| Cloudflare Workers AI | AI explanations and structured extraction | $0 within daily allocation |
| NVIDIA NIM | AI fallback and deep incident reasoning | $0 through free endpoint |
| GitHub | Public repository and Actions | $0 |
| OSV | Vulnerability records | $0 |
| deps.dev | Public dependency enrichment | $0 |
| npm registry APIs | Package and maintainer metadata | $0 |

Cloudflare Workers AI currently provides 10,000 free Neurons per day. The selected `@cf/openai/gpt-oss-120b` model supports function calling and reasoning. NVIDIA’s `nvidia/nemotron-3-super-120b-a12b` currently has a free hosted endpoint and a large context window.

Convex’s free tier includes actions, cron jobs, file storage and sufficient prototype resources for this workflow.

---

# 3. Non-negotiable product capabilities

The submission should contain these six judge-visible capabilities:

| Capability | Product result |
|---|---|
| **Exact blast radius** | Every affected service and deployment, including transitive dependency paths |
| **Historical incident replay** | Exposure at a selected time, not only current exposure |
| **Reachability classification** | Installed, statically reachable, test-observed or runtime-observed |
| **Package neighborhood intelligence** | Shared maintainers, source infrastructure and suspiciously similar names |
| **Verified remediation planning** | Smallest practical dependency upgrades with a new lockfile proving the bad version is gone |
| **Evidence-grounded AI copilot** | Natural-language incident answers that reference deterministic graph evidence |

The app is not complete when it merely displays a dependency graph. It is complete when it can answer:

> “Which production deployments used `package-x@1.4.2` between 09:00 and 12:00, how did it enter each service, which paths are executable, what related packages deserve investigation, and which minimum set of upgrades removes every affected path?”

---

# 4. System architecture

```text
                         ┌──────────────────────────┐
                         │ Next.js web application │
                         │         Zerops           │
                         └────────────┬─────────────┘
                                      │
                           realtime job state
                                      │
                         ┌────────────▼─────────────┐
                         │         Convex           │
                         │                          │
                         │ • Scan/job state         │
                         │ • Durable scheduler      │
                         │ • Retry orchestration    │
                         │ • Progress events        │
                         │ • Audit trail            │
                         └────────────┬─────────────┘
                                      │ signed job dispatch
                                      ▼
                 ┌──────────────────────────────────────┐
                 │ HydraTrace analysis engine — Zerops │
                 │                                      │
                 │ • Repository acquisition             │
                 │ • Lockfile parsers                    │
                 │ • Source reachability                 │
                 │ • Runtime evidence ingestion          │
                 │ • OSV/deps.dev/npm enrichment         │
                 │ • Blast-radius analysis               │
                 │ • Remediation solver                  │
                 │ • Public application API              │
                 └──────────┬────────────────┬──────────┘
                            │                │
                    graph queries       AI evidence bundle
                            │                │
                ┌───────────▼────────┐       ▼
                │ HydraDB graph node │  ┌────────────────────┐
                │      Zerops        │  │ Cloudflare Worker  │
                │                    │  │ AI provider router │
                │ Bolt + HTTP API    │  └─────────┬──────────┘
                └───────────┬────────┘            │
                            │                     ├─ Workers AI
                            │                     └─ NVIDIA NIM
                            │
                 S3-compatible durable graph data
                            │
               ┌────────────▼─────────────┐
               │ Zerops Object Storage   │
               │      MinIO / S3         │
               └────────────▲─────────────┘
                            │
                ┌───────────┴───────────┐
                │ HydraDB graph indexer │
                │        Zerops         │
                └───────────────────────┘
```

## Clear platform responsibilities

### HydraDB owns

- Package and package-version graph
- Exact lockfile-resolution graph
- Deployment and historical-snapshot graph
- Advisory-to-package relationships
- Source and runtime reachability evidence
- Maintainer and infrastructure relationships
- Similar-package relationships
- Blast-radius traversal
- Complete evidence paths
- Temporal graph queries
- Remediation verification

### Convex owns

- User intent
- Scan records
- Job scheduling
- Job attempts and retries
- Realtime progress
- Small UI summaries
- Audit events
- AI request state
- Remediation-run state

Convex must **not** duplicate the dependency graph or calculate blast radius. Otherwise, HydraDB’s role becomes less meaningful.

### Zerops analysis engine owns

- CPU-intensive parsing
- Git repository processing
- Package-manager resolution
- Static source analysis
- Runtime trace processing
- Calls to public metadata APIs
- Graph mutations and queries
- Remediation optimization
- Report generation

### AI owns

- Converting deterministic findings into understandable explanations
- Structuring unstructured advisory descriptions
- Answering incident questions through approved tools
- Generating technical and executive summaries

AI must **not** decide whether a version is vulnerable, whether a deployment is exposed, whether code is reachable, or whether remediation succeeded.

---

# 5. Repository structure

Use a fresh public monorepo:

```text
hydratrace/
├── apps/
│   ├── web/                         # Next.js application
│   ├── engine/                      # Fastify API and analysis worker
│   ├── ai-gateway/                  # Cloudflare Worker AI router
│   └── cli/                         # Local and CI scanner
│
├── convex/
│   ├── schema.ts
│   ├── scans.ts
│   ├── jobs.ts
│   ├── scheduler.ts
│   ├── callbacks.ts
│   ├── incidents.ts
│   └── aiRuns.ts
│
├── packages/
│   ├── domain/                      # Shared domain models
│   ├── graph-schema/                # Node/relationship definitions
│   ├── hydradb-client/              # Bulk writes and graph queries
│   ├── lockfile-parsers/
│   │   ├── package-lock/
│   │   └── pnpm-lock/
│   ├── ecosystem-enrichment/
│   │   ├── osv/
│   │   ├── deps-dev/
│   │   └── npm-registry/
│   ├── reachability/
│   │   ├── static/
│   │   └── runtime-agent/
│   ├── blast-radius/
│   ├── typosquat/
│   ├── remediation/
│   ├── ai-contracts/
│   ├── observability/
│   └── test-fixtures/
│
├── fixtures/
│   ├── acme-commerce/
│   │   ├── checkout-api/
│   │   ├── payment-worker/
│   │   └── analytics-dashboard/
│   ├── incidents/
│   └── expected-results/
│
├── benchmarks/
│   ├── graph-generator/
│   ├── expected-closure/
│   └── reports/
│
├── infra/
│   ├── local/
│   │   ├── docker-compose.yml
│   │   └── minio/
│   ├── zerops/
│   │   ├── zerops.yaml
│   │   └── deployment.md
│   └── cloudflare/
│       └── wrangler.toml
│
├── docs/
│   ├── architecture.md
│   ├── graph-model.md
│   ├── correctness.md
│   ├── security.md
│   ├── benchmarks.md
│   ├── demo-script.md
│   └── attribution.md
│
├── LICENSE
├── README.md
├── pnpm-workspace.yaml
└── turbo.json
```

Use TypeScript throughout the application layer, Node.js for the engine and CLI, and a pnpm workspace for consistent dependency management.

---

# 6. Graph model

## 6.1 Two different dependency layers

A critical design decision is to model two dependency graphs separately.

### Ecosystem package graph

This represents public package knowledge:

```text
PackageVersion ── DECLARES_DEPENDENCY ──> Package
PackageVersion ── RESOLVES_PUBLICLY_TO ──> PackageVersion
```

It is useful for:

- Package neighborhood analysis
- Public transitive dependency exploration
- Dependent counts
- Related-package discovery
- Ecosystem-scale benchmark graphs

### Exact lockfile-resolution graph

This represents what a particular repository actually installed:

```text
LockfileSnapshot ── CONTAINS ──> Resolution
Resolution ── INSTANCE_OF ──> PackageVersion
Resolution ── DEPENDS_ON_INSTANCE ──> Resolution
```

A `Resolution` is snapshot-specific and includes its install path. This is necessary because one lockfile may contain the same package name at several versions or several installation paths.

The exact lockfile graph, not the generic ecosystem graph, is the source of truth for exposure findings.

---

## 6.2 Node types

| Node | Important properties |
|---|---|
| `Organization` | `id`, `name` |
| `Repository` | `id`, `url`, `defaultBranch` |
| `Service` | `id`, `name`, `repositoryId` |
| `Commit` | `sha`, `committedAt` |
| `Environment` | `id`, `name`, `criticality` |
| `Deployment` | `id`, `startedAt`, `endedAt`, `status` |
| `LockfileSnapshot` | `id`, `sha256`, `type`, `createdAt`, `validUntil` |
| `Resolution` | `id`, `installPath`, `dev`, `optional`, `peer`, `integrity` |
| `Package` | `id`, `ecosystem`, `name`, `normalizedName` |
| `PackageVersion` | `id`, `version`, `publishedAt`, `deprecated` |
| `Advisory` | `id`, `summary`, `severity`, `publishedAt`, `modifiedAt` |
| `IncidentWindow` | `id`, `startsAt`, `endsAt`, `source`, `confidence` |
| `Maintainer` | `id`, `username`, `emailHash`, `emailDomain` |
| `Infrastructure` | `id`, `type`, `value` |
| `SourceModule` | `id`, `filePath`, `language`, `contentHash` |
| `EntryPoint` | `id`, `type`, `command` |
| `RuntimeObservation` | `id`, `runId`, `observedAt`, `source` |
| `Evidence` | `id`, `type`, `sourceRef`, `sha256`, `parserVersion` |
| `RemediationCandidate` | `id`, `fromVersion`, `toVersion`, `cost` |

## 6.3 Relationship types

```text
Organization ── OWNS ──> Repository
Repository ── CONTAINS_SERVICE ──> Service
Repository ── HAS_COMMIT ──> Commit
Service ── HAS_DEPLOYMENT ──> Deployment
Deployment ── RUNS_COMMIT ──> Commit
Deployment ── IN_ENVIRONMENT ──> Environment
Deployment ── USES_SNAPSHOT ──> LockfileSnapshot

LockfileSnapshot ── CONTAINS ──> Resolution
LockfileSnapshot ── SUPERSEDES ──> LockfileSnapshot
Resolution ── INSTANCE_OF ──> PackageVersion
Resolution ── DEPENDS_ON_INSTANCE ──> Resolution
PackageVersion ── VERSION_OF ──> Package

PackageVersion ── AFFECTED_BY ──> Advisory
Advisory ── ACTIVE_DURING ──> IncidentWindow
PackageVersion ── PUBLISHED_BY ──> Maintainer
PackageVersion ── BUILT_FROM ──> Commit
PackageVersion ── USES_INFRASTRUCTURE ──> Infrastructure
Package ── SIMILAR_NAME_TO ──> Package

EntryPoint ── REACHES ──> SourceModule
SourceModule ── IMPORTS_MODULE ──> SourceModule
SourceModule ── BELONGS_TO ──> PackageVersion
RuntimeObservation ── LOADED ──> PackageVersion

Evidence ── SUPPORTS ──> Deployment
Evidence ── SUPPORTS ──> Resolution
Evidence ── SUPPORTS ──> Advisory
```

## 6.4 Temporal properties

Every deployment and lockfile snapshot must be immutable.

```text
Deployment:
  startedAt
  endedAt | null

LockfileSnapshot:
  createdAt
  validUntil | null

IncidentWindow:
  startsAt
  endsAt
  source
  confidence
```

A finding is temporally valid when these intervals overlap:

```text
deployment interval
∩ snapshot validity
∩ affected-version interval
∩ incident window
≠ empty set
```

Do not overwrite a previous lockfile snapshot when a service upgrades. Create a new snapshot and connect it with `SUPERSEDES`.

---

# 7. Stable identifiers and provenance

## Deterministic identifiers

Generate a stable nonnegative 63-bit hash from a canonical key:

```text
npm:package:lodash
npm:version:lodash:4.17.21
repository:github.com/example/checkout
snapshot:<repository-id>:<commit-sha>:<lockfile-sha256>
resolution:<snapshot-id>:node_modules/a/node_modules/b
deployment:<service-id>:production:<deployment-id>
```

Use the same canonicalization in every parser and test.

## Provenance on every important fact

Every imported relationship must include:

```json
{
  "sourceType": "package-lock",
  "sourceRef": "package-lock.json",
  "sourceSha256": "…",
  "repositoryId": "…",
  "commitSha": "…",
  "importRunId": "…",
  "observedAt": 1786703000000,
  "parserVersion": "1.0.0",
  "confidence": 1
}
```

This gives the evidence drawer something concrete to display and prevents unsupported claims.

## Idempotent graph writes

Do not assume unsupported database features.

Implement idempotency using:

1. Content-addressed scan IDs
2. A single canonical writer in the engine
3. Pre-querying existing canonical IDs
4. Creating only missing global nodes
5. Treating every lockfile snapshot as immutable
6. Deleting and recreating only an incomplete snapshot when retrying
7. Recording completed import stages in Convex and object storage
8. Using bounded batched writes

HydraDB supports batched `UNWIND` writes, typed relationships, bounded variable-length paths, Neo4j-compatible Bolt connectivity, HTTP/NDJSON APIs and native path procedures.

---

# 8. Ingestion workflow

## 8.1 Supported input modes

The first release should support:

1. Public GitHub repository URL
2. Uploaded ZIP repository
3. Direct lockfile upload
4. Built-in demo organization
5. CLI scan from a local repository

Avoid building a full GitHub OAuth application during the hackathon. The CLI and GitHub Action demonstrate developer workflow more directly and with less setup friction.

## 8.2 Supported lockfiles

Mandatory:

- `package-lock.json` v2 and v3
- `pnpm-lock.yaml`

After all mandatory functions pass:

- `yarn.lock`

Do not add PyPI before the npm implementation is complete and measured.

## 8.3 Package-lock parser

For each entry in the `packages` map:

1. Extract installation path
2. Resolve exact package name and version
3. Read `resolved` and `integrity`
4. Record development, optional and peer flags
5. Create a snapshot-specific `Resolution`
6. Map declared dependency names to actual installed paths
7. Create `DEPENDS_ON_INSTANCE` edges
8. Mark root direct dependencies

The parser output must be a normalized intermediate representation:

```typescript
interface NormalizedSnapshot {
  snapshot: {
    id: string;
    ecosystem: "npm";
    lockfileType: "package-lock" | "pnpm-lock";
    contentHash: string;
  };
  packages: NormalizedPackageVersion[];
  resolutions: NormalizedResolution[];
  edges: NormalizedResolutionEdge[];
  warnings: ParserWarning[];
}
```

## 8.4 pnpm parser

Parse:

- `importers`
- `packages`
- `snapshots`
- Peer suffixes
- Optional dependencies
- Workspace links
- Exact dependency resolution keys

Preserve the pnpm package key as source evidence, but generate a package-manager-independent normalized ID.

## 8.5 Public metadata enrichment

### OSV

Use `POST /v1/querybatch` to check many exact package versions in one request, then retrieve full records only for returned advisory IDs. OSV guarantees that batch results correspond to the request order.

Store:

- Advisory ID
- Aliases
- Summary
- Severity
- Affected ranges
- Fixed versions
- References
- Published, modified and withdrawn timestamps
- Original source

### deps.dev

Use deps.dev for:

- Public resolved dependency graphs
- Direct versus indirect classification
- Package-version relationships
- Public dependent counts
- Source-project information

deps.dev provides resolved graphs for npm and reports node and edge information, including version requirements and resolved versions.

### npm registry

Use package metadata for:

- Maintainers
- Published versions
- Publication timestamps
- Repository URL
- Tarball URL
- Integrity metadata
- Deprecation status
- Declared dependencies

The npm registry package endpoint returns package metadata containing maintainers, repositories, versions, dependencies and tarball information.

## 8.6 Cache policy

Cache all public API responses by request hash:

```text
cache/
├── osv/
├── deps-dev/
├── npm-registry/
└── npm-downloads/
```

Store cache metadata:

```json
{
  "fetchedAt": 1786703000000,
  "expiresAt": 1786789400000,
  "status": 200,
  "etag": "…",
  "sha256": "…"
}
```

The demo must continue to work from cached evidence when an external API is unavailable.

---

# 9. Convex background-job architecture

Convex should operate as a durable control plane around the Zerops worker.

## 9.1 Convex tables

```text
organizations
projects
repositories
uploads
scans
jobs
jobAttempts
jobEvents
incidents
findingSummaries
remediationRuns
aiRuns
auditEvents
engineHeartbeats
```

### Example `jobs` document

```typescript
{
  scanId,
  type: "repository_scan",
  state: "queued",
  currentStage: "waiting",
  progress: 0,
  attemptCount: 0,
  idempotencyKey,
  engineJobId: null,
  scheduledFunctionId,
  lastHeartbeatAt: null,
  nextRetryAt: null,
  createdAt,
  updatedAt
}
```

## 9.2 State machine

```text
QUEUED
  ↓
DISPATCHING
  ↓
ACKNOWLEDGED
  ↓
ACQUIRING
  ↓
PARSING
  ↓
ENRICHING
  ↓
WRITING_GRAPH
  ↓
INDEXING
  ↓
ANALYZING
  ↓
COMPLETE
```

Failure states:

```text
RETRY_WAIT
FAILED
CANCEL_REQUESTED
CANCELLED
```

## 9.3 Dispatch workflow

1. Client calls a Convex mutation.
2. Mutation creates the scan and job atomically.
3. Mutation calls `scheduler.runAfter(0, dispatchJob)`.
4. Dispatch action sends a signed request to the Zerops engine.
5. Engine immediately returns an acknowledgement.
6. Engine sends progress callbacks as each stage completes.
7. Convex writes progress events.
8. Web UI receives progress through realtime subscriptions.
9. Watchdog checks stalled jobs.
10. Watchdog schedules a retry using the same idempotency key.

Convex scheduled mutations are guaranteed to execute exactly once, but actions with external side effects are at-most-once and are not automatically retried. Actions also time out after ten minutes. Therefore, Convex actions should only dispatch or inspect jobs; the long processing must occur on Zerops.

## 9.4 Retry policy

```text
Attempt 1: immediately
Attempt 2: 10 seconds
Attempt 3: 30 seconds
Attempt 4: 2 minutes
Attempt 5: 5 minutes
Final: manual retry available
```

A retry first asks the engine whether the idempotency key is already acknowledged or completed. It must never launch duplicate graph ingestion.

## 9.5 Signed communication

Every Convex-to-engine and engine-to-Convex request includes:

```text
X-HydraTrace-Timestamp
X-HydraTrace-Request-Id
X-HydraTrace-Signature
```

The signature is:

```text
HMAC-SHA256(secret, timestamp + "." + requestId + "." + rawBody)
```

Reject:

- Timestamps older than five minutes
- Reused request IDs
- Invalid signatures
- Unknown job IDs

---

# 10. HydraDB implementation

HydraDB must visibly perform the central retrieval and traversal work.

HydraDB provides snapshot-consistent OpenCypher queries, reverse adjacency, GraphBLAS-backed sparse traversal, Bolt connectivity, HTTP APIs, background indexing and native bounded path procedures.

## 10.1 Connectivity strategy

Use:

- **HTTP/NDJSON or batched OpenCypher** for bulk ingestion
- **Neo4j JavaScript driver over Bolt** for interactive graph queries
- **HydraDB native path procedures** for batch path retrieval
- **HTTP `/metrics` and readiness endpoints** for observability

HydraDB exposes Bolt on port 7687, HTTP on 8443 and administration endpoints on 9090.

## 10.2 Consistency strategy

Use:

| Operation | Consistency |
|---|---|
| Dashboard browsing | Causal |
| Incremental graph exploration | Causal |
| Final incident result | Strong |
| Post-remediation verification | Strong |
| Benchmark correctness test | Strong |

HydraDB documents causal and strong read modes, with strong reads refreshing from object storage before pinning a query snapshot.

## 10.3 Native path procedures

Use `algo.MSpaths` when retrieving paths between many deployed roots and many affected resolution nodes. This avoids one client query per service.

Use:

- `algo.SPpaths` for one source and one target
- `algo.SSpaths` for one source to many targets
- `algo.MSpaths` for many source/target combinations

The procedure configuration should include:

```text
relTypes: ["DEPENDS_ON_INSTANCE"]
relDirection: "out"
maxLen: 20
pathCount: controlled per deployment
resultLimit: controlled globally
```

HydraDB’s native procedures operate on a pinned storage snapshot and can use compiled GraphBLAS topology with the visible WAL overlay.

## 10.4 Separate graph node and indexer

Deploy:

```text
hydradb-node
  entrypoint: graph-node
  public: false
  internal ports: 7687, 8443, 9090

hydradb-indexer
  entrypoint: graph-indexer
  public: false
  admin port only
```

Both use the same object-storage bucket and graph prefix.

HydraDB’s architecture separates data nodes from indexer workers. Indexers build immutable traversal indexes in the background and publish them through object storage, while query nodes remain correct with the committed WAL overlay.

## 10.5 Object storage

Use Zerops Object Storage because it is powered by MinIO and is S3-compatible.

Create:

```text
Bucket: hydratrace-graph
Prefix: production/
```

Create a separate development prefix:

```text
development/
```

Never expose object-store credentials to the browser.

## 10.6 First infrastructure gate

Before implementing application features, verify this complete sequence:

1. Start graph node against Zerops Object Storage.
2. Create two nodes and one relationship.
3. Read them back through HTTP.
4. Restart the graph node.
5. Confirm the data still exists.
6. Start the indexer.
7. Confirm indexer metrics show a successful indexing cycle.
8. Run a bounded path query.
9. Record the tested image digest and configuration.

A listening port is not enough. The official HydraDB README similarly recommends verifying a real write/read round trip.

---

# 11. Exact blast-radius algorithm

## Input

```typescript
interface IncidentInput {
  ecosystem: "npm";
  packageName: string;
  affectedVersions?: string[];
  advisoryId?: string;
  startsAt?: number;
  endsAt?: number;
  environments?: string[];
}
```

## Phase 1: affected version resolution

1. Resolve package canonical ID.
2. Match explicit affected versions or OSV ranges.
3. Return exact `PackageVersion` nodes.
4. Record whether the version match came from OSV, manual input or both.
5. Reject ambiguous package names.

## Phase 2: affected lockfile instances

Find every `Resolution` connected to an affected `PackageVersion`.

```cypher
MATCH (r:Resolution)-[:INSTANCE_OF]->(pv:PackageVersion)
WHERE pv.id IN $affectedVersionIds
RETURN r.id, pv.id
```

## Phase 3: active snapshots and deployments

For every affected resolution:

1. Find containing lockfile snapshot.
2. Find deployments using that snapshot.
3. Check deployment interval.
4. Check incident interval.
5. Check environment filter.
6. Exclude development-only resolution paths from production findings unless explicitly requested.

## Phase 4: complete dependency paths

For every deployed snapshot:

1. Identify root resolution nodes.
2. Identify affected resolution nodes.
3. Use a bounded path query over `DEPENDS_ON_INSTANCE`.
4. Return the complete path.
5. Deduplicate paths by ordered resolution IDs.
6. Count paths even when UI displays only a limited sample.
7. Mark results as truncated if path-display limits are reached.

## Result

```typescript
interface BlastRadiusFinding {
  findingId: string;
  serviceId: string;
  deploymentId: string;
  environment: string;
  affectedPackageVersionId: string;
  firstExposedAt: number;
  lastExposedAt: number | null;
  direct: boolean;
  developmentOnly: boolean;
  pathCount: number;
  displayedPaths: EvidencePath[];
  reachability: ReachabilityLevel;
  evidenceRefs: string[];
}
```

## Accuracy rule

Never return only a package list. Every finding must include at least:

- Service
- Deployment
- Lockfile snapshot
- Exact affected version
- At least one complete dependency path
- Exposure interval
- Evidence source
- Reachability state
- Confidence and unknowns

---

# 12. Historical incident replay

The timeline slider should query exposure at timestamp `T`.

```text
T must fall inside:
  deployment.startedAt ≤ T < deployment.endedAt
  snapshot.createdAt ≤ T < snapshot.validUntil
  incident.startsAt ≤ T ≤ incident.endsAt
```

## Timeline events

Generate events for:

```text
Package version published
Advisory published
Affected snapshot created
Affected snapshot deployed
Static reachability detected
Runtime observation recorded
Fixed snapshot created
Fixed snapshot deployed
Final exposure path removed
```

## Important evidence rule

OSV’s advisory publication time is not automatically the malicious-package live window. The app must distinguish:

- `advisoryPublishedAt`
- `packagePublishedAt`
- `incidentStartsAt`
- `incidentEndsAt`
- `windowSource`
- `windowConfidence`

When the incident window is unknown, say:

> “The exact malicious-publication window is unavailable. Exposure is confirmed at deployment level, but historical overlap cannot be determined precisely.”

---

# 13. Reachability engine

## 13.1 Reachability levels

```text
0 — NOT_PRESENT
1 — INSTALLED
2 — STATIC_REACHABLE
3 — TEST_OBSERVED
4 — RUNTIME_OBSERVED
5 — UNKNOWN_DYNAMIC_BEHAVIOR
```

Do not treat “installed” as “executed.”

## 13.2 Static module graph

Use:

- TypeScript compiler APIs or `ts-morph`
- `es-module-lexer`
- Node module resolution
- Package `exports`, `main` and `module` fields
- Application entrypoint discovery

Detect:

```typescript
import x from "package";
import("package");
require("package");
require.resolve("package");
```

Determine application entrypoints from:

- `package.json` scripts
- Next.js routes
- Server entry files
- Worker entry files
- User-supplied entrypoint configuration

Build:

```text
EntryPoint ── REACHES ──> SourceModule
SourceModule ── IMPORTS_MODULE ──> SourceModule
SourceModule ── BELONGS_TO ──> PackageVersion
```

Then traverse from entrypoints to affected package modules.

## 13.3 Runtime evidence agent

Create a small Node instrumentation package:

```text
packages/reachability/runtime-agent/
```

It should:

1. Hook CommonJS module loading.
2. Hook ESM loading through a Node loader.
3. Resolve every loaded file to the nearest package root.
4. Read its package name and version.
5. Deduplicate observations.
6. Write a JSON trace.
7. Upload the trace to HydraTrace.

Example command:

```bash
NODE_OPTIONS="--import ./hydratrace-loader.mjs" npm test
```

Runtime trace:

```json
{
  "runId": "test-run-123",
  "startedAt": 1786700000000,
  "command": "npm test",
  "packages": [
    {
      "name": "package-x",
      "version": "1.4.2",
      "firstLoadedAt": 1786700001820,
      "loadCount": 4
    }
  ]
}
```

## 13.4 Abstention

Static analysis cannot prove every dynamic import path. Return:

```text
UNKNOWN_DYNAMIC_BEHAVIOR
```

when encountering unresolved dynamic module names, runtime-generated paths or unsupported loaders.

That honest uncertainty will improve result quality more than falsely marking every installed package as reachable.

---

# 14. Package-neighborhood intelligence

## 14.1 Shared-maintainer graph

```cypher
MATCH (bad:PackageVersion)-[:PUBLISHED_BY]->(m:Maintainer)
MATCH (other:PackageVersion)-[:PUBLISHED_BY]->(m)
WHERE other.id <> bad.id
RETURN m, other
```

Display:

- Shared maintainer identity
- Maintainer source
- First and last observed publication
- Number of related packages
- Whether the relationship changed recently

Never label another package malicious solely because it shares a maintainer.

## 14.2 Shared infrastructure

Create infrastructure nodes for:

- Repository host and repository identity
- Tarball host
- Homepage domain
- Maintainer email domain
- CI source repository
- Provenance identity where available

Then query packages sharing unusual infrastructure.

## 14.3 Typosquat scoring

Use deterministic features:

| Feature | Example |
|---|---|
| Damerau-Levenshtein distance | `lodahs` versus `lodash` |
| Keyboard-neighbor substitution | Adjacent-key mistakes |
| Homoglyph normalization | Similar Unicode characters |
| Token insertion/removal | `react-secure` versus `react` |
| Scope confusion | Scoped versus unscoped names |
| Token reordering | `node-fetch-safe` versus `safe-node-fetch` |
| Popularity asymmetry | Very low-download package near a popular name |
| Package age | Recently created package |
| Maintainer divergence | No relationship to the known package |

Store:

```text
Package ── SIMILAR_NAME_TO {score, reasons, computedAt} ──> Package
```

Use thresholds:

```text
0.85–1.00  Critical similarity
0.70–0.84  High similarity
0.55–0.69  Review
Below 0.55 Hidden by default
```

This is a risk indicator, not proof.

---

# 15. Deterministic risk scoring

AI must not generate the risk score.

Example transparent score:

```text
Risk =
  Severity             × 0.25
+ Environment          × 0.20
+ Reachability         × 0.25
+ Exposure breadth     × 0.15
+ Incident timing      × 0.10
+ Trust context        × 0.05
```

### Environment

```text
Production      1.00
Staging         0.65
Development     0.30
Unknown         0.45
```

### Reachability

```text
Runtime observed        1.00
Test observed           0.85
Static reachable        0.70
Installed only          0.35
Unknown dynamic         0.50
```

### Output

```text
90–100 Critical
70–89  High
40–69  Medium
0–39   Low
```

The evidence drawer should show the exact score components.

---

# 16. Remediation planner

This is one of the main originality features.

## 16.1 Candidate generation

For every vulnerable dependency path:

1. Identify direct dependencies controlled by the application.
2. Query available versions.
3. Identify versions that may resolve away from the affected package.
4. Prefer patch or minor upgrades.
5. Include direct replacement of the vulnerable package when applicable.
6. Exclude deprecated or known-vulnerable candidates.
7. Record the candidate’s expected semver impact.

## 16.2 Real lockfile simulation

For each promising candidate:

1. Copy the repository to an isolated temporary directory.
2. Apply the dependency version change.
3. Run:

```bash
npm install \
  --package-lock-only \
  --ignore-scripts \
  --audit=false \
  --fund=false
```

4. Enforce CPU, memory and time limits.
5. Parse the newly generated lockfile.
6. Create a temporary graph snapshot.
7. Re-run the affected-version traversal.
8. Calculate which exposure paths disappeared.
9. Delete temporary files.
10. Preserve only the resulting diff and evidence.

Never execute package lifecycle scripts during generic scans.

## 16.3 Weighted set-cover solver

Let:

```text
P = all vulnerable paths
C = all remediation candidates
coverage(c) = paths eliminated by candidate c
```

Candidate cost:

```text
cost(c) =
  semverPenalty
+ changedDirectDependencies
+ lockfileChurnPenalty
+ affectedServiceCount
+ verificationFailurePenalty
```

Use:

- Exact branch-and-bound when candidates ≤ 25
- Greedy weighted set cover for larger candidate sets
- Clearly label an approximate solution

## 16.4 Verification levels

```text
PROPOSED
  Candidate appears likely to remove exposure.

LOCKFILE_VERIFIED
  Fresh lockfile contains no affected resolution path.

BUILD_VERIFIED
  Project build succeeds in a controlled owned fixture.

TEST_VERIFIED
  Project tests pass in a controlled owned fixture.
```

For arbitrary external repositories, default to `LOCKFILE_VERIFIED`. Do not run untrusted project scripts.

## 16.5 Result format

```text
Recommended plan

1. Upgrade package-a from 3.6.0 to 3.6.2
   Services affected: checkout-api, payments-worker
   Paths eliminated: 5
   Semver impact: patch
   Verification: LOCKFILE_VERIFIED

2. Upgrade package-b from 7.1.0 to 7.1.1
   Services affected: analytics-dashboard
   Paths eliminated: 2
   Semver impact: patch
   Verification: LOCKFILE_VERIFIED

Before: 7 affected paths
After: 0 affected paths
Overall verification: PASSED
```

The “verified” label appears only after a strong-consistency HydraDB query returns zero affected paths.

---

# 17. AI system

## 17.1 AI features

AI should implement three product features.

### Incident Copilot

Questions such as:

- “Which production service is most urgent?”
- “How did this dependency enter checkout-api?”
- “Was payments-worker exposed yesterday at 10:30?”
- “Which related packages share the maintainer?”
- “What is the safest remediation plan?”
- “What evidence is still missing?”

### Advisory normalizer

Convert unstructured descriptions into structured candidate information:

```json
{
  "attackSummary": "...",
  "suspectedTechniques": [],
  "mentionedPackages": [],
  "mentionedFiles": [],
  "mentionedInfrastructure": [],
  "uncertainties": [],
  "sourceQuotes": []
}
```

All extracted fields are marked `AI_DERIVED` until matched to deterministic evidence.

### Report generator

Generate:

- Technical incident report
- Executive summary
- Pull-request comment
- Markdown export
- JSON export
- SARIF output generated deterministically, with optional AI explanation

## 17.2 Provider routing

### Primary

```text
Provider: Cloudflare Workers AI
Model: @cf/openai/gpt-oss-120b
```

Use for:

- Tool-calling copilot
- Structured summaries
- Evidence explanation
- Short advisory extraction

The model supports reasoning and function calling.

### Secondary

```text
Provider: NVIDIA NIM
Model: nvidia/nemotron-3-super-120b-a12b
```

Use for:

- Long incident context
- Complex remediation explanation
- Cloudflare failure or quota exhaustion

NVIDIA currently lists it as a free API endpoint intended for reasoning, instruction following and long-context workflows.

### Final fallback

A deterministic template report must work when both providers fail.

## 17.3 Allowed tools

The model never receives unrestricted database credentials or raw Cypher access.

Approved tools:

```text
getIncidentSummary
getBlastRadius
getFindingEvidence
getExposureTimeline
getDependencyPaths
getPackageNeighborhood
getReachabilityEvidence
getRemediationPlan
getUnknownEvidence
```

## 17.4 Grounded response contract

```typescript
const CopilotResponse = z.object({
  answer: z.string(),
  severity: z.enum(["critical", "high", "medium", "low", "unknown"]),
  evidenceRefs: z.array(z.string()),
  unknowns: z.array(z.string()),
  recommendedActions: z.array(z.string())
});
```

After model output:

1. Validate JSON.
2. Confirm every evidence reference exists.
3. Remove unsupported references.
4. Reject an answer with factual claims but no evidence.
5. Retry once with a repair prompt.
6. Fall back to the secondary model.
7. Fall back to deterministic output.

## 17.5 Provider reliability layer

Implement:

- Timeout: 25 seconds
- One retry for retryable errors
- Circuit breaker after repeated provider failure
- Response cache by evidence hash and prompt version
- Provider latency tracking
- Token or Neuron usage logging
- Prompt versioning
- Temperature near zero
- Maximum output size
- No repository secrets in prompts

---

# 18. Public API

## Scans

```text
POST   /v1/scans
GET    /v1/scans/:scanId
POST   /v1/scans/:scanId/cancel
GET    /v1/scans/:scanId/events
```

## Incidents

```text
POST   /v1/incidents
GET    /v1/incidents/:incidentId
GET    /v1/incidents/:incidentId/blast-radius
GET    /v1/incidents/:incidentId/timeline
GET    /v1/incidents/:incidentId/paths
GET    /v1/incidents/:incidentId/findings/:findingId
```

## Packages

```text
GET    /v1/packages/:packageId
GET    /v1/packages/:packageId/neighborhood
GET    /v1/packages/:packageId/maintainers
GET    /v1/packages/:packageId/similar-names
```

## Remediation

```text
POST   /v1/incidents/:incidentId/remediations
GET    /v1/remediations/:runId
POST   /v1/remediations/:runId/verify
GET    /v1/remediations/:runId/diff
```

## AI

```text
POST   /v1/incidents/:incidentId/copilot
POST   /v1/incidents/:incidentId/reports
```

## System

```text
GET    /health
GET    /ready
GET    /metrics
```

All list endpoints require pagination and server-side limits.

---

# 19. Web product

## Page 1: Overview

Display:

```text
Repositories scanned
Services monitored
Package versions
Dependency edges
Active advisories
Production exposures
Runtime-confirmed exposures
Last graph update
```

## Page 2: New scan

Input:

- Public repository URL
- ZIP upload
- Lockfile upload
- Environment
- Deployment timestamp
- Optional source scan
- Optional runtime trace

Show live stages through Convex:

```text
Acquiring repository
Parsing lockfile
Enriching package metadata
Writing graph
Waiting for index
Running exposure analysis
Complete
```

## Page 3: Incident center

Incident form:

```text
Package
Affected version or advisory
Incident start
Incident end
Environment filters
Include development dependencies
```

Result cards:

```text
Affected services
Production deployments
Complete paths
Runtime-confirmed services
First exposure
Final remediation status
```

## Page 4: Blast-radius graph

Use Cytoscape.js with server-side subgraph expansion.

Visual hierarchy:

```text
Advisory
  → PackageVersion
  → Resolution
  → Parent resolutions
  → LockfileSnapshot
  → Deployment
  → Service
```

Do not send the entire graph to the browser.

Provide:

- Expand one hop
- Collapse path
- Show only production
- Show only reachable
- Show only affected
- Highlight shortest path
- Highlight all evidence paths
- Copy evidence ID

## Page 5: Timeline

Features:

- Time slider
- Play incident replay
- Exposure count over time
- Deployment events
- Fix deployment events
- Selected-service filtering

Moving the slider must visibly change the affected graph.

## Page 6: Evidence drawer

For each finding:

```text
Service
Deployment
Environment
Lockfile and hash
Commit
Exact package version
Dependency path
Advisory source
Exposure interval
Static evidence
Runtime evidence
Confidence
Unknown information
```

## Page 7: Package neighborhood

Tabs:

- Shared maintainers
- Shared repository
- Shared infrastructure
- Similar names
- Public dependent graph

Every related package receives a reason, not merely a score.

## Page 8: Remediation

Display:

- Candidate upgrades
- Path coverage
- Semver impact
- Lockfile diff
- Verification level
- Before-and-after graph
- Remaining exposure count

## Page 9: Incident Copilot

Responses must show clickable evidence references:

```text
Payment Worker is the highest-priority service because it is in
production and the affected package was loaded during a test execution.

Evidence: E-104, E-119, E-203
Unknown: No production runtime trace is available.
```

## Page 10: Engineering page

Include a visible “How HydraDB is used” page containing:

- Graph schema
- Node and edge counts
- HydraDB path query type
- Query consistency mode
- Query latency
- Index freshness
- Last successful indexing time
- Why relational or vector-only storage would not produce the same result easily

This page directly supports the Best Use of HydraDB award.

---

# 20. CLI and GitHub Action

## CLI

```bash
npx hydratrace scan \
  --lockfile package-lock.json \
  --environment production \
  --format table
```

Incident query:

```bash
npx hydratrace incident \
  --package package-x \
  --version 1.4.2 \
  --from 2026-08-14T09:00:00Z \
  --to 2026-08-14T12:00:00Z
```

CI mode:

```bash
npx hydratrace gate \
  --baseline main \
  --fail-on reachable-high
```

## Exit codes

```text
0  No blocking exposure
1  Blocking exposure found
2  Scan failed
3  Configuration error
```

## Pull-request output

```text
HydraTrace Supply-Chain Gate

New affected paths: 2
Production-reachable paths: 1
Affected package: package-x@1.4.2

Path:
checkout-api
→ package-a@3.6.0
→ package-x@1.4.2

Recommended fix:
Upgrade package-a to 3.6.2

Verification:
Fresh lockfile removes all known affected paths.
```

The action should upload a JSON or SARIF artifact and link to the incident page.

---

# 21. Security design

## Repository acquisition

- Accept only GitHub HTTPS URLs or uploaded files.
- Block arbitrary internal or local URLs.
- Apply repository and archive size limits.
- Detect archive path traversal.
- Detect excessive decompressed size.
- Delete temporary repositories after processing.

## Package processing

- Never execute install scripts.
- Run package-manager resolution as a non-root user.
- Use temporary directories.
- Enforce process timeouts.
- Limit memory and output.
- Remove environment secrets from child processes.
- Verify lockfile integrity metadata when downloading artifacts.
- Do not install package contents unless required for controlled reachability analysis.

## HydraDB

- Keep Bolt, HTTP and admin ports internal to Zerops.
- Only the analysis engine can connect to HydraDB.
- Use an authentication token.
- Pin the HydraDB image by release and digest.
- Keep object-storage credentials server-side.
- Do not expose the object-storage bucket publicly.

Zerops gives services a private project network and service-hostname discovery, allowing HydraDB and the engine to communicate without public exposure.

## AI prompt injection

Advisory descriptions, package READMEs and repository text are untrusted.

- Wrap untrusted content as data.
- Do not let it define tools or system instructions.
- Do not provide models with credentials.
- Validate all model output.
- Require evidence references.
- Never execute model-generated commands.
- Never execute model-generated Cypher directly.

---

# 22. Observability

Use one trace ID across:

```text
Convex job
→ Zerops engine job
→ HydraDB query
→ external API request
→ AI request
```

## Metrics

### Engine

```text
hydratrace_jobs_total
hydratrace_job_duration_seconds
hydratrace_packages_parsed_total
hydratrace_graph_nodes_written_total
hydratrace_graph_edges_written_total
hydratrace_external_api_errors_total
hydratrace_remediation_simulations_total
hydratrace_ai_fallbacks_total
```

### HydraDB

Collect:

- Readiness
- Query latency
- Query fingerprints
- Cache outcomes
- Indexer last successful cycle
- Graph storage sequence
- Consistency mode

HydraDB exposes readiness and Prometheus metrics endpoints and structured tracing around query plans and cache behavior.

### UI

Create a hidden `/system` page showing:

- Service health
- Graph-node health
- Indexer health
- Last engine heartbeat
- External API cache status
- AI-provider circuit status

This helps during the live demo and debugging.

---

# 23. Correctness testing

## 23.1 Hand-authored fixtures

| Fixture | Expected result |
|---|---|
| Direct production exposure | One affected service and one path |
| Deep transitive exposure | Correct multi-hop path |
| Same package, safe version | No finding |
| Old snapshot only | Exposed historically, not currently |
| Development-only dependency | Excluded from production by default |
| Multiple vulnerable paths | All paths counted |
| Static reachable | Classified as static |
| Runtime observed | Classified as runtime |
| Dynamic unresolved import | Marked unknown |
| Shared maintainer | Related package returned with reason |
| Similar safe package name | Similarity context, not malicious label |
| Two-change remediation | Solver returns both changes |
| Incomplete remediation | Verification fails |
| No evidence | System abstains |

## 23.2 Property-based graph testing

Generate random dependency graphs with a fixed seed.

For each graph:

1. Calculate reverse closure using an in-memory reference implementation.
2. Import the same graph into HydraDB.
3. Run the HydraDB blast-radius query.
4. Compare affected roots and complete paths.
5. Fail on missing or unexpected results.

Use this to test:

- Chains
- Branches
- Shared transitive dependencies
- Multiple versions
- Cycles
- Depth limits
- Isolated nodes
- Large fan-out

## 23.3 Temporal tests

Test all boundary cases:

```text
Deployment starts exactly at incident start
Deployment ends exactly at incident start
Snapshot superseded during incident
Advisory withdrawn
Unknown incident end
Multiple deployments of same snapshot
Rollback to affected snapshot
```

## 23.4 Idempotency tests

- Dispatch same scan twice.
- Restart engine during parsing.
- Restart engine during graph writing.
- Lose callback after engine completion.
- Repeat external API response.
- Resume from a checkpoint.
- Verify no duplicate snapshot or relationship is created.

## 23.5 AI quality tests

Create twenty fixed incident questions.

Measure:

- Evidence-reference validity
- Unsupported factual claims
- Correct abstention
- Correct severity
- Provider fallback behavior
- JSON schema compliance
- Deterministic-template availability

Target:

```text
Invalid evidence references: 0
Unsupported exposure claims: 0
Schema-valid responses: 100% after repair/fallback
```

---

# 24. Performance benchmark

Do not claim ecosystem-scale performance without measurements.

## Generated benchmark sizes

```text
Small:    10,000 nodes / 40,000 edges
Medium:  100,000 nodes / 400,000 edges
Large:   250,000 nodes / 1,000,000 edges
Stretch: 500,000+ nodes / 2,000,000+ edges
```

Measure:

- Import throughput
- Index-build time
- Graph storage size
- Cold query latency
- Warm query latency
- Blast-radius p50 and p95
- Timeline-query p50 and p95
- Complete-path query latency
- Strong versus causal query latency
- Engine memory
- HydraDB node memory
- Indexer memory

## Benchmark output

Commit a machine-readable report:

```json
{
  "dataset": {
    "seed": 42,
    "nodes": 250000,
    "edges": 1000000
  },
  "environment": {
    "platform": "Zerops",
    "nodeCpu": 1,
    "nodeRamGb": 2
  },
  "results": {
    "importSeconds": 0,
    "blastRadiusP50Ms": 0,
    "blastRadiusP95Ms": 0,
    "timelineP95Ms": 0
  }
}
```

The UI must display only real measured values.

---

# 25. Demo dataset

Create a fictional but realistic organization:

```text
Acme Commerce
├── checkout-api
├── payments-worker
└── analytics-dashboard
```

Create multiple historical snapshots:

```text
09:00  All services safe
09:04  checkout-api lockfile resolves affected version
09:09  payments-worker deploys affected version
09:25  runtime test loads affected package
10:20  checkout-api deploys fixed snapshot
11:42  payments-worker deploys final fix
```

Design dependency paths:

```text
checkout-api
→ checkout-framework
→ telemetry-core
→ compromised-helper@1.4.2

payments-worker
→ queue-runtime
→ telemetry-core
→ compromised-helper@1.4.2

analytics-dashboard
→ chart-wrapper
→ safe-helper@1.4.3
```

The analytics service demonstrates correct non-exposure.

Include:

- Multiple paths into one service
- One development-only path
- One statically reachable path
- One runtime-observed path
- Shared-maintainer neighborhood
- Similar package name
- A remediation requiring two upgrades

Label fictional incident data clearly. Add at least one real OSV advisory scan separately to prove real ingestion.

---

# 26. Zerops deployment

## Services

```text
hydratrace-web
  Type: Node.js
  Public HTTPS
  Next.js application

hydratrace-engine
  Type: Node.js
  Public HTTPS only for application API
  Internal access to HydraDB
  Repository processing and resolution jobs

hydradb-node
  Type: Docker
  Private only
  Pinned HydraDB image
  Ports 7687, 8443, 9090

hydradb-indexer
  Type: Docker
  Private only
  Pinned HydraDB image with graph-indexer entrypoint

hydratrace-graph
  Type: Object Storage
  Private S3-compatible bucket
```

Zerops supports Node.js runtimes, Docker VMs, service-to-service networking, S3-compatible object storage, health checks and deployment configuration through `zerops.yaml`. Docker services should use pinned image versions or digests rather than `latest`.

## Networking

Public:

```text
hydratrace-web
hydratrace-engine application routes
```

Private:

```text
hydradb-node:7687
hydradb-node:8443
hydradb-node:9090
hydradb-indexer
object storage
```

Add rate limits to public scan and AI endpoints.

## Deployment order

1. Create Lightweight Core project.
2. Create object storage.
3. Deploy HydraDB graph node.
4. Verify write/read persistence.
5. Deploy indexer.
6. Verify index freshness.
7. Deploy engine.
8. Verify engine-to-HydraDB access.
9. Deploy Convex functions.
10. Deploy AI gateway.
11. Deploy web application.
12. Run end-to-end fixture scan.
13. Test from an incognito browser.
14. Record the final deployed commit SHA.

---

# 27. Day-by-day implementation schedule

## August 14 — Infrastructure and truth model

### Deliverables

- Fresh public repository
- Monorepo structure
- HydraDB local Docker smoke test
- HydraDB on Zerops
- Zerops object-storage persistence
- Separate indexer
- Graph-schema document
- First fixture graph
- Convex schema
- End-to-end health page

### Completion gate

```text
A graph write survives graph-node restart.
A three-hop path query returns the expected path.
```

Do not begin UI polish before this gate passes.

---

## August 15 — Exact lockfile ingestion

### Deliverables

- `package-lock.json` parser
- `pnpm-lock.yaml` parser
- Normalized intermediate representation
- Deterministic IDs
- Provenance records
- Batched HydraDB writer
- Immutable lockfile snapshots
- Deployment manifest ingestion
- Idempotency tests
- Scan progress in Convex

### Completion gate

```text
Three fixture repositories import without duplicates.
Expected node and edge counts match exactly.
```

---

## August 16 — Vulnerability intelligence and blast radius

### Deliverables

- OSV batch integration
- deps.dev integration
- npm metadata integration
- Advisory/version matching
- Complete reverse blast radius
- Full evidence paths
- Environment filtering
- Historical exposure query
- Timeline events
- Correctness fixture suite

### Completion gate

```text
Given an affected version and timestamp, HydraTrace returns
exactly the expected services, deployments and paths.
```

---

## August 17 — Reachability and package neighborhood

### Deliverables

- Static TypeScript/JavaScript module graph
- Entrypoint discovery
- CommonJS instrumentation
- ESM runtime loader
- Reachability levels
- Maintainer graph
- Infrastructure graph
- Typosquat scoring
- Evidence drawer
- Package-neighborhood UI

### Completion gate

```text
The UI distinguishes installed-only, static-reachable and
runtime-observed exposure with supporting evidence.
```

---

## August 18 — Remediation engine and durable orchestration

### Deliverables

- Candidate upgrade generation
- Safe lockfile-resolution sandbox
- Path-coverage calculation
- Weighted set-cover solver
- Strong-consistency fix verification
- Before-and-after graph diff
- Convex watchdog
- Retry and cancellation workflow
- Failure-injection tests

### Completion gate

```text
The recommended plan generates a fresh lockfile and a strong
HydraDB query confirms zero remaining affected paths.
```

---

## August 19 — Product and AI

### Deliverables

- Finished dashboard
- Incident center
- Graph explorer
- Timeline replay
- Remediation page
- Cloudflare AI adapter
- NVIDIA NIM adapter
- Provider fallback
- Evidence-grounded copilot
- Markdown/JSON/SARIF exports
- CLI and GitHub Action

### Completion gate

```text
The entire main demo can be completed through the deployed UI
without opening a terminal, except for the brief CI demonstration.
```

---

## August 20 — Measurement, reliability and submission assets

### Deliverables

- Large benchmark run
- Performance report
- AI evaluation
- Security review
- README
- Architecture diagram
- Graph-model documentation
- Attribution
- Apache-2.0 license for original application code
- HydraDB AGPL attribution preserved
- Demo data reset button
- Three-minute script
- Final production deployment

### Code freeze

**11:00 PM Nepal Time**

After freeze:

- Fix only submission-blocking defects
- Do not change graph schema
- Do not add providers
- Do not add ecosystems
- Do not redesign the UI

---

## August 21 — Submission buffer

### Before 7:00 AM Nepal Time

- Record final demonstration
- Upload unlisted video
- Verify audio
- Verify duration is under three minutes

### Before 10:00 AM Nepal Time

- Open repository in incognito mode
- Open demo in incognito mode
- Open video in incognito mode
- Test clean installation instructions
- Verify license and attribution
- Complete the submission form

### Absolute deadline

**12:44 PM Nepal Time**

---

# 28. Three-minute demonstration

## 0:00–0:20 — Problem

> “A package was compromised minutes ago. Traditional scanners can identify the package, but incident responders still need to know which deployed services are transitively exposed, when exposure started, whether the code is reachable, and which smallest upgrades eliminate every path.”

## 0:20–0:42 — Real ingestion

- Select Acme Commerce.
- Start a repository scan.
- Show package parsing and graph-writing stages.
- Show node and relationship counters.
- State that HydraDB holds the exact resolution and deployment graph.

## 0:42–1:15 — Blast radius

- Open the incident.
- Show affected package version.
- Show three services, with two truly affected.
- Open checkout-api’s complete path.
- Show commit, lockfile, deployment and advisory evidence.
- Point out that analytics-dashboard has a safe version and is excluded.

## 1:15–1:38 — Historical replay

- Move timeline to 09:00: no exposure.
- Move to 09:10: two services affected.
- Move to 10:30: checkout-api fixed, payments-worker still affected.
- State that this is a temporal graph query, not a static package list.

## 1:38–1:58 — Reachability

- Compare installed-only finding with runtime-observed finding.
- Open runtime evidence.
- Show unknown state where evidence is unavailable.

## 1:58–2:25 — Remediation

- Generate remediation.
- Show two recommended direct upgrades.
- Show path coverage.
- Verify fresh lockfile.
- Show:

```text
Before: 7 affected paths
After: 0 affected paths
Verification: PASSED
```

## 2:25–2:43 — AI copilot

Ask:

> “Which service should I fix first, and why?”

Show:

- Concise answer
- Evidence references
- Unknown production-runtime evidence
- Recommended action

State that AI explains graph evidence but does not calculate exposure.

## 2:43–3:00 — Why HydraDB

Show the engineering page:

- Graph schema
- Native multi-source path query
- Snapshot consistency
- Indexer freshness
- Measured latency
- Object-storage-backed graph

End with:

> “HydraTrace turns a compromised package into an exact, historical and verifiable incident response plan—using HydraDB for the graph work that vectors and flat scanners cannot perform.”

---

# 29. Judging-criteria mapping

| Criterion | Evidence judges should see |
|---|---|
| **Technical execution** | Two lockfile parsers, immutable snapshots, AST analysis, runtime loader, job state machine, provider fallback, exact solver, sandboxed lockfile regeneration, observability and tests |
| **HydraDB and graph-native use** | Exact dependency paths, reverse closure, temporal deployment graph, multi-source path procedures, strong verification queries, separate graph node/indexer and S3-compatible durability |
| **Product completeness** | Public web app, scan workflow, incident center, timeline, evidence drawer, remediation UI, CLI, GitHub Action and exports |
| **Quality of results** | Exact-version matching, provenance, confidence, abstention, fixture ground truth, property-based testing and post-fix verification |
| **Originality** | Combined temporal exposure, code reachability, package-neighborhood intelligence and minimum verified remediation |
| **Best Use of HydraDB** | Strong graph model, native traversal, path evidence, snapshot consistency, graph-indexing architecture and an application that would lose its central capabilities without HydraDB |

The organizers explicitly say strong submissions should have a functional product, real ingestion and retrieval, a clear use case, and thoughtful implementation. They separately highlight strong graph models, novel reasoning, meaningful traversal and use cases difficult for relational or vector-only approaches.

---

# 30. Features deliberately excluded

These exclusions protect product depth rather than reduce quality.

| Excluded item | Reason |
|---|---|
| Full PyPI support | The track allows npm or PyPI; deep npm support is more valuable than two incomplete ecosystems |
| Full npm-registry replication | Not needed to prove real ingestion, graph traversal or performance |
| Enterprise SSO | Does not contribute meaningfully to judging |
| Kubernetes production cluster | Zerops services provide enough deployment realism for the hackathon |
| General raw-Cypher chatbot | Unsafe, less reliable and weakens the deterministic product |
| Vector database | Not needed for exact dependency or deployment traversal |
| Running arbitrary repository scripts | Security risk |
| AI-calculated vulnerability status | Would reduce result trustworthiness |
| Unmeasured scale claims | Judges should see real benchmark results only |

---

# 31. Definition of done

HydraTrace is submission-ready only when all statements below are true.

## Core truth

- [ ] Exact package versions are parsed from real lockfiles.
- [ ] Lockfile topology is represented through snapshot-specific resolution nodes.
- [ ] HydraDB returns every expected affected deployment.
- [ ] Complete dependency paths are available.
- [ ] Historical queries change correctly with time.
- [ ] Development-only findings are classified correctly.
- [ ] Safe versions are not reported as affected.

## Engineering

- [ ] Graph writes are idempotent.
- [ ] A graph-node restart does not lose durable data.
- [ ] The indexer runs separately.
- [ ] Convex retries stalled dispatches safely.
- [ ] Every long-running stage reports progress.
- [ ] All public endpoints have limits and validation.
- [ ] HydraDB is not publicly exposed.
- [ ] Package install scripts are disabled.

## Differentiation

- [ ] Static reachability works on fixture applications.
- [ ] Runtime observations appear as graph evidence.
- [ ] Maintainer and infrastructure neighborhoods work.
- [ ] Similar package names include deterministic reasons.
- [ ] The remediation solver covers all vulnerable paths.
- [ ] A regenerated lockfile verifies the recommended plan.
- [ ] AI responses contain valid evidence references.
- [ ] AI failure falls back without breaking the product.

## Product

- [ ] Public deployed application works.
- [ ] Built-in demo can be reset.
- [ ] Incident workflow fits within the three-minute video.
- [ ] Graph visualization remains responsive.
- [ ] Timeline is understandable without explanation.
- [ ] Evidence can be inspected.
- [ ] Report export works.
- [ ] CLI and GitHub Action are documented.

## Submission

- [ ] Repository is public.
- [ ] Commit history begins during the hackathon.
- [ ] README contains setup and run instructions.
- [ ] HydraDB usage is explained clearly.
- [ ] Third-party APIs and libraries are attributed.
- [ ] License is present.
- [ ] Demo video is under three minutes.
- [ ] Repository, video and application links work in incognito mode.

---

# Final technical decision

Build the project around this hierarchy:

```text
HydraDB
  = graph truth, paths, temporal exposure and verification

Zerops
  = durable running compute, object storage and analysis workers

Convex
  = resilient workflow control and realtime product state

Cloudflare Workers AI + NVIDIA NIM
  = grounded explanation and enrichment with provider fallback

Deterministic TypeScript engines
  = parsing, reachability, scoring, typosquat detection and remediation
```

The strongest submission is not “an AI vulnerability scanner.” It is:

> **A graph-native software-supply-chain digital twin with exact lockfile topology, historical deployment state, code-level reachability, evidence-backed incident reasoning, and mechanically verified remediation.**

Every major claim in the demo must originate from HydraDB traversal or deterministic analysis, while AI makes those results easier to investigate and communicate.
