import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { SEED, seed } from '../../prisma/seed';
import { createTestApp, staffToken } from '../support/app';
import { createPool, createPrisma, resetAppointments } from '../support/db';
import type { PrismaClient } from '../../generated/prisma/client';

/**
 * ===========================================================================================
 * THE SIGNATURE TEST (§6.5, §12) — the claim this entire system exists to make.
 *
 * N parallel POST /appointments for ONE slot ⇒ exactly one 201, every other 409.
 *
 * Two things make this a real proof rather than a ritual:
 *
 *  1. It runs against REAL PostgreSQL. The guarantee is a btree_gist EXCLUDE constraint; a mock
 *     or in-memory database cannot run one, so a green test against a fake would prove nothing.
 *
 *  2. It books a **Brake Inspection**, never an Oil Change. Only one seeded technician holds the
 *     `brakes` skill, so exactly one of the racing requests *can* win. Oil Change qualifies both
 *     technicians against two free bays, so two appointments would be a perfectly correct
 *     outcome — a test that booked it could pass while double-booking, which is worse than no
 *     test at all (§6.5).
 *
 * Each request carries its own Idempotency-Key. Sharing one would collapse the burst into an
 * idempotent replay and quietly test deduplication instead of exclusion.
 * ===========================================================================================
 */
