CREATE TABLE tenantproof.closure_events (
  workspace_id uuid NOT NULL,
  item_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, item_id),
  FOREIGN KEY (workspace_id, item_id) REFERENCES tenantproof.items (workspace_id, id)
);

ALTER TABLE tenantproof.closure_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenantproof.closure_events FORCE ROW LEVEL SECURITY;

CREATE POLICY closure_events_workspace ON tenantproof.closure_events FOR ALL TO tenantproof_runtime
  USING (workspace_id = NULLIF(current_setting('tenantproof.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('tenantproof.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT (workspace_id, item_id)
  ON tenantproof.closure_events TO tenantproof_runtime;
