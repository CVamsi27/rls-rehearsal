import { BadRequestException } from '@nestjs/common';
import { UUID } from './config.js';

function onlyField(body: unknown, field: string): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !Object.hasOwn(body, field)) throw new BadRequestException();
  return (body as Record<string, unknown>)[field];
}

export function readTitle(body: unknown): string {
  const value = onlyField(body, 'title');
  if (typeof value !== 'string') throw new BadRequestException();
  const title = value.trim();
  if (!title.length || title.length > 120 || title.includes('\u0000') || !title.isWellFormed()) {
    throw new BadRequestException();
  }
  return title;
}

export function readClose(body: unknown): void {
  if (onlyField(body, 'status') !== 'closed') throw new BadRequestException();
}

export function readItemId(value: string): string {
  if (!UUID.test(value)) throw new BadRequestException();
  return value;
}

const errors: Record<number, readonly [string, string]> = {
  400: ['invalid_input', 'Invalid request input.'],
  401: ['unauthorized', 'A valid bearer key is required.'],
  404: ['not_found', 'Resource not found.'],
  413: ['payload_too_large', 'Request body is too large.'],
  415: ['unsupported_media_type', 'Unsupported request media type.'],
  500: ['internal_error', 'Unexpected server error.'],
  503: ['database_unavailable', 'Database is unavailable.'],
};

export function errorBody(status: number) {
  const [code, message] = errors[status] ?? errors[500]!;
  return { error: { code, message } };
}
