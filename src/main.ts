import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AddressInfo } from 'node:net';
import { loadKeys } from './config.js';
import { runtimePool, UnsafeDatabaseError, verifyRuntime } from './database.js';
import { HealthController, ItemsController, KEYS, SafeErrors, WorkspaceGuard, requestLog } from './http.js';
import { DB, Items } from './items.js';

@Module({})
class AppModule {}

async function main(): Promise<void> {
  const keys = loadKeys(process.env);
  const url = process.env.DATABASE_URL;
  const port = Number(process.env.PORT ?? '3000');
  const host = process.env.LISTEN_HOST ?? '127.0.0.1';
  if (!url || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid server configuration');

  const pool = runtimePool(url);
  try {
    await verifyRuntime(pool);
    const app = await NestFactory.create<NestExpressApplication>({
      module: AppModule,
      controllers: [ItemsController, HealthController],
      providers: [
        Items, WorkspaceGuard,
        { provide: DB, useValue: pool },
        { provide: KEYS, useValue: keys },
        { provide: 'poolShutdown', useValue: { onApplicationShutdown: () => pool.end() } },
      ],
    }, { logger: false, abortOnError: false, bodyParser: false });
    app.use(requestLog);
    app.useBodyParser('json', { limit: '8kb' });
    app.useGlobalFilters(new SafeErrors());
    app.enableShutdownHooks(['SIGINT', 'SIGTERM']);
    await app.listen(port, host);
    const address = app.getHttpServer().address() as AddressInfo;
    console.log(JSON.stringify({ event: 'listening', port: address.port }));
  } catch (error) {
    await pool.end();
    throw error;
  }
}

void main().catch(error => {
  const code = error instanceof UnsafeDatabaseError ? 'unsafe_database_configuration' : 'startup_failed';
  console.error(JSON.stringify({ event: 'startup_failed', code }));
  process.exitCode = 1;
});
