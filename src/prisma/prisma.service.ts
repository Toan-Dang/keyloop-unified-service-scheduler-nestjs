import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../../generated/prisma/client';
import type { AppConfig } from '../config/configuration';

/**
 * The single PrismaClient for the process.
 *
 * Prisma 7 talks to PostgreSQL through the `@prisma/adapter-pg` driver adapter over a `pg.Pool`
 * we own — which matters twice over:
 *
 *  1. **Connection budget.** `instances × pool_size` must stay under `max_connections` (§10), so
 *     the pool is explicit and sized from config rather than left implicit.
 *  2. **Prepared statements are not cached** by this adapter unless a `statementNameGenerator` is
 *     supplied, which is exactly what §14 requires when running behind PgBouncer/RDS Proxy in
 *     transaction-pooling mode. We deliberately do not supply one.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private static readonly log = new Logger(PrismaService.name);
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    const database = config.getOrThrow<AppConfig['database']>('database');
    const pool = new Pool({
      connectionString: database.url,
      max: Number.parseInt(process.env.DATABASE_POOL_SIZE ?? '20', 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // Every window comparison happens server-side, so the app's own clock never decides
      // correctness (§10.1 clock-skew row). Keeping the session in UTC keeps logs unambiguous.
      options: '-c timezone=UTC',
    });

    super({
      adapter: new PrismaPg(pool, {
        onPoolError: (err) => PrismaService.log.error({ err: err.message }, 'pg pool error'),
      }),
    });

    this.pool = pool;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    // Graceful shutdown drains in-flight work before the pool closes (§10).
    await this.$disconnect();
    await this.pool.end().catch(() => undefined);
  }

  /** Readiness hard-depends on the database — the one true correctness dependency (§13). */
  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
