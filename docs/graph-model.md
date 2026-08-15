# Graph model foundation

HydraTrace deliberately separates public ecosystem relationships from exact lockfile topology. Incident exposure is calculated only from immutable, snapshot-specific `Resolution` nodes.

## Exact dependency spine

```text
Service -[:HAS_DEPLOYMENT]-> Deployment
Deployment -[:USES_SNAPSHOT]-> LockfileSnapshot
LockfileSnapshot -[:CONTAINS]-> Resolution
Resolution -[:DEPENDS_ON_INSTANCE]-> Resolution
Resolution -[:INSTANCE_OF]-> PackageVersion
PackageVersion -[:VERSION_OF]-> Package
```

All canonical IDs are deterministic nonnegative 63-bit integers derived from a namespaced canonical key. Every imported fact carries source hash, repository, commit, import-run, parser-version, observation time, and confidence.

Deployment and snapshot intervals are half-open: `startedAt <= T < endedAt` and `createdAt <= T < validUntil`. Incident end times remain inclusive because they represent investigator-supplied windows rather than object lifetimes.
