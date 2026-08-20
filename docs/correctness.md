# Correctness gates

The project is accepted when:

1. Known-answer package-lock and pnpm fixtures normalize to exact expected counts and dependency paths.
2. Parsing the same content twice produces the same identifiers.
3. Importing the same snapshot twice creates no duplicate nodes or relationships.
4. OSV results are associated with exact package versions and can be served from a content-addressed cache.
5. The HydraDB smoke fixture survives a graph-node restart and the separate indexer reports a fresh cycle.
6. A bounded query returns the exact ordered vulnerable path.
7. Exact and historical blast-radius cases match the known-answer services and paths.
8. Installed, static, runtime, and unknown reachability remain distinct evidence states.
9. Remediation covers all original paths and passes only after a strong zero-path query.
10. A Convex-backed scan returns a durable queued identity, signed dispatch
    completes asynchronously, and ordered events remain queryable from the engine.
11. The Vercel web and Zerops engine pass dependency readiness, CORS, and a real
    lockfile ingestion; the Vercel fallback is checked separately as in-memory.
12. AI provider output cannot introduce an unapproved evidence reference.
13. Eight fixed-seed graph shapes imported into live HydraDB return exactly the independent reference paths.
14. An interrupted signed engine job resumes idempotently from its durable checkpoint.
15. Lost progress callbacks cannot erase a completed engine result or trigger duplicate ingestion.
16. Process liveness remains separate from dependency readiness; configured
    HydraDB or indexer failure makes `/ready` return 503.
