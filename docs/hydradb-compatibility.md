# HydraDB v0.1.1 compatibility notes

HydraTrace targets the open-source `hydra-db/hydradb` runtime and pins tag `v0.1.1`, commit `02a40025d2d57e97ab2754c8256219cdbfeab379`.

Verified runtime constraints that supersede older assumptions in `plan.md`:

- Native path direction values are `outgoing`, `incoming`, or `both`; `out` is invalid.
- Native path depth is capped at 16 in v0.1.1.
- `SPpaths` and `SSpaths` accept numeric node IDs. `MSpaths` uses indexed string-property selectors.
- Path and result caps must be reported as truncation; a capped result is not “all paths.”
- The indexer admin port is 9091, not 9090.
- HydraDB requires an auth token file with at least 32 non-placeholder characters.
- `RUST_MIN_STACK=33554432` is required for the first real query, not merely readiness.
- HydraDB v0.1.1 may split its Bolt manifest response across TCP events. In the
  verified server/client pairing, `neo4j-driver` 6.2 parsed the incomplete first
  event and reached an out-of-range native `Buffer` read; HydraTrace therefore
  pins `neo4j-driver` 5.27.0 and its compatible classic Bolt negotiation path.
- Scalar graph reads and writes are serialized over Bolt. Complete-path reads
  use the lossless HTTP NDJSON query surface with causal or strong consistency,
  and fail closed if the terminal summary is missing or reports truncation.
- HydraDB's supported Cypher subset does not include `SET +=`, `labels()`, `properties()`, `type()`, `RETURN *`, or ordinary `RETURN p`.
- The production deployment uses the private Cloudflare R2 bucket
  `hydratrace-graph-production`, S3 region `auto`, and path-style requests;
  environment separation still belongs in `GRAPH_DATA_PATH`.
- The local persistence smoke wrapper allows 180 seconds so a verified cold
  restart/read is not misclassified by the former 60-second wrapper ceiling.

These constraints are enforced in the client and infrastructure smoke tooling rather than hidden in UI code.
