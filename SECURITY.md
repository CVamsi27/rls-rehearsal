# Security

TenantProof demonstrates protection against callers forging tenant scope, guessing another team's item ID, and queries that lose their tenant context. Tenant scope depends on trusted application code and the configured database policy. Someone with the runtime database credential and arbitrary SQL can choose the session's workspace value. Keep database credentials private and keep untrusted input out of SQL strings.

Compose is a loopback demo with synthetic credentials. For an adaptation, provision a dedicated database, isolated owner and runtime credentials, private network access, and HTTPS termination. Generate each bearer key with at least 32 random bytes and store a mapping of lowercase SHA-256 hex digests to workspace UUIDs in `TENANTPROOF_KEYS`. Inject `DATABASE_URL` into the application and `MIGRATION_DATABASE_URL` into the migration process only. Leave `TENANTPROOF_DEMO` unset in that environment.

To report a possible leak, use GitHub private vulnerability reporting when available. Include the candidate version, a minimal synthetic reproduction, and the observed and expected result.
