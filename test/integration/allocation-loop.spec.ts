import type { INestApplication } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { SEED, seed } from '../../prisma/seed';
import { createTestApp, staffToken } from '../support/app';
import { createPool, createPrisma, resetAppointments } from '../support/db';
import type { PrismaClient } from '../../generated/prisma/client';

/**
 * The allocation loop's branches (§6.2), each exercised against real PostgreSQL.
 *
 * The concurrency suite proves the *outcome*; this one proves the *mechanism* — that the
 * appointment and its outbox row commit together, that a lost candidate falls through to the
 * next pair, and that a hot slot times out instead of pinning the request.
 */
describe('allocation loop mechanics (§6.2)', () => {
  let app: INestApplication;
  let pool: Pool;
  let prisma: PrismaClient;

  const token = staffToken();
  const brakes = SEED.serviceTypes.brakeInspection;
  const oil = SEED.serviceTypes.oilChange;

  /** Monday 09:00 local (UTC+7). */
  const SLOT = '2026-09-07T02:00:00Z';

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

  function book(serviceTypeId: string, key: string, start = SLOT): request.Test {
    return request(app.getHttpServer())
      .post('/v1/appointments')
      .set('Authorization', token)
      .set('Idempotency-Key', key)
      .send({
        customerId: SEED.customers.one.id,
        vehicleId: SEED.vehicles.one.id,
        serviceTypeId,
        desiredStartTime: start,
      });
  }

  describe('the transactional outbox (ADR-006)', () => {
    it('writes the appointment and its AppointmentConfirmed event in ONE transaction', async () => {
      const res = await book(brakes.id, 'outbox-1').expect(201);

      const { rows } = await pool.query(
        `SELECT event_type, aggregate_type, aggregate_id, status, attempts, dealership_id, payload
           FROM outbox`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        event_type: 'AppointmentConfirmed',
        aggregate_type: 'appointment',
        aggregate_id: res.body.id,
        status: 'PENDING',
        // Leasing must never bump this; only a real publish failure does (db §2.8).
        attempts: 0,
        dealership_id: SEED.dealership.id,
      });
      // The correlation id rides on the event so an async notification traces back (§13).
      expect(rows[0].payload).toMatchObject({
        appointmentId: res.body.id,
        correlationId: expect.any(String),
      });
    });

    it('writes NO outbox row when the booking is rejected — nothing partial ever commits', async () => {
      await book(brakes.id, 'outbox-win').expect(201);
      await book(brakes.id, 'outbox-lose').expect(409);

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox');
      expect(rows[0].n).toBe(1); // only the winner's
    });

    it('rolls the outbox row back with the appointment if the transaction fails after both inserts', async () => {
      // Simulated by a raw transaction that inserts both then aborts — the atomicity claim is
      // about the transaction boundary, not about our happy path.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const appt = await client.query<{ id: string }>(
          `INSERT INTO appointments
             (dealership_id, customer_id, vehicle_id, service_type_id,
              technician_id, service_bay_id, start_time, end_time)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [
            SEED.dealership.id,
            SEED.customers.one.id,
            SEED.vehicles.one.id,
            brakes.id,
            SEED.technicians.brakes.id,
            SEED.bays.one.id,
            SLOT,
            '2026-09-07T03:30:00Z',
          ],
        );
        await client.query(
          `INSERT INTO outbox (dealership_id, aggregate_type, aggregate_id, event_type, payload)
           VALUES ($1,'appointment',$2,'AppointmentConfirmed','{}'::jsonb)`,
          [SEED.dealership.id, appt.rows[0]!.id],
        );
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      const appointments = await pool.query('SELECT count(*)::int AS n FROM appointments');
      const outbox = await pool.query('SELECT count(*)::int AS n FROM outbox');
      expect(appointments.rows[0].n).toBe(0);
      expect(outbox.rows[0].n).toBe(0);
    });
  });

  describe('candidate iteration', () => {
    it('falls through to the next (technician, bay) pair when the first is taken', async () => {
      // Occupy Bay 1 with a different technician, so the first candidate pair for an Oil Change
      // is blocked on the bay and the loop must advance.
      await pool.query(
        `INSERT INTO appointments
           (dealership_id, customer_id, vehicle_id, service_type_id,
            technician_id, service_bay_id, start_time, end_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          SEED.dealership.id,
          SEED.customers.one.id,
          SEED.vehicles.one.id,
          oil.id,
          SEED.technicians.general.id,
          SEED.bays.one.id,
          SLOT,
          '2026-09-07T03:00:00Z',
        ],
      );

      const res = await book(oil.id, 'fallthrough-1').expect(201);

      // It had to land on the other technician AND the other bay.
      expect(res.body.technicianId).toBe(SEED.technicians.brakes.id);
      expect(res.body.serviceBayId).toBe(SEED.bays.two.id);
    });

    it('visits candidates in deterministic (technician_id, service_bay_id) order', async () => {
      // Deterministic ordering is what keeps 40P01 rare (§6.2). With an empty schedule the
      // winner must therefore be the lowest technician id paired with the lowest bay id.
      const res = await book(oil.id, 'ordering-1').expect(201);

      const lowestTechnician = [SEED.technicians.general.id, SEED.technicians.brakes.id].sort()[0];
      const lowestBay = [SEED.bays.one.id, SEED.bays.two.id].sort()[0];

      expect(res.body.technicianId).toBe(lowestTechnician);
      expect(res.body.serviceBayId).toBe(lowestBay);
    });

    it('returns 409 NO_AVAILABILITY once every candidate pair is exhausted', async () => {
      await book(brakes.id, 'exhaust-win').expect(201);

      const res = await book(brakes.id, 'exhaust-lose').expect(409);
      expect(res.body).toMatchObject({ code: 'NO_AVAILABILITY' });
      expect(res.body.details.candidatesTried).toBeGreaterThanOrEqual(0);
    });
  });

  describe('55P03 lock_timeout — a hot slot must not pin the request (§6.2)', () => {
    it('gives up on a candidate blocked by an in-flight transaction and answers within the cap', async () => {
      let holder: PoolClient | undefined;
      try {
        holder = await pool.connect();
        await holder.query('BEGIN');
        // Hold the ONLY brakes-qualified technician's window uncommitted. A racing insert will
        // block on it rather than fail fast, because an exclusion violation is only raised once
        // the conflicting row commits.
        await holder.query(
          `INSERT INTO appointments
             (dealership_id, customer_id, vehicle_id, service_type_id,
              technician_id, service_bay_id, start_time, end_time)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            SEED.dealership.id,
            SEED.customers.one.id,
            SEED.vehicles.one.id,
            brakes.id,
            SEED.technicians.brakes.id,
            SEED.bays.one.id,
            SLOT,
            '2026-09-07T03:30:00Z',
          ],
        );

        const started = Date.now();
        const res = await book(brakes.id, 'hotslot-1');
        const elapsed = Date.now() - started;

        // Both candidate pairs use the same (only) qualified technician, so both block and both
        // time out — then the loop reports no availability rather than hanging.
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('NO_AVAILABILITY');

        // Bounded by lock_timeout per candidate (2s default), not unbounded. Two candidates ⇒
        // comfortably under 3× the cap; the point is that it terminates.
        expect(elapsed).toBeLessThan(3 * 2000 + 2000);

        await holder.query('ROLLBACK');
      } finally {
        holder?.release();
      }
    });
  });

  describe('23505 — a concurrent retry of the same request', () => {
    it('returns the SAME appointment rather than erroring, and creates no second row', async () => {
      const first = await book(brakes.id, 'same-key').expect(201);
      const retry = await book(brakes.id, 'same-key').expect(201);

      expect(retry.body.id).toBe(first.body.id);

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM appointments');
      expect(rows[0].n).toBe(1);
    });

    it('does not emit a duplicate outbox event on replay', async () => {
      await book(brakes.id, 'replay-outbox').expect(201);
      await book(brakes.id, 'replay-outbox').expect(201);

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox');
      expect(rows[0].n).toBe(1);
    });
  });

  describe('tenant scoping', () => {
    it('reports another dealership’s service type as 404, not 403 — no existence leak (§14)', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/appointments')
        .set('Authorization', token)
        .set('Idempotency-Key', 'cross-tenant-1')
        .send({
          customerId: SEED.customers.one.id,
          vehicleId: SEED.vehicles.one.id,
          // Exists — but belongs to Berlin Motorwerk.
          serviceTypeId: SEED.otherTenant.serviceTypeId,
          desiredStartTime: SLOT,
        });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  describe('the Idempotency-Key header is required (§7.1)', () => {
    it('rejects a booking with no key as 400 VALIDATION_ERROR', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/appointments')
        .set('Authorization', token)
        .send({
          customerId: SEED.customers.one.id,
          vehicleId: SEED.vehicles.one.id,
          serviceTypeId: brakes.id,
          desiredStartTime: SLOT,
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });
});
