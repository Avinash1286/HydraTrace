# Correctness gates

The August 15–16 foundation is accepted when:

1. Known-answer package-lock and pnpm fixtures normalize to exact expected counts and dependency paths.
2. Parsing the same content twice produces the same identifiers.
3. Importing the same snapshot twice creates no duplicate nodes or relationships.
4. OSV results are associated with exact package versions and can be served from a content-addressed cache.
5. The HydraDB smoke fixture survives a graph-node restart and the separate indexer reports a fresh cycle.
6. A bounded query returns the exact ordered vulnerable path.
