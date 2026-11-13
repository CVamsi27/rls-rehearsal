# RLS Rehearsal learning sprint

**Build and defend a PostgreSQL tenant boundary in 14 days. Use the third week to put it in front of another engineer and turn the results into a case study, or take the ten-day fast path below.**

RLS Rehearsal is a NestJS and PostgreSQL lab for engineers building shared-database SaaS. Two workspaces share tables. Each can create, list, and close its own work items. A disposable failure rehearsal demonstrates that an isolation check can catch a leak. The second milestone adds a browser workflow, atomic closure history, and a rehearsal of upgrading and rolling back across real images.

This is a practice plan for a repository that already has working reference implementations. Predict and design each piece before reading its reference. For the deeper modules, rebuild the boundary or the test in a disposable Git worktree. The goal is to be able to explain, reproduce, and change the behavior yourself.

- **Full-rehearsal schedule:** 2–3 hours per day. Day 1 is 7 November 2026. The existing checkpoints are Day 7 (13 November), Day 14 (20 November), and Day 21 (27 November), at 8 p.m. IST. The [release handoff](release.md) tracks actual publication.
- **Full-rehearsal rhythm:** 20–30 minutes reading, 10 minutes predicting a failure and writing acceptance criteria, 75–100 minutes building and verifying, then 10 minutes writing what the evidence proved and what remains open.
- **Scope:** two workspaces, one item workflow, one database, and one screen. Keep accounts, billing, queues, and hosted deployment in the backlog. Reserve a separate 30-minute block for one tailored application or outreach action. Use the Bible as a reference for specific questions.

## Choose a track

Both routes use the same reference implementations, commands, and evidence standard.

| Track | Duration | Shape | Use it when |
| --- | --- | --- | --- |
| Full rehearsal | 21 days at 2–3 hours a day | Modules 1–6: build the API, add closure history and the browser, rehearse operations, then present | You are learning the whole pattern or expect to maintain the repository |
| Fast path | 10 working days at 4–5 hours a day | One vertical slice on top of the reference, ending in a defense | You already built or studied the reference and need one end-to-end story you can defend |

The fast path does not replace the full rehearsal. It assumes a clean baseline checkout and treats Modules 1, 2, and 4 as prerequisite reading. If you have not built the reference yet, use the 21-day route first.

## Fast path · closure evidence and delivery status

Add an optional closure note, attachment metadata, and a transactional outbox event to the existing close workflow. A worker delivers the event with a five-attempt retry budget, idempotency, and a dead-letter path. The activity response and the ledger expose delivery state.

This is the smallest honest version of a problem many teams meet: a database change must also produce a message, and the two must not disagree after a crash. The slice exercises tenant-scoped persistence, row security, transactions, composite keys, claim fencing, retry budgets, replay, observability, and a small UI change in one story.

**Scope guard:** attachment metadata only, no file bytes; a synthetic delivery target instead of a queue service; no auth provider, billing, or hosted deployment. If a day slips, cut the UI or the metrics, not the isolation and atomicity tests.

| Day | Build | Evidence to keep |
| --- | --- | --- |
| 1 | Run the clean baseline: `npm ci --ignore-scripts`, `npx --no-install playwright install chromium`, `npm run verify`. Read [the design decisions](design.md), [the transaction wrapper](../src/database.ts), [the item service](../src/items.ts), and both migrations. Write a one-page brief. | The baseline passes. The brief names the trust boundary, tables, transaction owner, outbox states, API contract, UI states, and eight failure cases. |
| 2 | Write failing tests first: closing with a note persists the note and the outbox event atomically; a foreign close writes nothing; a foreign attachment insert fails; a duplicate close records one event; a stale claim cannot complete. | Tests fail on the expected assertion, not on a compile error. |
| 3 | Add migration `003_closure_evidence.sql`: a note on `closure_events`; `attachments` and `outbox` tables; RLS, grants, composite foreign keys, and indexes. | Isolation tests pass; a foreign insert fails with `42501`; a cross-tenant reference is rejected. |
| 4 | Validate the note and attachment metadata. Insert the note and outbox event inside the existing close transaction. Add `addAttachment` and `listAttachments`. | Own create, list, close, and attachment reads work; foreign requests look identical to missing records; a duplicate close records one event. |
| 5 | Add a worker that claims a batch with `FOR UPDATE SKIP LOCKED`, a lease token, and `claimed_at`. | Two workers claim each row once; an expired lease cannot complete; a successful effect is recorded once. |
| 6 | Add a five-attempt retry budget and backoff, and a dead-letter state. | Failure → retry → dead after five attempts; the dead event keeps its last safe error and attempt count. |
| 7 | Add a replay script, then expose pending, dead, and oldest-age outbox metrics plus request duration. Keep worker logs safe. | Replay succeeds and is idempotent; a stale worker cannot mark the event done; metrics move after a failed delivery; logs contain route templates and no keys or item titles. |
| 8 | Seed 2,000 items, run 200 list calls at concurrency 4, and inspect `EXPLAIN (ANALYZE, BUFFERS)` for the list and outbox polling queries. Add an index only where the plan shows it helps. | Record row count, concurrency, errors, p95, p99, and both plans. Explain the read-versus-write cost of the index. |
| 9 | Write the case study around one failure, one trade-off, and one measured result. Update the README and docs. Add the small ledger change that shows the note and delivery state. Record a two-minute demo and a five-minute design review. | The ledger shows the note and delivery state without leaking another workspace; every claim traces to a command, test, or commit; limits are stated. |
| 10 | Defend the slice: 30-minute project grilling, 35-minute coding round, and 45-minute backend and design round. | A scorecard names the gaps and the next action for each. |

