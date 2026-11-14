import { usage } from './help.js';
import { UsageError } from './errors.js';

export type Command = 'run' | 'doctor' | 'init' | 'help' | 'version';

export type Format = 'json' | 'md' | 'junit';

export type Options = {
  command: Command;
  configPath: string;
  databaseUrl?: string;
  adminUrl?: string;
  control: boolean;
  formats: Format[];
  outDir: string;
  allowRemote: boolean;
  allowPrivileged: boolean;
  failOnEmpty?: boolean;
  force: boolean;
};

const VALUE_FLAGS = new Set([
  '--config',
  '--database-url',
  '--admin-url',
  '--format',
  '--out',
]);

const BOOLEAN_FLAGS = new Set([
  '--control',
  '--allow-remote',
  '--allow-privileged',
  '--fail-on-empty',
  '--force',
]);

const COMMANDS = new Set(['run', 'doctor', 'init']);

function takeValue(argv: readonly string[], index: number, flag: string): [string, number] {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new UsageError(`${flag} requires a value`);
  return [value, index + 1];
}

function parseFormats(value: string): Format[] {
  const formats = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (formats.length === 0) throw new UsageError('--format requires json, md or junit');
  for (const format of formats) {
    if (format !== 'json' && format !== 'md' && format !== 'junit') {
      throw new UsageError(`Unknown report format "${format}". Use json, md or junit.`);
    }
  }
  return [...new Set(formats)] as Format[];
}

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    command: 'help',
    configPath: 'rls-rehearsal.config.json',
    control: false,
    formats: ['json', 'md'],
    outDir: '.rls-rehearsal',
    allowRemote: false,
    allowPrivileged: false,
    force: false,
  };

  let commandSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--help' || argument === '-h') {
      options.command = 'help';
      return options;
    }
    if (argument === '--version' || argument === '-v') {
      options.command = 'version';
      return options;
    }
    if (argument.startsWith('--')) {
      if (BOOLEAN_FLAGS.has(argument)) {
        if (argument === '--control') options.control = true;
        if (argument === '--allow-remote') options.allowRemote = true;
        if (argument === '--allow-privileged') options.allowPrivileged = true;
        if (argument === '--fail-on-empty') options.failOnEmpty = true;
        if (argument === '--force') options.force = true;
        continue;
      }
      if (VALUE_FLAGS.has(argument)) {
        const [value, next] = takeValue(argv, index, argument);
        if (argument === '--config') options.configPath = value;
        if (argument === '--database-url') options.databaseUrl = value;
        if (argument === '--admin-url') options.adminUrl = value;
        if (argument === '--out') options.outDir = value;
        if (argument === '--format') options.formats = parseFormats(value);
        index = next;
        continue;
      }
      throw new UsageError(`Unknown option ${argument}\n\n${usage()}`);
    }
    if (COMMANDS.has(argument)) {
      if (commandSeen) throw new UsageError(`Unexpected command "${argument}"`);
      if (options.command !== 'help') throw new UsageError(`Unexpected command "${argument}"`);
      options.command = argument as Command;
      commandSeen = true;
      continue;
    }
    throw new UsageError(`Unknown command or argument "${argument}"\n\n${usage()}`);
  }

  return options;
}
