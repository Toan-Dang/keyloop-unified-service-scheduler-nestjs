import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { API_PREFIX, buildOpenApiDocument, setupSwagger } from './openapi';
import type { AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);
  const port = config.getOrThrow<AppConfig['port']>('port');

  // Version-prefixed routes so a breaking change ships as /v2 without disrupting integrations
  // (§7). Operational endpoints stay unprefixed so probes never chase a version.
  app.setGlobalPrefix(API_PREFIX, {
    exclude: ['health', 'ready', 'metrics'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // A body that names a dealership is rejected outright — the tenant comes from the token,
      // and silently stripping the field would hide a client bug (§7, §14).
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  setupSwagger(app, buildOpenApiDocument(app));

  // Drain in-flight requests before exiting (§10 graceful shutdown).
  app.enableShutdownHooks();

  await app.listen(port, '0.0.0.0');
}

void bootstrap();
