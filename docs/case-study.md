# A tenant isolation test that can fail

A multi-tenant request can start a transaction, bind its workspace, and then accidentally issue a query through another pooled connection. The second connection never received the scope. The motivating lesson came from maintaining a healthcare application. This example uses a fresh schema and synthetic workspaces.

TenantProof uses a restricted database role and passes one checked-out connection through every scoped operation. The app queries also include the workspace predicate. The database tests remove that predicate and assert directly on the rows PostgreSQL returns. An unscoped read returns zero rows, and the same pooled connection can safely handle the next workspace after commit or rollback.

The important control seeds an Atlas row and a Beacon row, proves both exist, and runs one unfiltered-read assertion. With RLS enabled Atlas sees its own row. Disabling RLS in a disposable fixture changes the exact same result to two rows, and the assertion detects the leak. The running app never touches the broken fixture.

Closure history adds a second invariant. Two HTTP close requests wait on the same PostgreSQL row lock. Releasing the lock lets both requests complete, but only the one that changes the status inserts an event. A test forces that insert to fail and proves the item remains open. The schema also rejects an activity row that names an existing item from a different workspace.

The rollout keeps the old API running while an additive migration introduces history. During rollback the previous image can still close work items. It cannot record events, so any closures during that window have an empty history on re-upgrade.

**Demo outline.** Start with two sample keys and two different lists. Guess the other team’s known item ID and show the 404. Close the item with the correct key and show its history. End by running the broken control.

**Portfolio evidence.** Describe your actual contribution and link the tagged source and verification. An accurate project description is: “TenantProof demonstrates PostgreSQL tenant isolation under pooled connections and tests that concurrent close requests write one closure event.” Practice explaining the trust placed in the runtime database credential, the migration tradeoff, and the remaining gap during rollback.
