import type { PoolClient } from 'pg';
import type { PreflightNote, ResourceConfig, ResolvedActor } from './types.js';
import { quoteIdent, roleFacts } from './db.js';

export type ResourceInspection = {
  resource: string;
  table: string;
  exists: boolean;
  rlsEnabled: boolean;
  rlsForced: boolean;
  policyCount: number;
  owner: string;
  currentUser: string;
  canSelect: boolean;
  notes: PreflightNote[];
};

function splitTable(table: string): { schema: string; name: string } {
  const [first, second] = table.split('.');
  if (second) return { schema: first!, name: second };
  return { schema: 'public', name: first! };
}

export async function inspectResource(
  client: PoolClient,
  name: string,
  resource: ResourceConfig,
  options: { doctor: boolean },
): Promise<ResourceInspection> {
  const { schema, name: tableName } = splitTable(resource.table);
  const notes: PreflightNote[] = [];
  const result = await client.query<{
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
    owner: string;
    policies: number;
  }>(`
    SELECT c.relrowsecurity,
           c.relforcerowsecurity,
           pg_get_userbyid(c.relowner)::text AS owner,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')
  `, [schema, tableName]);

  const relation = result.rows[0];
  if (!relation) {
    notes.push({
      level: 'error',
      code: 'table-missing',
      message: `Table ${resource.table} does not exist or is not a table`,
    });
    const identity = await roleFacts(client);
    return {
      resource: name,
      table: resource.table,
      exists: false,
      rlsEnabled: false,
      rlsForced: false,
      policyCount: 0,
      owner: '',
      currentUser: identity.current_user,
      canSelect: false,
      notes,
    };
  }

  const identity = await roleFacts(client);
  const privilege = await client.query<{ can_select: boolean }>(
    'SELECT has_table_privilege(current_user, $1, \'SELECT\') AS can_select',
    [`${quoteIdent(schema)}.${quoteIdent(tableName)}`],
  );
  const canSelect = privilege.rows[0]?.can_select ?? false;

  if (!relation.relrowsecurity) {
    notes.push({
      level: options.doctor ? 'error' : 'warning',
      code: 'rls-disabled',
      message: `RLS is not enabled on ${resource.table}; the matrix should report a leak`,
    });
  }
  if (!relation.relforcerowsecurity) {
    if (relation.owner === identity.current_user) {
      notes.push({
        level: 'error',
        code: 'rls-not-forced',
        message: `${resource.table} is owned by the tested role ${identity.current_user} and does not FORCE RLS, so the owner bypasses every policy`,
      });
    } else {
      notes.push({
        level: 'warning',
        code: 'rls-not-forced',
        message: `${resource.table} does not FORCE RLS; the owner ${relation.owner} bypasses policies`,
      });
    }
  }
  if (relation.policies === 0) {
    notes.push({
      level: 'warning',
      code: 'no-policies',
      message: `${resource.table} has RLS enabled but no policies; non-owner reads are denied by default`,
    });
  }
  if (!canSelect) {
    notes.push({
      level: 'error',
      code: 'select-denied',
      message: `Role ${identity.current_user} does not have SELECT on ${resource.table}`,
    });
  }

  return {
    resource: name,
    table: resource.table,
    exists: true,
    rlsEnabled: relation.relrowsecurity,
    rlsForced: relation.relforcerowsecurity,
    policyCount: relation.policies,
    owner: relation.owner,
    currentUser: identity.current_user,
    canSelect,
    notes,
  };
}

export async function inspectActorResources(
  client: PoolClient,
  actor: ResolvedActor,
  resources: Record<string, ResourceConfig>,
  options: { doctor: boolean },
): Promise<ResourceInspection[]> {
  const inspections: ResourceInspection[] = [];
  for (const [name, resource] of Object.entries(resources)) {
    inspections.push(await inspectResource(client, name, resource, options));
  }
  return inspections;
}

export function notesForActor(actor: ResolvedActor, inspections: ResourceInspection[]): PreflightNote[] {
  const notes: PreflightNote[] = [];
  for (const inspection of inspections) {
    for (const note of inspection.notes) {
      notes.push({
        ...note,
        message: `[${actor.name}/${inspection.resource}] ${note.message}`,
      });
    }
  }
  return notes;
}
