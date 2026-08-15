# HydraTrace

HydraTrace is a temporal, reachability-aware software-supply-chain incident command system. It models exact npm lockfile topology in HydraDB so responders can retrieve complete affected deployment paths, replay historical exposure, and verify that remediation removes every vulnerable path.

This repository currently implements the foundation and exact-ingestion slice:

- deterministic, nonnegative 63-bit graph identifiers;
- evidence provenance on imported facts;
- normalized `package-lock.json` v2/v3 and `pnpm-lock.yaml` ingestion;
- idempotent graph-store contracts and batched HydraDB writes;
- cached OSV exact-version enrichment;
- known-answer fixtures and correctness tests;
- a HydraDB write/read/path smoke command.

## Requirements

- Node.js 24 or newer
- pnpm 10.33.0
- A reachable HydraDB instance for the graph smoke test

## Local verification

```bash
pnpm install
pnpm verify
pnpm scan:fixture
pnpm smoke:osv
```

Parser and idempotency tests do not require credentials. To exercise HydraDB, copy `.env.example` to `.env`, fill in the connection values, and run:

```bash
pnpm smoke:hydradb
```

See `infra/local/README.md` for the persistence-and-indexing gate that must be completed before application features are considered production-ready.

## Security

HydraTrace never executes lifecycle scripts while processing an arbitrary lockfile. Credentials belong in `.env` or the deployment secret store and must never be committed.

## License

Original HydraTrace application code is licensed under Apache-2.0. HydraDB and other dependencies retain their own licenses; see `docs/attribution.md`.
