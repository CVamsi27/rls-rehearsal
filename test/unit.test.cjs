const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { loadKeys, resolveWorkspace } = require('../dist/config.js');
const { readTitle, readClose, readItemId, errorBody } = require('../dist/contract.js');
const [atlas, beacon] = require('../examples/workspaces.json');

test('provisioned digests resolve to the corresponding fixed workspace', () => {
  const key = 'k'.repeat(43);
  const digest = createHash('sha256').update(key).digest('hex');
  const keys = loadKeys({ TENANTPROOF_KEYS: JSON.stringify({ [digest]: beacon.workspaceId }) });
  assert.equal(resolveWorkspace(keys, 'Bearer ' + key), beacon.workspaceId);
  assert.equal(resolveWorkspace(keys, 'Bearer ' + digest), undefined);
  assert.equal(resolveWorkspace(keys, 'Bearer ' + atlas.key), undefined);
  assert.equal(resolveWorkspace(keys, undefined), undefined);
});

test('demo keys require explicit configuration and cannot be mixed with operator keys', () => {
  assert.throws(() => loadKeys({}), /TENANTPROOF_KEYS/);
  assert.throws(() => loadKeys({ TENANTPROOF_KEYS: '{"plain":"fake"}' }), /TENANTPROOF_KEYS/);
  assert.throws(() => loadKeys({ TENANTPROOF_DEMO: '1', TENANTPROOF_KEYS: '{}' }), /TENANTPROOF_KEYS/);
  assert.equal(resolveWorkspace(loadKeys({ TENANTPROOF_DEMO: '1' }), 'bearer ' + atlas.key), atlas.workspaceId);
});

test('create and close reject fields owned by the server', () => {
  assert.equal(readTitle({ title: '  Draft brief  ' }), 'Draft brief');
  assert.throws(() => readTitle({ title: '   ' }));
  assert.throws(() => readTitle({ title: 'x'.repeat(121) }));
  assert.throws(() => readTitle({ title: 'a\u0000b' }));
  assert.throws(() => readTitle({ title: 'Draft', workspaceId: beacon.workspaceId }));
  assert.doesNotThrow(() => readClose({ status: 'closed' }));
  assert.throws(() => readClose({ status: 'open' }));
  assert.throws(() => readClose({ status: 'closed', id: 'forged' }));
  assert.throws(() => readItemId('not-a-uuid'));
});

test('errors have stable codes and hide internal details', () => {
  assert.deepEqual(errorBody(404), { error: { code: 'not_found', message: 'Resource not found.' } });
  assert.deepEqual(errorBody(500), { error: { code: 'internal_error', message: 'Unexpected server error.' } });
});
