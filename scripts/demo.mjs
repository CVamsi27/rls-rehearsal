import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const [atlas, beacon] = JSON.parse(readFileSync(new URL('../examples/workspaces.json', import.meta.url), 'utf8'));
const base = process.env.DEMO_URL ?? 'http://127.0.0.1:3100';
const url = new URL(base);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash) throw new Error('DEMO_URL must be a loopback HTTP origin');

async function call(team, path, expectedStatus, method = 'GET', body) {
  const response = await fetch(new URL('/v1/items' + path, url), {
    method,
    headers: { authorization: 'Bearer ' + team.key, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, expectedStatus, method + ' ' + path);
  return response.json();
}

const a = await call(atlas, '', 201, 'POST', { title: 'Atlas brief ' + randomUUID().slice(0, 8) });
const b = await call(beacon, '', 201, 'POST', { title: 'Beacon checklist ' + randomUUID().slice(0, 8) });
assert.equal(a.status, 'open');
for (const [team, own, foreign] of [[atlas, a, b], [beacon, b, a]]) {
  const items = await call(team, '', 200);
  assert.ok(items.some((item) => item.id === own.id));
  assert.ok(items.every((item) => item.id !== foreign.id));
}
console.log('PASS: Both teams created an item and their lists stayed separate.');

const path = '/' + a.id;
const foreign = await call(beacon, path, 404);
assert.deepEqual(foreign, await call(beacon, '/' + randomUUID(), 404));
await call(beacon, path, 404, 'PATCH', { status: 'closed' });
assert.equal((await call(atlas, path, 200)).status, 'open');
console.log('PASS: Beacon received 404 for Atlas’s known ID. The foreign close changed nothing.');

assert.equal((await call(atlas, path, 200, 'PATCH', { status: 'closed' })).status, 'closed');
assert.equal((await call(atlas, path, 200, 'PATCH', { status: 'closed' })).status, 'closed');
console.log('PASS: Atlas closed its own item and safely repeated the request.');
