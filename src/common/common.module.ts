import { Global, Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { MetricsModule } from './metrics/metrics.module';
import { RedisModule } from './redis/redis.module';

@Global()
@Module({
  imports: [RedisModule, MetricsModule],
  controllers: [HealthController],
  exports: [RedisModule, MetricsModule],
})
export class CommonModule {}
