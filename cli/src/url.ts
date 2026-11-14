import { UnsafeTargetError } from './errors.js';
import type { ReportTarget } from './types.js';

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    if (url.username) url.username = url.username;
    return url.toString();
  } catch {
    return '<unparseable connection string>';
  }
}

export function targetFromUrl(raw: string): ReportTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeTargetError('The connection string must be a postgres:// or postgresql:// URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new UnsafeTargetError('The connection string must use postgres:// or postgresql://');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return {
    host,
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
    user: decodeURIComponent(url.username) || 'unknown',
    redacted: redactUrl(raw),
  };
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === '' || normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function assertRemoteAllowed(raw: string, allowRemote: boolean): ReportTarget {
  const target = targetFromUrl(raw);
  if (!isLoopbackHost(target.host) && !allowRemote) {
    throw new UnsafeTargetError(
      `Refusing to test ${target.host}:${target.port}. ` +
        'Pass --allow-remote only after confirming the database is disposable, or point at a local checkout.',
    );
  }
  return target;
}
