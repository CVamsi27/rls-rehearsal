CREATE TABLE tenantproof.items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE INDEX items_workspace_latest
  ON tenantproof.items (workspace_id, created_at DESC, id DESC);

ALTER TABLE tenantproof.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenantproof.items FORCE ROW LEVEL SECURITY;

CREATE POLICY items_workspace ON tenantproof.items FOR ALL TO tenantproof_runtime
  USING (workspace_id = NULLIF(current_setting('tenantproof.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('tenantproof.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT (workspace_id, title), UPDATE (status)
  ON tenantproof.items TO tenantproof_runtime;
