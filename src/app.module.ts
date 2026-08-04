import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { AvailabilityModule } from './availability/availability.module';
import { BookingModule } from './booking/booking.module';
import { CommonModule } from './common/common.module';
import { resolveCorrelationId } from './common/correlation/correlation';
import { CorrelationModule } from './common/correlation/correlation.module';
import { TenantGuard } from './common/auth/tenant.guard';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { HttpMetricsInterceptor } from './common/metrics/http-metrics.interceptor';
import { loadConfiguration } from './config/configuration';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { ResourcesModule } from './resources/resources.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [loadConfiguration],
      envFilePath: ['.env'],
    }),
    CorrelationModule,
    LoggerModule.forRootAsync({
      useFactory: () => ({
        pinoHttp: {
          level: process.env.LOG_LEVEL ?? 'info',
          // Structured JSON in every environment; pretty only when a human is watching.
          transport:
            process.env.NODE_ENV === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
          // One id for the whole request: the same value the response header carries, the
          // exception filter reports, and emitted events inherit (§13). Seeds the header if it
          // runs before the correlation middleware, reads it back if it runs after.
          genReqId: (req, res) => resolveCorrelationId(req, res),
          // Also lift it to the top level so operators can grep one flat field across app logs,
          // relay logs and consumer logs alike.
          customProps: (req) => ({ correlationId: resolveCorrelationId(req) }),
          autoLogging: {
            ignore: (req) => {
              const url = (req as { url?: string }).url ?? '';
              return url.startsWith('/metrics') || url.startsWith('/health');
            },
          },
          // PII is never logged (§13).
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["idempotency-key"]',
              'req.body.email',
              'res.headers["set-cookie"]',
            ],
            remove: true,
          },
        },
      }),
    }),
    EventEmitterModule.forRoot({ global: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    CommonModule,
    AvailabilityModule,
    BookingModule,
    ResourcesModule,
    NotificationsModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
})
export class AppModule {}
