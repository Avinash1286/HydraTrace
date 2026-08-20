# Attribution

HydraTrace is original application code licensed under Apache-2.0.

Runtime dependencies retain their upstream licenses. Exact package names and
versions are recorded in `pnpm-lock.yaml`; no dependency is relicensed by this
repository.

## Data and infrastructure services

- [HydraDB](https://github.com/hydra-db/hydradb) is distributed separately under
  the [GNU AGPL-3.0 license](https://github.com/hydra-db/hydradb/blob/main/LICENSE).
  HydraTrace uses its published container image and APIs; no HydraDB source code
  is vendored or relicensed here.
- [OSV](https://osv.dev), [deps.dev](https://deps.dev), and the
  [npm Registry](https://www.npmjs.com) provide public vulnerability, dependency,
  and package metadata. HydraTrace preserves source URLs and advisory provenance.
- [Convex](https://www.convex.dev) provides durable workflow state and scheduled
  orchestration.
- [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) and the
  optional [NVIDIA NIM](https://build.nvidia.com) endpoint provide model inference.
  Their output is schema-validated and restricted to deterministic evidence IDs.
- [Zerops](https://zerops.io) provides private application compute and
  S3-compatible object storage; [Vercel](https://vercel.com) hosts the public web
  application and fallback engine deployment.

## Principal application libraries

HydraTrace is built with Next.js, React, Cytoscape.js, Fastify, Zod, the Neo4j
JavaScript driver, TypeScript, Vitest, and pnpm. Their copyright notices and
licenses remain those of their respective upstream projects and distributions.

## Demonstration data

Acme Commerce, `compromised-helper`, and the associated repositories,
maintainers, advisories, commits, deployments, and package releases are original
fictional fixture data. The UI labels them fictional. Hash-pinned
`built-in-fictional-fixture` remediation evidence is a reproducibility fixture,
not an assertion that these names or versions exist in npm, OSV, or GitHub.
