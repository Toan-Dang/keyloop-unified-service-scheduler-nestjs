import type { Pool } from 'pg';
import { SEED, seed } from '../../prisma/seed';
import {
  createPool,
  createPrisma,
  expectPgError,
  resetAppointments,
  SQLSTATE,
} from '../support/db';
import type { PrismaClient } from '../../generated/prisma/client';

/**
 * M1 acceptance — the invariant itself, proved in raw SQL against real PostgreSQL.
 *
 * Everything here bypasses the application entirely. That is the point: these tests assert that
 * the *database* refuses a double-booking, so they would still pass if every line of booking
 * code were deleted. No mock or in-memory database can run a btree_gist EXCLUDE constraint, so
 * this suite is the only place the core claim can actually be checked (ADR-001, §12).
 */
describe('exclusion constraints — the no-double-booking invariant (ADR-001, db §3)', () => {
  let pool: Pool;
  let prisma: PrismaClient;

  const dealership = SEED.dealership.id;
  const customer = SEED.customers.one.id;
  const vehicle = SEED.vehicles.one.id;
  const serviceType = SEED.serviceTypes.brakeInspection.id;
  const techA = SEED.technicians.brakes.id;
  const techB = SEED.technicians.general.id;
  const bay1 = SEED.bays.one.id;
  const bay2 = SEED.bays.two.id;

  /** A fixed window well inside opening hours; the constraint does not care about hours. */
  const START = '2026-09-07T02:00:00Z';
  const END = '2026-09-07T03:30:00Z';

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

  /** Inserts a CONFIRMED appointment straight through SQL. Returns the new row's id. */
  async function insertAppointment(overrides: {
    technicianId?: string;
    serviceBayId?: string;
    startTime?: string;
    endTime?: string;
    status?: 'CONFIRMED' | 'CANCELLED';
    idempotencyKey?: string | null;
    dealershipId?: string;
  }): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (dealership_id, customer_id, vehicle_id, service_type_id,
          technician_id, service_bay_id, start_time, end_time, status, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        overrides.dealershipId ?? dealership,
        customer,
        vehicle,
        serviceType,
        overrides.technicianId ?? techA,
        overrides.serviceBayId ?? bay1,
        overrides.startTime ?? START,
        overrides.endTime ?? END,
        overrides.status ?? 'CONFIRMED',
        overrides.idempotencyKey ?? null,
      ],
    );
    return result.rows[0]!.id;
  }

  describe('no_technician_overlap', () => {
    it('rejects a second CONFIRMED appointment overlapping the same technician with 23P01', async () => {
      await insertAppointment({ technicianId: techA, serviceBayId: bay1 });

      // Same technician, overlapping window, a *different* bay — so only the technician
      // constraint can be the one that fires.
      const err = await expectPgError(() =>
        insertAppointment({
          technicianId: techA,
          serviceBayId: bay2,
          startTime: '2026-09-07T03:00:00Z',
          endTime: '2026-09-07T04:30:00Z',
        }),
      );

      expect(err.code).toBe(SQLSTATE.EXCLUSION_VIOLATION);
      expect(err.constraint).toBe('no_technician_overlap');
    });

    it('allows the same technician in a window that merely touches, because [start, end) is half-open', async () => {
      await insertAppointment({ technicianId: techA, startTime: START, endTime: END });

      // Starts at exactly the instant the first ends — back-to-back bookings are legal (db §5.1).
      await expect(
        insertAppointment({
          technicianId: techA,
          serviceBayId: bay2,
          startTime: END,
          endTime: '2026-09-07T05:00:00Z',
        }),
      ).resolves.toBeDefined();

      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*) FROM appointments WHERE technician_id = $1',
        [techA],
      );
      expect(rows[0]!.count).toBe('2');
    });
  });

  describe('no_bay_overlap', () => {
    it('rejects a second CONFIRMED appointment overlapping the same bay with 23P01', async () => {
      await insertAppointment({ technicianId: techA, serviceBayId: bay1 });

      // Different technician, same bay — isolates the bay constraint.
      const err = await expectPgError(() =>
        insertAppointment({ technicianId: techB, serviceBayId: bay1 }),
      );

      expect(err.code).toBe(SQLSTATE.EXCLUSION_VIOLATION);
      expect(err.constraint).toBe('no_bay_overlap');
    });
  });

  describe('the constraints are PARTIAL on status = CONFIRMED', () => {
    it('frees the slot the moment a row is cancelled — no delete required (db §5.3)', async () => {
      const first = await insertAppointment({ technicianId: techA, serviceBayId: bay1 });

      // Confirm it really is blocking before we cancel, or the test proves nothing.
      const blocked = await expectPgError(() =>
        insertAppointment({ technicianId: techA, serviceBayId: bay1 }),
      );
      expect(blocked.code).toBe(SQLSTATE.EXCLUSION_VIOLATION);

      await pool.query(
        `UPDATE appointments SET status='CANCELLED', cancelled_at=now() WHERE id=$1`,
        [first],
      );

      await expect(
        insertAppointment({ technicianId: techA, serviceBayId: bay1 }),
      ).resolves.toBeDefined();
    });

    it('never lets a CANCELLED row occupy a window in the first place', async () => {
      await insertAppointment({ technicianId: techA, serviceBayId: bay1, status: 'CANCELLED' });
      await insertAppointment({ technicianId: techA, serviceBayId: bay1, status: 'CANCELLED' });

      await expect(
        insertAppointment({ technicianId: techA, serviceBayId: bay1, status: 'CONFIRMED' }),
      ).resolves.toBeDefined();
    });
  });

  describe('the generated `during` column', () => {
    it('is derived by the database as a half-open tstzrange, not supplied by the client', async () => {
      await insertAppointment({ startTime: START, endTime: END });

      const { rows } = await pool.query<{
        during: string;
        touching: boolean;
        overlapping: boolean;
      }>(
        `SELECT during::text AS during,
                during && tstzrange($2::timestamptz, $3::timestamptz, '[)') AS touching,
                during && tstzrange($1::timestamptz, $3::timestamptz, '[)') AS overlapping
           FROM appointments LIMIT 1`,
        [START, END, '2026-09-07T05:00:00Z'],
      );

      expect(rows[0]!.during).toMatch(/^\["2026-09-07 02:00:00\+00","2026-09-07 03:30:00\+00"\)$/);
      // A range starting exactly where this one ends does not overlap it…
      expect(rows[0]!.touching).toBe(false);
      // …but one starting inside it does.
      expect(rows[0]!.overlapping).toBe(true);
    });

    it('cannot be written directly — it is GENERATED ALWAYS', async () => {
      const err = await expectPgError(() =>
        pool.query(
          `INSERT INTO appointments
             (dealership_id, customer_id, vehicle_id, service_type_id,
              technician_id, service_bay_id, start_time, end_time, during)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, tstzrange($7,$8,'[)'))`,
          [dealership, customer, vehicle, serviceType, techA, bay1, START, END],
        ),
      );

      expect(err.message).toMatch(/cannot insert a non-DEFAULT value into column "during"/i);
    });
  });

  describe('CHECK constraints', () => {
    it('rejects a zero-length window (end_time > start_time)', async () => {
      const err = await expectPgError(() =>
        insertAppointment({ startTime: START, endTime: START }),
      );

      expect(err.code).toBe(SQLSTATE.CHECK_VIOLATION);
      expect(err.constraint).toBe('appointments_time_valid');
    });

    it('rejects a service type with a non-positive duration at the source', async () => {
      const err = await expectPgError(() =>
        pool.query(
          `INSERT INTO service_types (dealership_id, name, duration_minutes, required_skills)
           VALUES ($1, 'Impossible Service', 0, '{}')`,
          [dealership],
        ),
      );

      expect(err.code).toBe(SQLSTATE.CHECK_VIOLATION);
      expect(err.constraint).toBe('service_types_duration_positive');
    });
  });

  describe('the idempotency backstop is tenant-scoped', () => {
    it('refuses a second row with the same (dealership_id, idempotency_key) — 23505', async () => {
      await insertAppointment({ idempotencyKey: 'key-abc' });

      const err = await expectPgError(() =>
        insertAppointment({
          idempotencyKey: 'key-abc',
          startTime: '2026-09-08T02:00:00Z',
          endTime: '2026-09-08T03:30:00Z',
        }),
      );

      expect(err.code).toBe(SQLSTATE.UNIQUE_VIOLATION);
      expect(err.constraint).toBe('appointments_idempotency_key_uniq');
    });

    it('lets a different dealership reuse the same key value — no cross-tenant collision', async () => {
      await insertAppointment({ idempotencyKey: 'shared-key' });

      const other = SEED.otherDealership.id;
      const t = SEED.otherTenant;

      await expect(
        pool.query(
          `INSERT INTO appointments
             (dealership_id, customer_id, vehicle_id, service_type_id,
              technician_id, service_bay_id, start_time, end_time, idempotency_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            other,
            t.customerId,
            t.vehicleId,
            t.serviceTypeId,
            t.technicianId,
            t.bayId,
            START,
            END,
            'shared-key',
          ],
        ),
      ).resolves.toBeDefined();
    });

    it('does not constrain rows without a key — the index is partial on NOT NULL', async () => {
      await insertAppointment({ idempotencyKey: null });
      await expect(
        insertAppointment({
          idempotencyKey: null,
          serviceBayId: bay2,
          technicianId: techB,
          startTime: '2026-09-09T02:00:00Z',
          endTime: '2026-09-09T03:30:00Z',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('blocking semantics (§6.2) — why the loop needs a lock_timeout', () => {
    it('BLOCKS rather than failing fast while the conflicting row is still uncommitted', async () => {
      const holder = await pool.connect();
      const waiter = await pool.connect();

      try {
        await holder.query('BEGIN');
        await holder.query(
          `INSERT INTO appointments
             (dealership_id, customer_id, vehicle_id, service_type_id,
              technician_id, service_bay_id, start_time, end_time)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [dealership, customer, vehicle, serviceType, techA, bay1, START, END],
        );
        // Deliberately NOT committed yet.

        await waiter.query('BEGIN');
        // This is exactly the cap the allocation loop sets per transaction.
        await waiter.query(`SET LOCAL lock_timeout = '300ms'`);

        const err = await expectPgError(() =>
          waiter.query(
            `INSERT INTO appointments
               (dealership_id, customer_id, vehicle_id, service_type_id,
                technician_id, service_bay_id, start_time, end_time)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [dealership, customer, vehicle, serviceType, techA, bay1, START, END],
          ),
        );

        // 55P03, not 23P01: an exclusion violation is only raised *immediately* when the
        // conflicting row is already committed. Against an in-flight transaction the insert
        // waits — which is precisely why one hot slot could otherwise pin a request, and why
        // SET LOCAL lock_timeout is not optional (§6.2).
        expect(err.code).toBe(SQLSTATE.LOCK_TIMEOUT);

        await waiter.query('ROLLBACK');
        await holder.query('ROLLBACK');
      } finally {
        holder.release();
        waiter.release();
      }
    });

    it('raises 23P01 immediately once the conflicting row IS committed', async () => {
      await insertAppointment({});

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = '2s'`);
        const started = Date.now();

        const err = await expectPgError(() =>
          client.query(
            `INSERT INTO appointments
               (dealership_id, customer_id, vehicle_id, service_type_id,
                technician_id, service_bay_id, start_time, end_time)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [dealership, customer, vehicle, serviceType, techA, bay1, START, END],
          ),
        );

        expect(err.code).toBe(SQLSTATE.EXCLUSION_VIOLATION);
        // No waiting involved — nowhere near the 2s lock_timeout.
        expect(Date.now() - started).toBeLessThan(1000);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });
  });

  describe('SAVEPOINT recovery (§6.2) — why the allocation loop is written the way it is', () => {
    it('aborts the WHOLE transaction on 23P01 unless a savepoint is in play', async () => {
      await insertAppointment({});

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const conflict = await expectPgError(() =>
          client.query(
            `INSERT INTO appointments
               (dealership_id, customer_id, vehicle_id, service_type_id,
                technician_id, service_bay_id, start_time, end_time)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [dealership, customer, vehicle, serviceType, techA, bay1, START, END],
          ),
        );
        expect(conflict.code).toBe(SQLSTATE.EXCLUSION_VIOLATION);

        // The naive "catch the error and try the next candidate" cannot work: every subsequent
        // statement in this transaction now fails with 25P02 until it is rolled back. This is
        // the concrete reason the design uses SAVEPOINT per candidate.
        const poisoned = await expectPgError(() => client.query('SELECT 1'));
        expect(poisoned.code).toBe('25P02');

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('recovers to just before the failed INSERT with ROLLBACK TO SAVEPOINT, so the next candidate can be tried', async () => {
      await insertAppointment({ technicianId: techA, serviceBayId: bay1 });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = '2s'`);

        // Candidate 1 — loses the race.
        await client.query('SAVEPOINT candidate');
        const conflict = await expectPgError(() =>
          client.query(
            `INSERT INTO appointments
               (dealership_id, customer_id, vehicle_id, service_type_id,
                technician_id, service_bay_id, start_time, end_time)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [dealership, customer, vehicle, serviceType, techA, bay1, START, END],
          ),
        );
        expect(conflict.code).toBe(SQLSTATE.EXCLUSION_VIOLATION);

        await client.query('ROLLBACK TO SAVEPOINT candidate');

        // Candidate 2 — a free (technician, bay) pair. The transaction is alive again.
        await client.query(
          `INSERT INTO appointments
             (dealership_id, customer_id, vehicle_id, service_type_id,
              technician_id, service_bay_id, start_time, end_time)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [dealership, customer, vehicle, serviceType, techB, bay2, START, END],
        );
        await client.query('RELEASE SAVEPOINT candidate');
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM appointments');
      expect(rows[0]!.count).toBe('2');
    });
  });
});
