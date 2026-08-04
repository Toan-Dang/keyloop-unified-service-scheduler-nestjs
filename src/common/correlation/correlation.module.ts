import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { CorrelationIdMiddleware } from './correlation-id.middleware';

/**
 * Owns the AsyncLocalStorage scope for the correlation id.
 *
 * It sits in its own module rather than in AppModule's `configure()` so the ordering relative to
 * nestjs-pino's request logger is at least explicit. It is not *load-bearing* ordering, though:
 * Nest initialises dynamic modules in dependency order rather than import order, so the id is
 * pinned to the request headers by whichever of the two runs first (see `resolveCorrelationId`).
 */
@Module({})
export class CorrelationModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*path');
  }
}
