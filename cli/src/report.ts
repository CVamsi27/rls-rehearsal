import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Format } from './args.js';
import type { CheckResult, ControlResult, MatrixResult, Report, ReportTarget } from './types.js';

const PASS = 'PASS';
const FAIL = 'FAIL';

export function statusLabel(status: string): string {
  if (status === 'pass' || status === 'leaked') return PASS;
  if (status === 'skipped') return 'SKIP';
  if (status === 'not-leaked' || status === 'fail' || status === 'error') return FAIL;
  return status.toUpperCase();
}

export function summarize(
  report: Omit<Report, 'summary' | 'startedAt' | 'finishedAt' | 'durationMs'>,
  startedAt: number,
): Report {
  const matrixFailed = report.matrix.filter((row) => row.status === 'fail').length;
  const checksFailed = report.checks.filter((row) => row.status === 'fail').length;
  const controlFailed = report.control.filter((row) => row.status === 'not-leaked' || row.status === 'error').length;
  const controlSkipped = report.control.filter((row) => row.status === 'skipped').length;
  const preflightWarnings = report.preflight.filter((note) => note.level === 'warning').length;
  const coverageWarnings = report.control.filter((row) => row.coverageGap > 0).length;
  const failed = matrixFailed + checksFailed + controlFailed;
  const skipped = controlSkipped;
  const total = report.matrix.length + report.checks.length + report.control.length;
  const finishedAt = new Date();
  const summary = {
    total,
    passed: total - failed - skipped,
    failed,
    skipped,
    warnings: preflightWarnings + coverageWarnings,
    leaks: report.matrix.reduce((sum, row) => sum + row.foreignRows, 0),
    exitCode: failed > 0 ? 1 : 0,
  };
  return {
    ...report,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt,
    summary,
  };
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function truncate(value: string, length = 120): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

export function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push('# RLS isolation report');
  lines.push('');
  lines.push(`- Tool: \`${report.tool.name}@${report.tool.version}\``);
  lines.push(`- Target: \`${report.target.redacted}\``);
  lines.push(`- Config: \`${report.config}\``);
  lines.push(`- Started: ${report.startedAt}`);
  lines.push(`- Duration: ${report.durationMs} ms`);
  lines.push(`- Control mode: ${report.mode.control ? 'on' : 'off'}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Result | Count |');
  lines.push('| --- | ---: |');
  lines.push(`| Passed | ${report.summary.passed} |`);
  lines.push(`| Failed | ${report.summary.failed} |`);
  lines.push(`| Skipped | ${report.summary.skipped} |`);
  lines.push(`| Warnings | ${report.summary.warnings} |`);
  lines.push(`| Leaked rows | ${report.summary.leaks} |`);
  lines.push(`| Exit code | ${report.summary.exitCode} |`);
  lines.push('');

  lines.push('## Matrix');
  lines.push('');
  lines.push('| Result | Actor | Resource | Visible | Own | Foreign | Min rows |');
  lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: |');
  for (const row of report.matrix) {
    lines.push(
      `| ${statusLabel(row.status)} | ${markdownCell(row.actor)} | ${markdownCell(row.resource)} | ` +
        `${row.visibleRows} | ${row.ownRows} | ${row.foreignRows} | ${row.minRows} |`,
    );
  }
  if (report.matrix.some((row) => row.reason)) {
    lines.push('');
    for (const row of report.matrix.filter((row) => row.reason)) {
      lines.push(`- **${markdownCell(row.actor)}/${markdownCell(row.resource)}**: ${markdownCell(row.reason!)}`);
      if (row.leakedSample.length > 0) {
        lines.push(`  - Sample: \`${markdownCell(JSON.stringify(row.leakedSample))}\``);
      }
    }
  }
  lines.push('');

  if (report.checks.length > 0) {
    lines.push('## Explicit checks');
    lines.push('');
    lines.push('| Result | Check | Actor | Kind | Rows | SQLSTATE |');
    lines.push('| --- | --- | --- | --- | ---: | --- |');
    for (const row of report.checks) {
      lines.push(
        `| ${statusLabel(row.status)} | ${markdownCell(row.name)} | ${markdownCell(row.actor)} | ${row.kind} | ` +
          `${row.rowCount ?? '—'} | ${row.sqlstate ?? '—'} |`,
      );
    }
    const reasons = report.checks.filter((row) => row.reason);
    if (reasons.length > 0) {
      lines.push('');
      for (const row of reasons) {
        lines.push(`- **${markdownCell(row.name)}**: ${markdownCell(row.reason!)}`);
      }
    }
    lines.push('');
  }

  if (report.mode.control) {
    lines.push('## Control mode');
    lines.push('');
    lines.push('| Result | Actor | Resource | Foreign rows | Leaked | Visible own | Actual own | Coverage gap |');
    lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |');
    for (const row of report.control) {
      lines.push(
        `| ${statusLabel(row.status)} | ${markdownCell(row.actor)} | ${markdownCell(row.resource)} | ` +
          `${row.foreignRows} | ${row.leakedRows} | ${row.ownRowsVisible} | ${row.ownRowsActual} | ${row.coverageGap} |`,
      );
    }
    const reasons = report.control.filter((row) => row.reason);
    if (reasons.length > 0) {
      lines.push('');
      for (const row of reasons) {
        lines.push(`- **${markdownCell(row.actor)}/${markdownCell(row.resource)}**: ${markdownCell(row.reason!)}`);
      }
    }
    lines.push('');
  }

  if (report.preflight.length > 0) {
    lines.push('## Preflight notes');
    lines.push('');
    for (const note of report.preflight) {
      lines.push(`- **${note.level.toUpperCase()}** (${note.code}): ${markdownCell(note.message)}`);
    }
    lines.push('');
  }

  lines.push('## What this run supports');
  lines.push('');
  lines.push(
    'A passing run shows that the configured roles, claims and settings could not read or write rows outside ' +
      'their tenant for the sampled tables and checks. Control mode shows the same assertion fails when RLS is ' +
      'disabled. It does not prove every policy is correct, protect against a BYPASSRLS role, or replace ' +
      'application authorization and audit.',
  );
  lines.push('');
  return lines.join('\n');
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function testCase(
  classname: string,
  name: string,
  durationMs: number,
  failure?: string,
  skipped?: string,
): string {
  const attributes = `classname="${xml(classname)}" name="${xml(name)}" time="${seconds(durationMs)}"`;
  if (skipped) {
    return `    <testcase ${attributes}>\n      <skipped message="${xml(skipped)}" />\n    </testcase>`;
  }
  if (failure) {
    return `    <testcase ${attributes}>\n      <failure message="${xml(failure)}">${xml(failure)}</failure>\n    </testcase>`;
  }
  return `    <testcase ${attributes} />`;
}

