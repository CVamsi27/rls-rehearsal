# Release handoff

| Milestone | Planned date and time (IST) | Local source |
| --- | --- | --- |
| Public API and isolation proof | 13 November 2026, 8 p.m. | `v0.1.0-rc.1` |
| Browser ledger and closure history | 20 November 2026, 8 p.m. | `v0.2.0-rc.2` |
| Case study and application materials | 27 November 2026, 8 p.m. | [Case study](case-study.md) and [pilot brief](pilot.md) |

On the ship date, validate the selected candidate from a clean checkout. Record the commit, environment, test counts, clean Compose install, CLI proof, and open limitations. v0.2 also requires the browser and rollback rehearsal. Check the public branch’s GitHub Actions run before publishing the release. Publish a status update with the exact blocker if the release gate fails.

For the first release, create the public GitHub repository and configure its remote. Push the **candidate commit** to the remote default branch. This keeps the v0.2 code local until its ship date. Then tag that same commit `v0.1.0`, push the tag, and create the GitHub release. Repeat with the v0.2 candidate and `v0.2.0`. Use [the changelog](../CHANGELOG.md) and the measured verification results as the release notes. The release’s source archive is the supported artifact. A clean checkout and Docker Compose are the install path.

Record whether a pilot completed the quickstart and adapted a fixture. If no independent run has happened, report external validation as pending.
