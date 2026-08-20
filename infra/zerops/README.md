# Zerops production stack

HydraTrace uses three Zerops services and one private Cloudflare R2 bucket:

- `hydratrace-graph-production` — private R2 S3-compatible durable storage;
- `hydradbnode` — private Docker service running the pinned HydraDB graph node;
- `hydradbindexer` — private Docker service running the separate pinned indexer;
- `hydratraceengine` — public Node.js API with private access to the graph services.

R2 is an approved release workaround for a Zerops-managed Object Storage
credential defect observed on two independently provisioned empty services.
It remains private and is accessed only through its authenticated S3 endpoint.

The web application is intentionally hosted on Vercel. Do not create a
`hydratraceweb` service merely to match the original plan.

## Configuration files

- `import.yaml` describes a fresh three-service project and the generated
  HydraDB/engine secret slots. It intentionally cannot create R2 credentials;
  the two bucket-scoped secrets below are a mandatory post-import step. Import
  it only into a new/empty intended project.
- `zerops.yaml` contains the build/run/health setup for the node, indexer, and engine.
- HydraDB is pinned to
  `ghcr.io/hydra-db/hydradb:0.1.1@sha256:db78309a233be54662db29744047e985a39b51c45a270d1a1f47c31a62cdb709`.
- The MinIO client used for the S3 preflight is pinned by release
  and digest in `zerops.yaml`.

Never re-import a full project definition into an existing project without
first listing and verifying the exact service targets. Replacing durable storage
can destroy the authoritative graph and rotate credentials; it is safe only
when the target is confirmed empty or a recovery plan exists.

## Secrets and generated values

The pinned storage endpoint is
`https://59b8589f738de5e4ab643bedd3a4b0a9.r2.cloudflarestorage.com`, the private
bucket is `hydratrace-graph-production`, and the S3 region is `auto`.
Create one R2 **Object Read & Write** API token scoped only to that bucket. Add
its one-time values to the `hydradbnode` service as secret variables named
`r2AccessKeyId` and `r2SecretAccessKey`. The indexer consumes them through the
generated `${hydradbnode_r2AccessKeyId}` and
`${hydradbnode_r2SecretAccessKey}` cross-service references. Never commit or
print either credential.

Required shared secrets:

- `hydradbnode.graphAuthToken`: random 32+ characters. The engine reads the
  same service-scoped value through `${hydradbnode_graphAuthToken}`.
- `hydratraceengine.HYDRATRACE_JOB_SHARED_SECRET`: identical to the Convex
  production value.
- `hydratraceengine.AI_GATEWAY_SHARED_SECRET`: identical to the Cloudflare
  Worker secret.

The import preprocessor can generate initial values, but generated engine
values still have to be installed on the corresponding Convex/Cloudflare side.
Rotate any value that was printed or otherwise exposed.

## Deployment

From the repository root:

```powershell
zcli service push hydradbnode -P <project-id> --setup hydradbnode --zerops-yaml-path infra/zerops/zerops.yaml --working-dir .
zcli service push hydradbindexer -P <project-id> --setup hydradbindexer --zerops-yaml-path infra/zerops/zerops.yaml --working-dir .
zcli service push hydratraceengine -P <project-id> --setup hydratraceengine --zerops-yaml-path infra/zerops/zerops.yaml --working-dir .
```

Deploy in that order. The node's initialization performs a direct bucket
`stat` using S3v4 first and exits before HydraDB starts if authentication fails.
R2 uses HTTPS, `AWS_ALLOW_HTTP` remains `"false"`, and
`AWS_VIRTUAL_HOSTED_STYLE_REQUEST` remains false for path-style access.

## Private networking

Keep these private to the Zerops project:

- HydraDB Bolt `hydradbnode:7687`;
- HydraDB HTTP query API `hydradbnode:8443`;
- HydraDB admin `hydradbnode:9090`;
- indexer admin `hydradbindexer:9091`;
- R2 bucket and S3 credentials;

Only engine port 4100 receives public subdomain access. Configure
`WEB_ORIGIN=https://hydratrace.vercel.app`; do not use `*` CORS.

## Readiness

- Graph node health: `hydradbnode:9090/readyz`
- Indexer health: `hydradbindexer:9091/readyz`
- Engine liveness: `/health`
- Engine dependency readiness: `/ready`
- Operator detail: `/v1/system`

The engine health check uses `/ready`, not `/health`. In this setup it returns
503 when HydraDB connectivity fails or the configured indexer is unhealthy.
The indexer must report advancing successful cycles, zero consecutive failures,
and a published `DEPENDS_ON_INSTANCE` generation; a one-time HTTP 200 is not
enough evidence.

## Mandatory production gate

Record every observed value in
`docs/evidence/2026-08-20-production-gate.md`:

1. R2 S3 preflight passes without credential output.
2. Graph node and indexer are active and ready.
3. Engine `/ready` reports HydraDB and a healthy configured indexer.
4. A fresh fixture import creates 72 nodes and 102 relationships.
5. The exact repeat creates 0 nodes and 0 relationships.
6. Production blast radius returns 2 services and 3 paths; development-included
   returns 3 services and 5 paths; the 09:04 UTC boundary returns only checkout.
7. Signed Convex scheduling produces the ordered stages and unsigned
   dispatch/callback requests return 401.
8. The graph node and engine are restarted without deleting R2 objects.
9. Readiness, exact incident results, and remediation verification remain correct.
10. Vercel is repointed only after all preceding checks pass.

R2 conditional-write compatibility is not treated as an assumption.
The S3, indexer, write/read, and restart round trip is the production gate.

## Safe shutdown and replacement

Stopping compute services does not authorize deleting the R2 bucket. Before
any replacement, resolve the exact service ID, stop graph writers, inspect
object/disk usage, and confirm the intended data disposition. After rotating
storage or credentials, redeploy both HydraDB services so their environment
snapshots reference the new values, then rerun the entire gate.
