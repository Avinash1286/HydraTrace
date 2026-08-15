# HydraTrace fixtures

These files are deliberately small, hand-authored parser fixtures. They are not
installable applications and their package names, package contents, integrity
values, incident, repositories, commits, and deployments are fictional.

The Acme Commerce set contains one repository for every mandatory lockfile
shape:

| Repository | Lockfile shape | Main purpose |
| --- | --- | --- |
| `checkout-api` | `package-lock.json` v3 | Three-hop exposure, duplicate package versions/install paths, optional and peer flags |
| `payment-worker` | `package-lock.json` v2 | Legacy `dependencies` mirror and two production paths to one affected instance |
| `analytics-dashboard` | `pnpm-lock.yaml` v9 | Safe-version control, dev-only exposure, optional dependency, peer suffix and peer metadata |

`expected-results/acme-commerce.normalized.json` is the machine-readable source
of truth. Counts include one root resolution per importer. npm resolution
locators are `packages` map keys; pnpm locators are importer/package snapshot
keys. A production path is rejected if any edge from its root is declared as a
development dependency or if its target is otherwise reachable only from a
development dependency. The pnpm v9 format does not repeat a `dev` boolean on
every package entry, so the expected `dev` values are effective classifications
derived from importer reachability. A package reachable from both production
and development roots is production, not dev-only.

Do not run `npm install` or `pnpm install` in these directories. The registry
URLs and Subresource Integrity values exist only to exercise parsing and
provenance handling.
