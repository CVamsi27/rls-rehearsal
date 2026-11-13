# RLS Rehearsal

A small NestJS and PostgreSQL starter with an executable answer to a SaaS question. **What happens when an application query forgets the workspace filter?**

Two synthetic teams manage work items in the same tables. PostgreSQL row level security (RLS) isolates the rows. A test then removes RLS in a separate disposable database and uses the exact same assertion to demonstrate a leak.

## Run the work-item ledger

You need Docker with Compose. From the project directory:

```sh
docker compose up -d --build --wait
```

Open [the ledger](http://127.0.0.1:3100) and paste either key from [the synthetic workspace fixture](examples/workspaces.json). Create an item, close it, and select **History**. Select **Switch workspace** to try the other key.

## Run the two-minute proof

Install Node 24 using the version in `.node-version`, then run these commands from the same checkout.

```sh
npm run demo
npm ci --ignore-scripts
npm run build
npm run test:control
```

The demo creates one item per team, checks each list, tries a foreign read and close with the known item ID, and repeats a valid close. The broken control starts its own PostgreSQL container and reports that it detected another workspace’s seeded row. Both commands exit nonzero on an unexpected result.

The Compose profile uses public synthetic credentials and binds the app to loopback. Set `APP_PORT` and the matching `DEMO_URL` if port 3100 is in use. `docker compose down` stops it and preserves the local volume. Add `--volumes` to discard the demo data.

## Learn by rebuilding it

The [learning sprint](docs/learning-plan.md) pairs short prerequisite readings with build exercises, failure drills, and senior review questions. It offers a 21-day full rehearsal and a 10-day fast path that adds one closure-evidence slice and ends in a defense. Use the [outcome checklist](docs/outcome-verification.md) to verify each release and record what the evidence supports.

## Use and extend it

- [API examples](docs/api.md) cover bearer keys, payloads, and response codes.
- [Architecture and decisions](docs/design.md) explain the trust boundary, tradeoffs, and extension recipe.
- [Operations and rollback](docs/operations.md) covers install checks, recovery, and the release rehearsal.
- [Security reporting](SECURITY.md) describes the supported threat model and how to report a suspected leak.

Run `npx --no-install playwright install chromium` after installing dependencies. Then run `npm run verify` for lint, type checking, the build, unit tests, and browser, database, and HTTP tests against disposable PostgreSQL. The database suite requires Docker and fails if it cannot run. The local Compose profile is designed for development and synthetic demos.
