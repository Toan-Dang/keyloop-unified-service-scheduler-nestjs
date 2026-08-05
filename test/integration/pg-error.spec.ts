import type { Pool } from 'pg';
import { SEED, seed } from '../../prisma/seed';
import { CONSTRAINT, SQLSTATE, constraintOf, sqlStateOf } from '../../src/booking/pg-error';
import { createPool, createPrisma, resetAppointments } from '../support/db';
import type { PrismaClient } from '../../generated/prisma/client';

/**
 * `pg-error.ts` decides which SQLSTATE branch the allocation loop takes (§6.2) — getting it wrong
 * turns "try the next candidate" into a bare 500. Its own doc comment names the risk: Prisma 7
 * buries the real code at `meta.driverAdapterError.cause.code`, with a message-regex "last resort"
 * for whatever that structured path doesn't cover. `exclusion-constraint.spec.ts` proves the
 * constraints themselves against raw `pg`, never through Prisma, so nothing previously exercised
 * this file against a REAL Prisma-wrapped error.
 *
 * This suite drives the exact call shape production uses (`$executeRawUnsafe` through the real
 * `PrismaClient` + `@prisma/adapter-pg`) and asserts `sqlStateOf`/`constraintOf` decode what
 * Prisma 7.9.1 actually throws today — so a Prisma upgrade that changes the error shape fails
 * HERE, with a clear message, instead of surfacing as a silent 500 in the allocation loop.
 */
describe('pg-error.ts — decoding real Prisma-wrapped PostgreSQL errors', () => {
  let pool: Pool;
  let prisma: PrismaClient;

  const dealership = SEED.dealership.id;
  const customer = SEED.customers.one.id;
  const vehicle = SEED.vehicles.one.id;
  const serviceType = SEED.serviceTypes.brakeInspection.id;
  const techA = SEED.technicians.brakes.id;
  const bay1 = SEED.bays.one.id;

  const START = '2026-09-07T02:00:00Z';
  const END = '2026-09-07T03:30:00Z';

  async function insert(
    idempotencyKey: string | null,
    startTime: string,
    endTime: string,
  ): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO appointments
         (dealership_id, customer_id, vehicle_id, service_type_id,
          technician_id, service_bay_id, start_time, end_time, idempotency_key)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::timestamptz,$8::timestamptz,$9)`,
      dealership,
      customer,
      vehicle,
      serviceType,
      techA,
      bay1,
      startTime,
      endTime,
      idempotencyKey,
    );
  }

  async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      await fn();
    } catch (err) {
      return err;
    }
    throw new Error('Expected Prisma to reject this statement, but it succeeded');
  }

  beforeAll(async () => {
    pool = createPool();
    prisma = createPrisma();
    await seed(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  beforeEach(async () => {
    await resetAppointments(pool);
  });

  it('decodes 23P01 exclusion_violation and the technician constraint name', async () => {
    await insert(null, START, END);

    const err = await catchError(() => insert(null, START, END));

    expect(sqlStateOf(err)).toBe(SQLSTATE.EXCLUSION_VIOLATION);
    expect(constraintOf(err)).toBe(CONSTRAINT.NO_TECHNICIAN_OVERLAP);
  });

  it('decodes 23505 unique_violation and the idempotency constraint name', async () => {
    await insert('dup-key', START, END);

    // A non-overlapping window so the exclusion constraint cannot also fire — isolates 23505
    // (§6.2's note: PostgreSQL reports whichever constraint has the lower OID when both could).
    const err = await catchError(() =>
      insert('dup-key', '2026-09-08T02:00:00Z', '2026-09-08T03:30:00Z'),
    );

    expect(sqlStateOf(err)).toBe(SQLSTATE.UNIQUE_VIOLATION);
    expect(constraintOf(err)).toBe(CONSTRAINT.IDEMPOTENCY_KEY_UNIQUE);
  });
});
