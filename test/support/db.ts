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

/** Truncates the transactional tables, leaving the seeded reference data in place. */
export async function resetAppointments(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE TABLE appointments, outbox RESTART IDENTITY CASCADE');
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
