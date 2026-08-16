# HydraTrace runtime agent

Collect CommonJS package-load evidence without running any installation scripts:

```powershell
$env:HYDRATRACE_SNAPSHOT_ID = "<snapshot stable ID>"
$env:HYDRATRACE_TRACE_FILE = "hydratrace-runtime-trace.json"
node --require ./packages/reachability/runtime-agent/register.cjs ./your-test.js
```

For an ES module application, use the loader. It appends one lossless JSONL
event per first-observed package:

```powershell
$env:HYDRATRACE_TRACE_FILE = "hydratrace-runtime-trace.jsonl"
node --import ./packages/reachability/runtime-agent/register.mjs ./your-app.mjs
```

Upload the resulting JSON to `POST /v1/reachability/runtime`. Set
`HYDRATRACE_TRACE_KIND=runtime` only for a trace captured from the deployed workload;
the default is the weaker `test` evidence state.
