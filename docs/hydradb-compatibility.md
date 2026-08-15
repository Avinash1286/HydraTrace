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
- HydraDB's supported Cypher subset does not include `SET +=`, `labels()`, `properties()`, `type()`, `RETURN *`, or ordinary `RETURN p`.
- Zerops assigns the Object Storage bucket name; environment separation belongs in `GRAPH_DATA_PATH`.

These constraints are enforced in the client and infrastructure smoke tooling rather than hidden in UI code.
