/**
 * Writes `openapi.yaml` from the live Nest application.
 *
 * Generated rather than hand-maintained so the committed contract cannot drift from the DTOs —
 * CI regenerates it and fails on any diff. It is the stand-in for the client layer (§7): what
 * cURL, the tests and any future UI code against.
 */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dump } from 'js-yaml';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { API_PREFIX, buildOpenApiDocument } from '../src/openapi';

async function main(): Promise<void> {
  // Generation only needs the route/DTO metadata, so keep the background workers quiet and do
  // not require a reachable database.
  process.env.LOG_LEVEL = 'silent';
  process.env.OUTBOX_RELAY_ENABLED = 'false';
  process.env.REMINDER_CRON_ENABLED = 'false';
  process.env.DATABASE_URL ??= 'postgresql://localhost:5432/openapi-generation-only';

  // Nest DI needs `design:paramtypes`, which only tsc emits — esbuild (and therefore tsx) does
  // not support `emitDecoratorMetadata` at all, so this script runs against the BUILD output
  // rather than the sources. Keep the logger on: with `logger: false`, a bootstrap failure exits
  // 1 with no message at all.
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health', 'ready', 'metrics'] });
  await app.init();

  const document = buildOpenApiDocument(app);

  const yaml = dump(document, { noRefs: true, lineWidth: 100, sortKeys: false });

  // cwd, not __dirname: this runs from dist/scripts/ but the contract belongs at the repo root.
  const target = resolve(process.cwd(), 'openapi.yaml');
  writeFileSync(target, yaml, 'utf8');

  await app.close();
  console.log(`Wrote ${target} (${Object.keys(document.paths).length} paths)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
