import {
  type ArgumentsHost, Body, type CanActivate, Catch, Controller, type ExecutionContext,
  type ExceptionFilter, Get, HttpException, Inject, Injectable, Param, Patch, Post, Req,
  ServiceUnavailableException, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { resolveWorkspace } from './config.js';
import { errorBody, readClose, readItemId, readTitle } from './contract.js';
import { verifyRuntime } from './database.js';
import { DB, Items } from './items.js';

export const KEYS = Symbol('keys');
type ScopedRequest = Request & { workspace: string };

@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(@Inject(KEYS) private readonly keys: ReadonlyMap<string, string>) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<ScopedRequest>();
    const workspace = resolveWorkspace(this.keys, request.headers.authorization);
    if (!workspace) throw new UnauthorizedException();
    request.workspace = workspace;
    return true;
  }
}

@Controller('v1/items')
@UseGuards(WorkspaceGuard)
export class ItemsController {
  constructor(private readonly items: Items) {}

  @Get()
  list(@Req() request: ScopedRequest) {
    return this.items.list(request.workspace);
  }

  @Get(':id')
  get(@Req() request: ScopedRequest, @Param('id') id: string) {
    return this.items.get(request.workspace, readItemId(id));
  }

  @Post()
  create(@Req() request: ScopedRequest, @Body() body: unknown) {
    return this.items.create(request.workspace, readTitle(body));
  }

  @Patch(':id')
  close(@Req() request: ScopedRequest, @Param('id') id: string, @Body() body: unknown) {
    readClose(body);
    return this.items.close(request.workspace, readItemId(id));
  }
}

@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly pool: Pool) {}

  @Get('healthz')
  health() {
    return { status: 'ok' };
  }

  @Get('readyz')
  async ready() {
    try {
      await verifyRuntime(this.pool);
    } catch {
      throw new ServiceUnavailableException();
    }
    return { status: 'ready' };
  }
}

function isUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') {
    return false;
  }
  return error.code.startsWith('08') || ['57P01', '57P02', '57P03', '57014', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']
    .includes(error.code);
}

@Catch()
export class SafeErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : isUnavailable(error) ? 503 : 500;
    const body = errorBody(status);
    response.locals.errorCode = body.error.code;
    if (status === 401) response.setHeader('WWW-Authenticate', 'Bearer');
    response.status(status).json(body);
  }
}

export function requestLog(request: Request, response: Response, next: NextFunction): void {
  const started = performance.now();
  const requestId = randomUUID();
  response.setHeader('X-Request-Id', requestId);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  response.once('finish', () => {
    const path: unknown = request.route?.path;
    console.log(JSON.stringify({
      event: 'http_request', requestId, method: request.method,
      route: typeof path === 'string' ? path : 'unmatched',
      status: response.statusCode, durationMs: Math.round(performance.now() - started),
      errorCode: response.locals.errorCode,
    }));
  });
  next();
}
