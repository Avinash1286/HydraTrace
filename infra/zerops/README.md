# Zerops HydraDB setup

This configuration expects three existing Zerops services:

- `hydratracegraph` — private Object Storage;
- `hydradbnode` — private Docker service;
- `hydradbindexer` — private Docker service.

Create a project-level secret named `graphAuthToken` containing at least 32 random characters. Zerops generates the object-storage bucket name and credentials; do not create or hard-code a bucket named `hydratrace-graph`.

Before deployment, inspect `${hydratracegraph_apiUrl}`. If it starts with `http://`, change `AWS_ALLOW_HTTP` to `"true"` for both services. Keep all HydraDB ports private.

Deploy each setup using the zCLI `--zerops-yaml-path infra/zerops/zerops.yaml` option. After deployment, run the same smoke probe over the Zerops private network and verify:

- a strong read survives graph-node recreation;
- `graph_indexer_successful_cycles > 0`;
- `graph_indexer_last_success_ms > 0`;
- a `DEPENDS_ON_INSTANCE` generation has been published.

Zerops/MinIO conditional-write compatibility is not certified by either upstream project, so this real round trip remains a mandatory deployment gate.