describe('THE INVARIANT: no double-booking under concurrency (§6.5)', () => {
  let app: INestApplication;
  let pool: Pool;
  let prisma: PrismaClient;

  const token = staffToken();
  const brakeInspection = SEED.serviceTypes.brakeInspection;
  const onlyQualifiedTechnician = SEED.technicians.brakes.id;

  /** Monday 09:00 local (Asia/Ho_Chi_Minh, UTC+7) = 02:00Z — inside opening hours. */
  const CONTESTED_SLOT = '2026-09-07T02:00:00Z';

  beforeAll(async () => {
    pool = createPool();
    prisma = createPrisma();
    await seed(prisma);
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await pool.end();
  });

  beforeEach(async () => {
    await resetAppointments(pool);
  });

  function book(slot: string, serviceTypeId: string, key: string): request.Test {
    return request(app.getHttpServer())
      .post('/v1/appointments')
      .set('Authorization', token)
      .set('Idempotency-Key', key)
      .send({
        customerId: SEED.customers.one.id,
        vehicleId: SEED.vehicles.one.id,
        serviceTypeId,
        desiredStartTime: slot,
      });
  }

  /**
   * Fires N bookings for the same slot as simultaneously as the runtime allows.
   *
   * `keyPrefix` must differ between logically separate attempts. Reusing keys across two races
   * would not re-run allocation at all: the durable `(dealership_id, idempotency_key)` index
   * would match the first race's row and every request would replay it as a 201 — testing
   * idempotency while appearing to test exclusion.
   */
  async function race(
    n: number,
    slot = CONTESTED_SLOT,
    keyPrefix = 'race',
  ): Promise<request.Response[]> {
    return Promise.all(
      Array.from({ length: n }, (_, i) =>
        book(slot, brakeInspection.id, `${keyPrefix}-${slot}-${i}`),
      ),
    );
  }

  function tally(responses: request.Response[]): Record<number, number> {
    return responses.reduce<Record<number, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
  }

  async function confirmedRows(): Promise<
    { id: string; technician_id: string; service_bay_id: string }[]
  > {
    const { rows } = await pool.query(
      `SELECT id, technician_id, service_bay_id FROM appointments WHERE status='CONFIRMED'`,
    );
    return rows;
  }

  it.each([2, 5, 10, 25])(
    '%i parallel bookings for one Brake Inspection slot ⇒ exactly one 201, the rest 409',
    async (n) => {
      const responses = await race(n);
      const counts = tally(responses);

      expect(counts[201]).toBe(1);
      expect(counts[409]).toBe(n - 1);
      // Nothing may fail for any *other* reason — a 500 here would mean the loop mishandled a
      // SQLSTATE, and would invalidate the whole proof.
      expect(Object.keys(counts).map(Number).sort()).toEqual(n === 1 ? [201] : [201, 409]);

      const rows = await confirmedRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.technician_id).toBe(onlyQualifiedTechnician);

      const losers = responses.filter((r) => r.status === 409);
      for (const loser of losers) {
        expect(loser.body).toMatchObject({ code: 'NO_AVAILABILITY' });
        expect(loser.body.correlationId).toEqual(expect.any(String));
      }
    },
  );

  it('never produces two CONFIRMED rows for the same technician, over repeated bursts', async () => {
    // Repetition matters: a race is probabilistic, and a single green run is weak evidence. Each
    // round targets a fresh slot so rounds cannot interfere with one another.
    const ROUNDS = 25;
    const PARALLEL = 8;
    const outcomes: { round: number; created: number; conflicts: number }[] = [];

    for (let round = 0; round < ROUNDS; round += 1) {
      await resetAppointments(pool);

      // Walk the day so each round books a genuinely different window.
      const hour = 2 + ((round * 2) % 8);
      const slot = `2026-09-07T0${hour}:00:00Z`;

      const responses = await Promise.all(
        Array.from({ length: PARALLEL }, (_, i) =>
          book(slot, brakeInspection.id, `burst-${round}-${i}`),
        ),
      );
      const counts = tally(responses);
      outcomes.push({ round, created: counts[201] ?? 0, conflicts: counts[409] ?? 0 });

      const rows = await confirmedRows();
      expect(rows).toHaveLength(1);
    }

    // Every single round must have produced exactly one winner. Reported in aggregate so a
    // failure shows which round broke.
    expect(outcomes).toEqual(
      Array.from({ length: ROUNDS }, (_, round) => ({
        round,
        created: 1,
        conflicts: PARALLEL - 1,
      })),
    );
  });

  it('detects a double-booking if one ever occurred — the assertion is not vacuous', async () => {
    // Guards the guard. If the query below could not see a second overlapping CONFIRMED row,
    // every assertion above would pass no matter what the loop did. So: insert one deliberately,
    // bypassing the application, and confirm the detector fires.
    await race(4);

    const overlapping = await pool.query<{ count: string }>(`
      SELECT count(*)::text AS count
        FROM appointments a
        JOIN appointments b
          ON a.id <> b.id
         AND a.status = 'CONFIRMED' AND b.status = 'CONFIRMED'
         AND (a.technician_id = b.technician_id OR a.service_bay_id = b.service_bay_id)
         AND a.during && b.during
    `);
    expect(overlapping.rows[0]!.count).toBe('0');

    // The database itself refuses to let us create the state the detector looks for — which is
    // the strongest possible statement of the invariant.
    const winner = (await confirmedRows())[0]!;
    await expect(
      pool.query(
        `INSERT INTO appointments
           (dealership_id, customer_id, vehicle_id, service_type_id,
            technician_id, service_bay_id, start_time, end_time)
         SELECT dealership_id, customer_id, vehicle_id, service_type_id,
                technician_id, service_bay_id, start_time, end_time
           FROM appointments WHERE id = $1`,
        [winner.id],
      ),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('CONTRAST: the same burst on an Oil Change legitimately places TWO appointments', async () => {
    // The control case, and the reason §6.5 insists on Brake Inspection. Two technicians qualify
    // for `general` and two bays are free, so capacity here really is 2 — a test that raced this
    // service and asserted "exactly one 201" would be asserting a falsehood, and one that
    // asserted "no more than one row" would fail for a *correct* system.
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        book('2026-09-07T02:00:00Z', SEED.serviceTypes.oilChange.id, `oil-${i}`),
      ),
    );
    const counts = tally(responses);

    expect(counts[201]).toBe(2);
    expect(counts[409]).toBe(8);

    const rows = await confirmedRows();
    expect(rows).toHaveLength(2);
    // Two appointments, but they must occupy *different* technicians and *different* bays.
    expect(new Set(rows.map((r) => r.technician_id)).size).toBe(2);
    expect(new Set(rows.map((r) => r.service_bay_id)).size).toBe(2);
  });

  it('frees the slot on cancellation, and the next racer wins it cleanly', async () => {
    const first = await race(5, CONTESTED_SLOT, 'before-cancel');
    const winner = first.find((r) => r.status === 201)!;

    await pool.query(`UPDATE appointments SET status='CANCELLED', cancelled_at=now() WHERE id=$1`, [
      winner.body.id,
    ]);

    // Same contested window, all over again — but with FRESH idempotency keys, because these are
    // new booking attempts, not retries of the cancelled one.
    const second = await race(5, CONTESTED_SLOT, 'after-cancel');
    const counts = tally(second);
    expect(counts[201]).toBe(1);
    expect(counts[409]).toBe(4);

    expect(await confirmedRows()).toHaveLength(1);
  });
});
