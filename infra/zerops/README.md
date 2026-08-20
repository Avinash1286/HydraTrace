# Zerops production stack

HydraTrace uses four Zerops services:

- `hydratracegraph` — private S3-compatible Object Storage;
- `hydradbnode` — private Docker service running the pinned HydraDB graph node;
- `hydradbindexer` — private Docker service running the separate pinned indexer;
- `hydratraceengine` — public Node.js API with private access to the other three.

The web application is intentionally hosted on Vercel. Do not create a
`hydratraceweb` service merely to match the original plan.

## Configuration files

- `import.yaml` describes a fresh four-service project and generated secret
  slots. Import it only into a new/empty intended project.
- `zerops.yaml` contains the build/run/health setup for the node, indexer, and engine.
- HydraDB is pinned to
  `ghcr.io/hydra-db/hydradb:0.1.1@sha256:db78309a233be54662db29744047e985a39b51c45a270d1a1f47c31a62cdb709`.
- The MinIO client used for the Object Storage preflight is pinned by release
  and digest in `zerops.yaml`.

Never re-import a full project definition into an existing project without
first listing and verifying the exact service targets. Replacing Object Storage
can destroy the authoritative graph and rotate credentials; it is safe only
when the target is confirmed empty or a recovery plan exists.

## Secrets and generated values

Zerops generates the Object Storage endpoint, assigned bucket name, access key,
and secret key. Both HydraDB services consume the complete credential pair
through the generated `${hydratracegraph_accessKeyId}` and
`${hydratracegraph_secretAccessKey}` cross-service references. Do not copy or
hard-code these credentials, do not hard-code a bucket called
`hydratrace-graph`, and do not print credentials into terminal/evidence logs.

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
`stat` using S3v4 and then S3v2 signing; it exits before HydraDB starts if both
fail. This detects provisioned-but-unusable Object Storage credentials.

Inspect `${hydratracegraph_apiUrl}` before deployment. If the endpoint is
`http://`, set `AWS_ALLOW_HTTP` to `"true"` for both graph services.
`AWS_VIRTUAL_HOSTED_STYLE_REQUEST` stays false for path-style access.

## Private networking

Keep these private to the Zerops project:

- HydraDB Bolt `hydradbnode:7687`;
- HydraDB HTTP query API `hydradbnode:8443`;
- HydraDB admin `hydradbnode:9090`;
- indexer admin `hydradbindexer:9091`;
- Object Storage endpoint and credentials.

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

1. Object Storage preflight passes without credential output.
2. Graph node and indexer are active and ready.
3. Engine `/ready` reports HydraDB and a healthy configured indexer.
4. A fresh fixture import creates 72 nodes and 102 relationships.
5. The exact repeat creates 0 nodes and 0 relationships.
6. Production blast radius returns 2 services and 3 paths; development-included
   returns 3 services and 5 paths; the 09:04 UTC boundary returns only checkout.
7. Signed Convex scheduling produces the ordered stages and unsigned
   dispatch/callback requests return 401.
8. The graph node and engine are restarted without deleting Object Storage.
9. Readiness, exact incident results, and remediation verification remain correct.
10. Vercel is repointed only after all preceding checks pass.

Zerops/MinIO conditional-write compatibility is not treated as an assumption.
The S3, indexer, write/read, and restart round trip is the production gate.

## Safe shutdown and replacement

Stopping compute services does not authorize deleting Object Storage. Before
any replacement, resolve the exact service ID, stop graph writers, inspect
object/disk usage, and confirm the intended data disposition. After rotating
storage or credentials, redeploy both HydraDB services so their environment
snapshots reference the new values, then rerun the entire gate.
