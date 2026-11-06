# TenantProof

A small NestJS and PostgreSQL starter with an executable answer to a SaaS question. **What happens when an application query forgets the workspace filter?**

Two synthetic teams manage work items in the same tables. PostgreSQL row level security (RLS) isolates the rows. A test then removes RLS in a separate disposable database and uses the exact same assertion to demonstrate a leak.

## Try the two-minute proof

You need Docker with Compose and Node 24 (see `.node-version`). From the project directory:

```sh
docker compose up -d --build --wait
npm run demo
npm ci --ignore-scripts
npm run build
npm run test:control
```

The demo creates one item per team, checks each list, tries a foreign read and close with the known item ID, and repeats a valid close. The broken control starts its own PostgreSQL container and prints the unexpected Beacon row it detected in Atlas’s result. Both commands exit nonzero on an unexpected result.

The API is at `http://127.0.0.1:3100`. The Compose profile uses public synthetic credentials and binds the app to loopback. Set `APP_PORT` and the matching `DEMO_URL` if port 3100 is in use. `docker compose down` stops it and preserves the local volume. Add `--volumes` to discard the demo data.

## Use and extend it

- [API examples](docs/api.md) cover bearer keys, payloads, and response codes.
- [Architecture and decisions](docs/design.md) explain the trust boundary, tradeoffs, and extension recipe.
- [Security reporting](SECURITY.md) describes the supported threat model and how to report a suspected leak.

Run `npm run verify` for lint, type checking, unit tests, and database and HTTP tests against disposable PostgreSQL. The database suite requires Docker and fails if it cannot run. The local Compose profile is designed for development and synthetic demos.
