# RLS Rehearsal release handoff

| Milestone | Planned date and time (IST) | Historical reference |
| --- | --- | --- |
| Public API and isolation proof | 13 November 2026, 8 p.m. | `v0.1.0-rc.1` |
| Browser ledger and closure history | 20 November 2026, 8 p.m. | `v0.2.0-rc.2` |
| Case study and application materials | 27 November 2026, 8 p.m. | [Case study](case-study.md) and [pilot brief](pilot.md) |

These are the checkpoints from the 21-day rehearsal. If you start later, shift every checkpoint by the same number of working days; do not compress the verification to keep a date. The [10-day fast path](learning-plan.md#fast-path--closure-evidence-and-delivery-status) replaces the three checkpoints with one defense but keeps the same evidence standard.

Public project name: **RLS Rehearsal**. Use `rls-rehearsal` as the GitHub repository slug. The historical refs use the former TenantProof name, and their evidence stays attached to those exact commits. The current checkout keeps its existing directory, environment variable, and database identifiers for local compatibility.

For a branded v0.1, branch from the API reference and apply the name to its README and release notes. Keep the API-only scope. For v0.2, cut a candidate from the branded browser revision. Verify both candidates anew, including the upgrade drill between them.

On the ship date, validate the selected candidate from a clean checkout with the [outcome verification checklist](outcome-verification.md). Record the commit, environment, test counts, clean Compose install, CLI proof, and open limitations. v0.2 also requires the browser and rollback rehearsal. Check the public branch’s GitHub Actions run before publishing the release. Publish a status update with the exact blocker if the release gate fails.

The initial publication happened on 13 November 2026: the public repository `CVamsi27/rls-rehearsal` was created from the branded v0.2 `main`, the `main` Verify run passed, and `v0.2.0` was tagged and released. The `v0.1.0-rc.1` and `v0.2.0-rc.2` tags were pushed unchanged as historical references, so the API-only and browser snapshots remain available even though the planned separate v0.1 release was not cut. See the [v0.2.0 release](https://github.com/CVamsi27/rls-rehearsal/releases/tag/v0.2.0).

For a future release, create a candidate from the default branch, verify it from a clean checkout, push the candidate, then tag and release only after the hosted Verify run passes. Use [the changelog](../CHANGELOG.md) and the measured verification results as the release notes. The release’s source archive is the supported artifact. A clean checkout and Docker Compose are the install path.

Record whether a pilot completed the quickstart and adapted a fixture. If no independent run has happened, report external validation as pending.