export function renderJUnit(report: Report): string {
  const cases: string[] = [];
  for (const row of report.matrix) {
    const failure = row.status === 'fail' ? row.reason ?? 'Tenant isolation failed' : undefined;
    cases.push(testCase(`matrix.${row.actor}`, row.resource, row.durationMs, failure));
  }
  for (const row of report.checks) {
    const failure = row.status === 'fail' ? row.reason ?? 'Check failed' : undefined;
    cases.push(testCase(`checks.${row.actor}`, row.name, row.durationMs, failure));
  }
  for (const row of report.control) {
    const failure = row.status === 'not-leaked' || row.status === 'error' ? row.reason ?? 'Control failed' : undefined;
    const skipped = row.status === 'skipped' ? row.reason ?? 'No foreign rows to leak' : undefined;
    cases.push(testCase(`control.${row.actor}`, row.resource, row.durationMs, failure, skipped));
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="rls-rehearsal" tests="${cases.length}" failures="${report.summary.failed}" ` +
      `skipped="${report.summary.skipped}" time="${seconds(report.durationMs)}">`,
    `  <testsuite name="rls-rehearsal" tests="${cases.length}" failures="${report.summary.failed}" ` +
      `skipped="${report.summary.skipped}" time="${seconds(report.durationMs)}">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

export function reportFiles(formats: readonly Format[]): { format: Format; name: string }[] {
  return formats.map((format) => ({
    format,
    name: format === 'json' ? 'report.json' : format === 'md' ? 'report.md' : 'report.xml',
  }));
}

export async function writeReports(
  report: Report,
  formats: readonly Format[],
  outDir: string,
): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  for (const { format, name } of reportFiles(formats)) {
    const body =
      format === 'json'
        ? `${JSON.stringify(report, null, 2)}\n`
        : format === 'md'
          ? renderMarkdown(report)
          : renderJUnit(report);
    const path = join(outDir, name);
    await writeFile(path, body, 'utf8');
    written.push(path);
  }
  return written;
}

export function matrixDetail(row: MatrixResult): string {
  if (row.reason) return row.reason;
  return `${row.visibleRows} visible, ${row.ownRows} own, ${row.foreignRows} foreign`;
}

export function checkDetail(row: CheckResult): string {
  if (row.reason) return truncate(row.reason);
  return `${row.rowCount ?? 0} rows${row.sqlstate ? `, SQLSTATE ${row.sqlstate}` : ''}`;
}

export function controlDetail(row: ControlResult): string {
  if (row.reason) return truncate(row.reason);
  return `${row.leakedRows} leaked of ${row.foreignRows} foreign rows`;
}

export function targetLine(target: ReportTarget): string {
  return `${target.host}:${target.port}/${target.database} as ${target.user}`;
}
