import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { applyMigrations, writeTestEnv } from './test-database';

declare global {
  var __USS_CONTAINERS__: {
    postgres?: StartedPostgreSqlContainer;
    redis?: StartedRedisContainer;
  };
}

export default async function globalSetup(): Promise<void> {
  const externalDb = process.env.TEST_DATABASE_URL;

  if (externalDb) {
    // Escape hatch (see test-database.ts): a real PostgreSQL is already running.
    const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
    console.log(`\n[test-env] using external PostgreSQL from TEST_DATABASE_URL`);
    applyMigrations(externalDb);
    writeTestEnv({ databaseUrl: externalDb, redisUrl, managed: false });
    return;
  }

  console.log('\n[test-env] starting postgres:18-alpine + redis:8-alpine via Testcontainers…');

  const postgres = await new PostgreSqlContainer('postgres:18-alpine')
    .withDatabase('scheduler_test')
    .withUsername('scheduler')
    .withPassword('scheduler_test_pw')
    .start();

  const redis = await new RedisContainer('redis:8-alpine').start();

  globalThis.__USS_CONTAINERS__ = { postgres, redis };

  const databaseUrl = `${postgres.getConnectionUri()}?schema=public`;
  applyMigrations(databaseUrl);
  writeTestEnv({ databaseUrl, redisUrl: redis.getConnectionUrl(), managed: true });
}
