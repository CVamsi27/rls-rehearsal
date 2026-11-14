const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

async function api() {
  return import('../dist/index.js');
}

function baseReport(overrides = {}) {
  return {
    tool: { name: 'rls-rehearsal', version: '0.3.0' },
    config: 'rls-rehearsal.config.json',
    target: {
      host: '127.0.0.1',
      port: '5432',
      database: 'app',
      user: 'runtime',
      redacted: 'postgres://runtime:***@127.0.0.1:5432/app',
    },
    mode: { control: true, failOnEmpty: true, allowRemote: false, allowPrivileged: false },
    preflight: [],
    matrix: [
      {
        actor: 'atlas',
        resource: 'items',
        table: 'items',
        status: 'pass',
        visibleRows: 3,
        foreignRows: 0,
        ownRows: 3,
        minRows: 1,
        empty: false,
        leakedSample: [],
        durationMs: 4,
      },
      {
        actor: 'beacon',
        resource: 'items',
        table: 'items',
        status: 'fail',
        visibleRows: 4,
        foreignRows: 2,
        ownRows: 2,
        minRows: 1,
        empty: false,
        leakedSample: [{ __rls_id_0: 'id-1' }],
        durationMs: 6,
        reason: 'Tenant beacon can see 2 row(s) from other tenants',
      },
    ],
    checks: [
      {
        name: 'foreign row hidden',
        actor: 'atlas',
        kind: 'read',
        status: 'pass',
        durationMs: 2,
        rowCount: 0,
      },
      {
        name: 'foreign insert denied',
        actor: 'atlas',
        kind: 'write',
        status: 'fail',
        durationMs: 3,
        rowCount: null,
        sqlstate: '42501',
        reason: 'Expected an RLS denial, got a privilege denial',
      },
    ],
    control: [
      {
        actor: 'atlas',
        resource: 'items',
        status: 'leaked',
        foreignRows: 2,
        leakedRows: 2,
        ownRowsVisible: 1,
        ownRowsActual: 1,
        coverageGap: 0,
        durationMs: 5,
      },
      {
        actor: 'beacon',
        resource: 'items',
        status: 'skipped',
        foreignRows: 0,
        leakedRows: 0,
        ownRowsVisible: 1,
        ownRowsActual: 1,
        coverageGap: 0,
        durationMs: 1,
        reason: 'No foreign rows exist',
      },
    ],
    ...overrides,
  };
}

test('summarize counts failures, skips and leaks', async () => {
  const { summarize } = await api();
  const report = summarize(baseReport(), Date.now() - 25);
  assert.equal(report.summary.total, 6);
  assert.equal(report.summary.failed, 2);
  assert.equal(report.summary.skipped, 1);
  assert.equal(report.summary.leaks, 2);
  assert.equal(report.summary.exitCode, 1);
  assert.match(report.startedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('markdown escapes pipes and reports failure reasons', async () => {
  const { summarize, renderMarkdown } = await api();
  const report = summarize(baseReport(), Date.now());
  const markdown = renderMarkdown(report);
  assert.match(markdown, /RLS isolation report/);
  assert.match(markdown, /\| FAIL \| beacon \| items \|/);
  assert.match(markdown, /foreign insert denied/);
  assert.match(markdown, /## Control mode/);
  assert.match(markdown, /does not prove every policy/);
});

test('JUnit escapes XML and marks skips', async () => {
  const { summarize, renderJUnit } = await api();
  const report = summarize(
    baseReport({
      checks: [
        {
          name: 'a < b & "quoted"',
          actor: 'atlas',
          kind: 'read',
          status: 'fail',
          durationMs: 1,
          rowCount: 0,
          reason: 'expected <value> & more',
        },
      ],
    }),
    Date.now(),
  );
  const xml = renderJUnit(report);
  assert.match(xml, /<testsuites/);
  assert.match(xml, /a &lt; b &amp; &quot;quoted&quot;/);
  assert.match(xml, /<skipped message="No foreign rows exist" \/>/);
  assert.doesNotMatch(xml, /a < b/);
});

test('writeReports writes every requested format', async () => {
  const { summarize, writeReports } = await api();
  const report = summarize(baseReport(), Date.now());
  const out = await mkdtemp(join(tmpdir(), 'rls-report-'));
  const written = await writeReports(report, ['json', 'md', 'junit'], out);
  assert.deepEqual(
    written.map((path) => path.slice(out.length + 1)).sort(),
    ['report.json', 'report.md', 'report.xml'],
  );
  const json = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  assert.equal(json.summary.failed, 2);
  assert.match(await readFile(join(out, 'report.md'), 'utf8'), /RLS isolation report/);
  assert.match(await readFile(join(out, 'report.xml'), 'utf8'), /<testsuites/);
});
