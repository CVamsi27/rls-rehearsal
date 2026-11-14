export class ConfigError extends Error {
  readonly details: string[];

  constructor(details: string | string[]) {
    const list = Array.isArray(details) ? details : [details];
    super(list.join('\n'));
    this.name = 'ConfigError';
    this.details = list;
  }
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export class UnsafeTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeTargetError';
  }
}

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }
}