### Fast-path acceptance criteria

- [ ] A clean checkout installs, migrates, and passes `npm run verify`.
- [ ] `docker compose up -d --build --wait` serves the ledger; `npm run demo` and `npm run test:control` pass.
- [ ] A closure note and outbox event commit atomically; a forced event failure leaves the item open.
- [ ] Foreign item, attachment, and history requests look identical to missing records at the HTTP boundary.
- [ ] Two workers do not process the same event concurrently; an expired lease cannot complete.
- [ ] A failed delivery retries with a five-attempt budget, becomes dead after it, and replays idempotently.
- [ ] The activity response and UI expose delivery state without leaking another workspace's data.
- [ ] Metrics and logs explain a failed delivery without keys, titles, or patient-like data.
- [ ] The case study separates the reference implementation from your extension.

### Where the full modules still apply

| Need | Module |
| --- | --- |
| Trust boundary, forged scope, role and policy reasoning | [Module 1](#module-1--frame-the-problem-and-draw-the-boundary) |
| Table ownership, transaction-local scope, broken control | [Module 2](#module-2--build-database-isolation-and-prove-it-fails-when-broken) |
| Composite keys, atomic event insert, browser states | [Module 4](#module-4--make-closure-history-atomic-and-usable) |
| API contract, Compose install, CI, release candidate | [Module 3](#module-3--ship-the-api-and-make-setup-repeatable) |
| Readiness, logs, upgrade and rollback, performance context | [Module 5](#module-5--operate-recover-and-verify-a-release) |
| Pilot, case study, demo, resume claim, retrospective | [Module 6](#module-6--extend-the-pattern-and-present-it) |

Use the [outcome checklist](outcome-verification.md) for the two release milestones. The fast path replaces their dates with its own defense, not their verification standard.

## Start here

Install the Node version in [the version file](../.node-version), Docker with Compose, and Git. Use the tagged implementations as stable references. To rehearse a change without modifying your main checkout, run from the repository:

```sh
git worktree add --detach ../rls-rehearsal-study v0.2.0-rc.2
cd ../rls-rehearsal-study
npm ci --ignore-scripts
npx --no-install playwright install chromium
npm run verify
```

The API-only reference is `v0.1.0-rc.1`. The browser and history reference is `v0.2.0-rc.2`. These tags predate the public name and show **TenantProof** in their material. Exercise failures against synthetic data using the disposable test runner. For a parallel Compose demo, use a unique project name and free loopback port, then point `DEMO_URL` at that port. See [operations](operations.md) for cleanup and recovery.

## Module 1 · Frame the problem and draw the boundary

**Learn before building (25 min).** Read what a database role can access, what row security adds, and what an authenticated caller can still attempt. Separate authentication (who is calling) from authorization (what rows they may access). Trace the key → workspace → connection → row path. [PostgreSQL row security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html) · [Nest guards](https://docs.nestjs.com/guards)

| Day | Practice | Outcome to verify |
| --- | --- | --- |
| 1 · Nov 7 | Write a one-page brief: who will use the lab, the query failure it reproduces, the two-minute demo, and what you will defer. Identify a pilot you can invite for Day 13. | Show the brief to an engineer or read it cold. They can say what they would run, how long it takes once built, and what result would convince them. |
| 2 · Nov 8 | Draw the trust boundary and write the API contract before reading the [reference decisions](design.md). Record tradeoffs for shared tables, explicit transactions, and provisioned keys. | Trace one valid read and one forged workspace request. For each trust crossing, name the data, the component that validates it, and what fails if that validation is removed. |

**Capture:** one-page brief, data-flow diagram, three decision records, and a four-case threat list (forged scope, known foreign ID, privileged database role, escaped connection). **Review prompt:** Which failure does RLS still cover when application code forgets a filter? What changes if an attacker can run arbitrary SQL as the app role?

## Module 2 · Build database isolation and prove it fails when broken

**Learn before building (30–40 min split across the days).** Study table ownership, column grants, `USING` versus `WITH CHECK`, `FORCE ROW LEVEL SECURITY`, pool checkout, and transaction-local settings. Predict what happens to session state after commit and rollback. [Role attributes](https://www.postgresql.org/docs/17/role-attributes.html) · [Policies](https://www.postgresql.org/docs/17/ddl-rowsecurity.html) · [Configuration functions](https://www.postgresql.org/docs/17/functions-admin.html) · [node-postgres transactions](https://node-postgres.com/features/transactions)

| Day | Practice | Outcome to verify |
| --- | --- | --- |
| 3 · Nov 9 | Write the item table and role matrix. Separate the migration owner from the runtime role. Seed one known row per workspace, and query as the runtime role. | A query without a workspace predicate returns one own row; an unscoped query returns zero. A foreign insert fails. Prove the other row exists from its own workspace. |
| 4 · Nov 10 | Bind scope on a checked-out connection. Reuse a pool of one across success and error paths. Run overlapping transactions with a pool of two. | The one-connection test verifies the backend PID and shows zero visible rows after both commit and rollback. Two simultaneously checked-out connections see separate rows. The broken control catches the foreign row. |

**Capture:** migration and role/grant review, expected versus actual row matrix, and the control output. **Failure drill:** in your scratch worktree, predict what replacing the transaction-local flag with session scope would do after commit. Run the pool tests with that change, record the red result, then revert your scratch change and record green. See [migration 001](../db/migrations/001_items.sql), [transaction wrapper](../src/database.ts), and [database tests](../test/database.test.cjs).

## Module 3 · Ship the API and make setup repeatable

**Learn before building (30 min).** Review input validation, error contracts, resource enumeration, health checks, and dependency startup order. Learn why a passing HTTP test against mocks cannot validate PostgreSQL enforcement. [Nest controllers](https://docs.nestjs.com/controllers) · [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/) · [GitHub Actions and PostgreSQL](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)

| Day | Practice | Outcome to verify |
| --- | --- | --- |
| 5 · Nov 11 | Implement create, list, read, and close. Derive workspace from the verified key, reject unknown body fields, and return one error shape for missing and foreign items. | Run two independent callers. Each can create, list, and close its own item. Forged input gives `400`, invalid credentials give `401`, and foreign read/close matches a missing ID's `404` without changing the owner’s item. |
| 6 · Nov 12 | Add the Compose quickstart, an HTTP demo, and CI. Test the installation in a new checkout with a new data volume. | Migrations finish before the app accepts traffic. The restricted role starts the app. The migration owner's credential is rejected. The documented commands run without knowledge from your working directory. |
| 7 · Nov 13 | Freeze the API candidate. Run the [API milestone gate](outcome-verification.md#api-milestone-v01), record the result, and prepare release notes and the demo. | A clean tagged checkout passes its verification and both proof commands. The notes identify the tag, environment, test counts, and open limits. |

**Capture:** API examples, clean-install output, and the short demo. **Review prompt:** If the foreign close returns `404`, how do you know it failed to write instead of just hiding the result?

## Module 4 · Make closure history atomic and usable

**Learn before building (30–40 min).** Study composite keys, transaction atomicity, row locks, and how PostgreSQL rechecks a waiting update at Read Committed. For the browser, review session-state clearing, keyboard focus, and stale asynchronous results. [PostgreSQL constraints](https://www.postgresql.org/docs/17/ddl-constraints.html) · [Transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html) · [Playwright test practices](https://playwright.dev/docs/best-practices)

| Day | Practice | Outcome to verify |
| --- | --- | --- |
| 8 · Nov 14 | Add closure events through an additive migration. Design a composite foreign key for workspace and item and give history its own policy. | The old app still reads and writes items after migration. An event that pairs a workspace with an existing foreign item is rejected. Existing closed items can have empty history. |
| 9 · Nov 15 | Implement the one-way close and event insert in a single transaction. Force two requests to wait on the same row, then release it. Force a separate event insert to fail. | Both competing closes complete and exactly one event exists. When the insert fails, the item stays open and history is empty. A foreign caller cannot read the history. |
| 10 · Nov 16 | Build the browser sequence: connect, create, close, inspect history, and switch keys. Design the loading, empty, and error states. | Use the keyboard for sign-in and creation. Hold the next workspace response while switching and assert the previous list and history are already gone. Check the mobile viewport and that keys are absent from browser storage. |

**Capture:** migration diff, lock-wait evidence, failed-write evidence, and a browser capture. **Review prompt:** Which invariant belongs in the schema, and which behavior belongs in the transaction? See [migration 002](../db/migrations/002_closure_events.sql), [HTTP tests](../test/http.test.cjs), and [browser test](../test/browser.test.cjs).

## Module 5 · Operate, recover, and verify a release

**Learn before building (30 min).** Separate liveness from readiness. Learn to follow a request ID through safe logs. Review additive migrations, mixed versions, app rollback, B-tree ordering with `LIMIT`, and how to interpret a small latency sample. [Docker health checks](https://docs.docker.com/reference/dockerfile/#healthcheck) · [Indexes and ordering](https://www.postgresql.org/docs/17/indexes-ordering.html) · [Using EXPLAIN](https://www.postgresql.org/docs/17/using-explain.html)

| Day | Practice | Outcome to verify |
| --- | --- | --- |
| 11 · Nov 17 | Stop PostgreSQL with the app running. Record readiness, liveness, request IDs, and startup/error events. Restart the database. | Liveness stays `200`; readiness becomes `503` and returns to `200` after restart. Both workspaces remain isolated. Logs contain safe codes and route templates without keys or item titles. |
| 12 · Nov 18 | Rehearse v0.1 → migration → v0.2 → v0.1 → v0.2 using real images and one disposable volume. Inspect the list query plan and measure a small baseline. | Core data and isolation survive each transition. Existing events remain after rollback; closes made by v0.1 during rollback have empty history. Record sample size, concurrency, row count, errors, p95, and plan. |
| 13 · Nov 19 | Observe the [pilot exercise](pilot.md) without driving. If the pilot cannot attend, run the exercise yourself and mark independent validation pending. | Record the first blocker and time to the first item. Make one targeted docs or test improvement and rerun the affected check. Keep your run distinct from an independent result. |
| 14 · Nov 20 | Freeze the browser candidate and execute the [browser milestone gate](outcome-verification.md#browser-milestone-v02). Prepare a release note that says what the artifact actually proved. | Tag, commit, commands, observed results, limits, and pilot status are documented. Hosted CI and publishing are separate from passing local checks. |

**Capture:** outage timeline, rollback transcript, performance context, and release evidence. **Review prompt:** If the migration is healthy but the new app is failing, which artifact do you roll back? What is your stop condition?

## Module 6 · Extend the pattern and present it

**Learn before building (20 min).** Review how to validate a claim against evidence, write a useful review request, and compare a single local run with an independent integration. Read the [case study](case-study.md) and the [tenant-owned table extension recipe](design.md#add-a-tenant-owned-table) after writing your own outlines.

| Day | Practice | Outcome to verify |
| --- | --- | --- |
| 15 · Nov 21 | Give a peer the threat model and a failure drill. Ask them what breaks if the application credential is exposed. | Capture their first concern and whether they reproduced the drill. Keep peer review status explicit. |
| 16 · Nov 22 | Fix the most consequential pilot or review finding. If you have no feedback yet, add a small tenant-owned table in your study worktree. | A regression fails before your fix and passes after it. An extension must include a second-tenant read, a forged write, and a cross-tenant reference check. |
| 17 · Nov 23 | Write a one-page case study around one failure, one tradeoff, and one measured result. | Each claim traces to a command, observation, or candidate commit. Label synthetic performance and validation accurately. |
| 18 · Nov 24 | Record a two-minute demo and practice a five-minute design review. | Show own access, a foreign ID rejection, and the broken control. Explain how you would detect and recover from a regression. |
| 19 · Nov 25 | Draft a resume bullet and a project blurb. Link your own contributions, the candidate, and the evidence you can reproduce. | You can defend each verb and number. Credit the reference implementation and describe what you personally designed, rebuilt, tested, or changed. |
| 20 · Nov 26 | Use the project in a relevant application and rehearse one security, one concurrency, and one operations answer. | Each answer gives the context, decision, observed result, and one remaining limit in under two minutes. |
| 21 · Nov 27 | Write a retrospective and rank three follow-up issues by user impact and effort. | Identify one decision you would keep, one you would change, and the evidence that changed your mind. Decide whether to maintain the project using feedback and actual use. |

A module is complete when you can **predict** a failure, **reproduce** the observed behavior, and **explain** why it occurs without reading the implementation. Log unverified outcomes in the [evidence template](outcome-verification.md#evidence-record).
