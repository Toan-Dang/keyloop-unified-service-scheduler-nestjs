import Redis from 'ioredis';
import { Pool, type PoolClient } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { readTestEnv } from './test-database';

/** PostgreSQL SQLSTATEs the design maps by name (§6.2). Referenced by tests, not by strings. */
export const SQLSTATE = {
  /** exclusion_violation — another request won the race for this technician/bay window. */
  EXCLUSION_VIOLATION: '23P01',
  /** unique_violation — most often the (dealership_id, idempotency_key) backstop. */
  UNIQUE_VIOLATION: '23505',
  /** check_violation. */
  CHECK_VIOLATION: '23514',
  /** lock_timeout — waited too long on an uncommitted conflicting row. */
  LOCK_TIMEOUT: '55P03',
  /** deadlock_detected. */
  DEADLOCK_DETECTED: '40P01',
} as const;

export function createPool(): Pool {
  return new Pool({ connectionString: readTestEnv().databaseUrl, max: 30 });
}

export function createPrisma(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: readTestEnv().databaseUrl }),
  });
}

/**
 * Truncates the transactional tables, leaving the seeded reference data in place — and clears
 * the idempotency cache with them.
 *
 * Flushing Redis is not optional here. Truncating appointments behind a warm cache leaves the
 * two stores in a state no real system can reach: a cached 201 pointing at a row that no longer
 * exists. A later test reusing that key would replay the phantom and pass for the wrong reason.
 */
export async function resetAppointments(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE TABLE appointments, outbox RESTART IDENTITY CASCADE');
  await flushIdempotencyCache();
}

let redis: Redis | undefined;

export async function flushIdempotencyCache(): Promise<void> {
  try {
    redis ??= new Redis(readTestEnv().redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
    await redis.flushdb();
  } catch {
    // Redis is optional infrastructure; a suite that cannot reach it is testing the degraded
    // path anyway.
  }
}

export async function closeRedis(): Promise<void> {
  await redis?.quit().catch(() => undefined);
  redis = undefined;
}

export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE appointments, outbox, vehicles, customers,
                   technicians, service_bays, service_types, dealerships
    RESTART IDENTITY CASCADE
  `);
}

export interface PgError extends Error {
  code?: string;
  constraint?: string;
}

/** Runs `fn` and returns the PostgreSQL error it raised — failing the test if it raised none. */
export async function expectPgError(fn: () => Promise<unknown>): Promise<PgError> {
  try {
    await fn();
  } catch (err) {
    return err as PgError;
  }
  throw new Error('Expected PostgreSQL to reject this statement, but it succeeded');
}

export async function withClient<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
