import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from './args.js';
import { initConfigTemplate, loadConfig, resolveActors, DEFAULT_TIMEOUT_MS } from './config.js';
import { ConfigError, PreflightError, UnsafeTargetError, UsageError } from './errors.js';
import { usage, NAME } from './help.js';
import { doctor, runIsolation, type RunOptions } from './runner.js';
import { checkDetail, controlDetail, matrixDetail, targetLine, writeReports } from './report.js';
import type { Report } from './types.js';
import { VERSION } from './version.js';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
function paint(code: number, text: string): string {
  return color ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function ok(text: string): string {
  return paint(32, text);
}
function bad(text: string): string {
  return paint(31, text);
}
function warn(text: string): string {
  return paint(33, text);
}
function dim(text: string): string {
  return paint(90, text);
}

function rowLine(tag: string, text: string, detail: string, tagPaint: (value: string) => string): string {
  const plain = `  ${tag}  ${text}`;
  const gap = ' '.repeat(Math.max(2, 50 - plain.length));
  return `  ${tagPaint(tag)}  ${text}${gap}${detail}`;
}

function printReport(report: Report, written: string[]): void {
  console.log(`${NAME} ${report.tool.version}`);
  console.log(`target   ${targetLine(report.target)}`);
  console.log(`config   ${report.config}`);
  console.log('');

  console.log('matrix');
  for (const row of report.matrix) {
    const label = row.status === 'pass' ? 'PASS' : 'FAIL';
    console.log(
      rowLine(
        label,
        `${row.actor}/${row.resource}`,
        `${row.ownRows} own · ${row.foreignRows} foreign · ${row.visibleRows} visible`,
        row.status === 'pass' ? ok : bad,
      ),
    );
    if (row.status === 'fail') console.log(`        ${bad(matrixDetail(row))}`);
  }

  if (report.checks.length > 0) {
    console.log('');
    console.log('checks');
    for (const row of report.checks) {
      const label = row.status === 'pass' ? 'PASS' : 'FAIL';
      console.log(
        rowLine(
          label,
          row.name,
          `${row.kind} · ${checkDetail(row)}`,
          row.status === 'pass' ? ok : bad,
        ),
      );
    }
  }

  if (report.mode.control) {
    console.log('');
    console.log('control (RLS disabled as a privileged role)');
    for (const row of report.control) {
      const label =
        row.status === 'leaked'
          ? 'LEAK'
          : row.status === 'skipped'
            ? 'SKIP'
            : 'FAIL';
      console.log(
        rowLine(
          label,
          `${row.actor}/${row.resource}`,
          controlDetail(row),
          row.status === 'leaked' ? ok : row.status === 'skipped' ? warn : bad,
        ),
      );
      if (row.coverageGap > 0) {
        console.log(`        ${warn(`coverage gap: ${row.coverageGap} own row(s) hidden from the actor`)}`);
      }
    }
  }

  const notes = report.preflight.filter((note) => note.level === 'warning');
  if (notes.length > 0) {
    console.log('');
    console.log('warnings');
    for (const note of notes) console.log(`  ${warn('WARN')}  ${note.message}`);
  }

  const { summary } = report;
  const summaryText =
    `${summary.passed} passed · ${summary.failed} failed · ${summary.skipped} skipped · ` +
    `${summary.warnings} warning${summary.warnings === 1 ? '' : 's'} · ${summary.leaks} leaked`;
  console.log('');
  console.log(`summary  ${summary.failed > 0 ? bad(summaryText) : ok(summaryText)}`);
  if (written.length > 0) console.log(dim(`report   ${written.join(', ')}`));
}

async function commandRun(options: ReturnType<typeof parseArgs>): Promise<number> {
  const config = await loadConfig(options.configPath);
  const actors = resolveActors(config, process.env);
  const runOptions: RunOptions = {
    config,
    configPath: options.configPath,
    actors,
    env: process.env,
    control: options.control,
    allowRemote: options.allowRemote,
    allowPrivileged: options.allowPrivileged,
    timeoutMs: config.defaults?.statementTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    version: VERSION,
  };
  if (options.databaseUrl) runOptions.databaseUrl = options.databaseUrl;
  if (options.adminUrl) runOptions.adminUrl = options.adminUrl;
  if (options.failOnEmpty !== undefined) runOptions.failOnEmpty = options.failOnEmpty;

  const report = await runIsolation(runOptions);
  const written = await writeReports(report, options.formats, options.outDir);
  printReport(report, written);
  return report.summary.exitCode;
}

async function commandDoctor(options: ReturnType<typeof parseArgs>): Promise<number> {
  const config = await loadConfig(options.configPath);
  const actors = resolveActors(config, process.env);
  const runOptions: RunOptions = {
    config,
    configPath: options.configPath,
    actors,
    env: process.env,
    control: false,
    allowRemote: options.allowRemote,
    allowPrivileged: options.allowPrivileged,
    timeoutMs: config.defaults?.statementTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    version: VERSION,
  };
  if (options.databaseUrl) runOptions.databaseUrl = options.databaseUrl;

  const result = await doctor(runOptions);
  console.log(`${NAME} doctor ${VERSION}`);
  console.log(`target   ${targetLine(result.target)}`);
  console.log(`config   ${options.configPath}`);
  console.log('');
  for (const check of result.checks) {
    const label =
      check.level === 'ok' ? ok('ok') : check.level === 'warning' ? warn('warn') : bad('error');
    console.log(`  [${label}] ${check.message}`);
  }
  console.log('');
  console.log(
    result.errors > 0
      ? bad(`doctor: ${result.errors} error(s), ${result.warnings} warning(s)`)
      : ok(`doctor: ready (${result.warnings} warning(s))`),
  );
  return result.errors > 0 ? 1 : 0;
}

async function commandInit(options: ReturnType<typeof parseArgs>): Promise<number> {
  const template = initConfigTemplate();
  await mkdir(dirname(options.configPath), { recursive: true });
  try {
    await writeFile(options.configPath, `${JSON.stringify(template, null, 2)}\n`, {
      encoding: 'utf8',
      flag: options.force ? 'w' : 'wx',
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new UsageError(`${options.configPath} already exists. Pass --force to overwrite it.`);
    }
    throw error;
  }
  console.log(`Wrote ${options.configPath}`);
  console.log('');
  console.log('Next:');
  console.log(`  1. Set RLS_REHEARSAL_DATABASE_URL to a restricted role with SELECT, INSERT, UPDATE and DELETE.`);
  console.log(`  2. Seed at least one row for each actor's tenant, then run: ${NAME} doctor`);
  console.log(`  3. Run the matrix and checks: ${NAME} run`);
  console.log(`  4. Prove the checks can fail: ${NAME} run --control --admin-url <disposable-admin-url>`);
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }

  if (options.command === 'help') {
    console.log(`${NAME} ${VERSION}\n\n${usage()}`);
    return 0;
  }
  if (options.command === 'version') {
    console.log(`${NAME} ${VERSION}`);
    return 0;
  }
  if (options.command === 'init') return commandInit(options);
  if (options.command === 'doctor') return commandDoctor(options);
  return commandRun(options);
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof UnsafeTargetError) {
        console.error(bad(`unsafe target: ${error.message}`));
        process.exitCode = 3;
        return;
      }
      if (error instanceof ConfigError) {
        console.error(bad('configuration error:'));
        for (const detail of error.details) console.error(`  - ${detail}`);
        process.exitCode = 2;
        return;
      }
      if (error instanceof PreflightError) {
        console.error(bad('setup error:'));
        for (const line of error.message.split('\n')) console.error(`  - ${line}`);
        process.exitCode = 2;
        return;
      }
      if (error instanceof UsageError) {
        console.error(error.message);
        process.exitCode = 2;
        return;
      }
      console.error(bad(error instanceof Error ? error.message : String(error)));
      if (process.env.RLS_REHEARSAL_DEBUG === '1' && error instanceof Error && error.stack) {
        console.error(error.stack);
      }
      process.exitCode = 2;
    });
}
