import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{32,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function digest(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function loadKeys(env: NodeJS.ProcessEnv): ReadonlyMap<string, string> {
  if (env.TENANTPROOF_DEMO === '1') {
    if (env.TENANTPROOF_KEYS) throw new Error('TENANTPROOF_KEYS cannot be set in demo mode');
    const fixtures = JSON.parse(readFileSync(join(import.meta.dirname, '../examples/workspaces.json'), 'utf8')) as
      { key: string; workspaceId: string }[];
    return new Map(fixtures.map(({ key, workspaceId }) => [digest(key), workspaceId]));
  }

  const invalid = () => new Error('TENANTPROOF_KEYS must map SHA-256 hex digests to workspace UUIDs');
  let input: unknown;
  try {
    input = JSON.parse(env.TENANTPROOF_KEYS ?? '');
  } catch {
    throw invalid();
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalid();

  const result = new Map<string, string>();
  for (const [hash, workspace] of Object.entries(input)) {
    if (!DIGEST.test(hash) || typeof workspace !== 'string' || !UUID.test(workspace)) throw invalid();
    result.set(hash, workspace.toLowerCase());
  }
  if (!result.size) throw invalid();
  return result;
}

export function resolveWorkspace(keys: ReadonlyMap<string, string>, authorization?: string): string | undefined {
  const key = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(authorization ?? '')?.[1];
  return key && KEY.test(key) ? keys.get(digest(key)) : undefined;
}
