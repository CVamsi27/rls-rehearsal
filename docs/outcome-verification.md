# RLS Rehearsal outcome verification

Use this checklist with the [learning sprint](learning-plan.md). Record evidence from the candidate you intend to ship. A command that could not run, a skipped isolation test, or a historical run against another commit leaves that gate open.

The [10-day fast path](learning-plan.md#fast-path--closure-evidence-and-delivery-status) uses its own acceptance criteria and the same evidence record. The two release milestones below belong to the 21-day route; a fast-path defense does not require both releases, but it does require the clean-checkout, isolation, and replay observations.

## API milestone (v0.1)

Use a clean checkout of the selected API candidate, with the version from `.node-version`, Docker, and a fresh synthetic Compose volume. The historical API reference is `v0.1.0-rc.1` and ran 10 tests with no skips.

```sh
npm ci --ignore-scripts
npm run verify
docker compose up -d --build --wait
npm run demo
npm run test:control
```

| Claim | Required observation |
| --- | --- |
| Each workspace can use the API | Both keys create and list their own items. An owner can close its item and repeat the close. A foreign read and close return the same `404` shape as a missing item. Re-read as the owner and verify the foreign attempt changed nothing. |
| The database enforces isolation without an application filter | Both seed rows exist. Under the runtime role, an unfiltered query returns only the caller’s row. An unscoped query sees zero. A foreign insert, tenant reassignment, and forbidden table operations fail. The app refuses migration-owner credentials. |
| Pooled connections preserve isolation | The same backend PID sees no rows without scope after commit and rollback. Two simultaneously checked-out connections each see their own workspace. |
| The test can detect a leak | The control passes while RLS is enabled. With RLS disabled in its own disposable database, the same assertion observes the foreign row and fails as expected. The outer control command exits zero because it recognized that exact failure. |
| Someone can run the artifact | A clean checkout installs from its lockfile, applies migrations before app startup, and runs the documented demo. Capture image and database versions with the tag and commit. |

## Browser milestone (v0.2)

Repeat the API checklist with the v0.2 candidate. Install the browser before verification. The historical browser reference is `v0.2.0-rc.2` and ran 15 tests with no skips.

```sh
npm ci --ignore-scripts
npx --no-install playwright install chromium
npm run verify
docker compose up -d --build --wait
npm run demo
npm run test:control
```

Then run the [image rehearsal](operations.md#rehearse-using-release-images) with both verified refs. The reference command is `npm run rehearse -- v0.1.0-rc.1 v0.2.0-rc.2`. Substitute the intended release refs when cutting a new release.

| Claim | Required observation |
| --- | --- |
| Closure and history are atomic | Confirm both close requests are waiting on the row before releasing it. Both succeed, and the item has one event. With event insertion forced to fail, the item remains open and history stays empty. |
| History shares the tenant boundary | Foreign history looks like missing history at the HTTP boundary. An unfiltered SQL read sees only its workspace events. A forged workspace write and a cross-tenant item reference fail for their respective reasons. |
| Workspace switching clears visible data | Create and close an item with keyboard support. Show its history. Hold the next workspace response and verify old items and history are already absent from the DOM. Check a 375 px viewport and verify browser storage contains no key. |
| The app can recover and roll back | The old app works after the additive migration. The new app records history. Database downtime leaves liveness at `200` and readiness at `503`; readiness recovers. Rollback preserves items and isolation. Re-upgrade preserves prior events and leaves rollback-era closes without events. |
| The measurement is reproducible | Record sample size, concurrency, row count, errors, p95, and the query plan. The built-in rehearsal uses 80 list calls at concurrency four after adding 2,000 synthetic items. Check the actual scan. Treat latency as a local baseline. |
| A new reader can finish | Run the [independent pilot](pilot.md) and record the result. A maintainer’s walkthrough verifies the instructions locally. An independent walkthrough verifies usability. Use in the pilot’s own workflow is a separate adoption outcome. |

## Evidence record

Copy this into your sprint notes once per milestone or regression. Keep the shortest useful excerpt of each result and use synthetic data.

| Field | Record |
| --- | --- |
| Claim and candidate | Behavior under test, tag or commit, and whether the checkout was clean |
| Setup | OS and architecture, Node, PostgreSQL, Docker and Compose versions, data size, caller role |
| Expected result | Own success, foreign failure, and the expected state after the failure |
| Observed result | Exact command, exit status, pass/fail/skip counts, and one representative result |
| Sensitivity | The controlled fault you introduced, the expected red result, and the clean rerun |
| Release disposition | Pass, fail, blocked, or pending, with a concrete next action for any open gate |
| Claim limits | What the test cannot establish, including deployment context, independent review, or adoption |

## Decide whether to ship

- **Release blocker:** isolation or atomicity fails, the broken control fails for the wrong reason, a required check is skipped, or a clean install fails. Record the exact failure and withhold that candidate.
- **Scope cut:** simplify visual polish or defer performance tuning. If closure history is unsafe, remove it from the candidate and verify the revised scope from a clean checkout. Keep isolation and install verification in the gate.
- **Pending external validation:** track hosted CI and an independent pilot in the [release handoff](release.md). Name any unverified claim in the release note.
