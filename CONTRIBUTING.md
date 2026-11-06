# Contributing

Use the Node version in `.node-version` and Docker with Compose. Run:

```sh
npm ci --ignore-scripts
npx --no-install playwright install chromium
npm run verify
```

A change to tenant access should include the expected success case, the foreign-workspace case, and a test that demonstrates the intended regression. Keep real database assertions under the restricted runtime role. Extend the schema through a new migration and keep previous migrations immutable.

For pull requests, state the user-visible behavior, how you verified it, the migration or rollback impact, and any limits a reviewer should know. Keep all examples synthetic.
