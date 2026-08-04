import { Global, Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { MetricsModule } from './metrics/metrics.module';
import { RedisModule } from './redis/redis.module';

@Global()
@Module({
  imports: [RedisModule, MetricsModule, IdempotencyModule],
  controllers: [HealthController],
  exports: [RedisModule, MetricsModule, IdempotencyModule],
})
export class CommonModule {}
