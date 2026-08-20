# Three-minute demo

## Recording preflight

Do not record until all of these are true:

- the release evidence has no pending rows for the exact deployed commit;
- <https://hydratrace.vercel.app> points to the Zerops engine;
- <https://hydratraceengine-2d0a-4100.prg1.zerops.app/ready> reports HydraDB and
  a healthy separate indexer;
- two **Restore Acme demo** operations return the same 2 production services and
  3 paths without duplicate graph records;
- demo candidate discovery returns three `LOCKFILE_VERIFIED` hash-pinned
  fictional-fixture candidates, and strong verification returns 0 remaining paths;
- copilot returns allowed evidence references (provider or deterministic fallback);
- the flow fits under three minutes in an incognito window at readable zoom.

The Acme organization and package identities are fictional. Candidate evidence
must visibly say `built-in-fictional-fixture`/hash-pinned cached evidence; never
claim the fictional versions were retrieved from npm or OSV.

The R2-backed engine API, Worker/fallback rollover, Vercel/Convex routing,
signed durable scan, functional public-browser flow, and responsive/accessibility
rerun have passed in
[the August 21 cutover record](evidence/2026-08-21-r2-cutover.md). The final
stricter local HydraDB gate also passed. The three-minute recording and
submission are the only manual owner tasks.

## Script

### 0:00–0:18 — Problem

> “A package was compromised minutes ago. A scanner can name the package, but
> responders still need every deployed service and dependency path, when the
> exposure existed, whether code reached it, and the smallest verified fix.”

Show the public Vercel application and the **Engine online** indicator.

### 0:18–0:38 — Deterministic ingestion

Click **Restore Acme demo**.

> “This restore idempotently loads immutable lockfile snapshots and deployments
> into the configured graph. The incident and package names are clearly marked
> fictional, so the demonstration is reproducible.”

Point to the status line: 3 exact production paths.

### 0:38–1:08 — Exact blast radius and evidence

Open **Incident center**.

- Show 2 affected production services and 3 complete paths.
- State that the analytics dashboard is excluded from production exposure
  because its production path resolves the safe version.
- Open checkout's evidence drawer.
- Point to exact commit, lockfile SHA-256, immutable snapshot, deployment,
  affected version, ordered path, timestamps, and evidence references.

> “These findings come from bounded graph traversal and deterministic version
> matching. AI is not involved.”

### 1:08–1:30 — Historical replay

Open **Timeline replay** and move to the 09:04 UTC event.

> “At this half-open boundary only checkout is exposed. Payment starts later;
> fixed snapshots end each exposure without rewriting history.”

Move forward once to show the second service becoming exposed.

### 1:30–1:48 — Reachability

Return to the finding cards/evidence:

- checkout is static-reachable from its entrypoint;
- payment has test-observed runtime evidence;
- missing production runtime evidence remains an explicit unknown.

> “Installed, statically reachable, observed, and unknown are different states.”

### 1:48–2:20 — Verified remediation

Open **Remediation** and click **Discover verified candidates**.

- Show the three direct upgrades and path coverage.
- Point out the `LOCKFILE_VERIFIED` label.
- Point out that this fictional restore uses hash-pinned cached fixture evidence,
  not a false npm/OSV claim.

Click **Run strong graph verification**. Require:

```text
Before: 3 affected paths
After: 0 affected paths
Level: STRONG_GRAPH
Status: VERIFIED
```

> “A candidate is not overall verified merely because a lockfile changed. Every
> affected service has a fixed snapshot, and HydraDB strongly returns zero paths.”

If the UI does not show all four values, stop recording and fix the gate. Do not
narrate an inconclusive result as passed.

### 2:20–2:42 — Grounded copilot

Open **Incident Copilot** and ask:

> “Which service should I fix first, and why?”

Show the answer, evidence-reference buttons, explicit unknowns, provider label,
and recommended action.

> “The model can explain only supplied evidence. Unsupported references are
> removed, and provider failure falls back without changing graph truth.”

Do not say Workers AI answered unless the displayed provider confirms it.

### 2:42–3:00 — Why HydraDB

Open **How HydraDB is used**.

- Point to HydraDB provider and strong consistency.
- Point to separate indexer health/freshness.
- Mention the private Cloudflare R2 bucket and the recorded restart-persistence gate.

> “HydraTrace turns a compromised version into an exact historical and
> mechanically verified response plan. HydraDB is the path and temporal truth
> layer; AI only makes that evidence easier to investigate.”

## After recording

- Verify duration is below 3:00 and audio is intelligible.
- Watch the uploaded copy from start to finish.
- Reopen the repository, video, and application links in incognito mode.
- Keep the production services unchanged until submission review is complete.
