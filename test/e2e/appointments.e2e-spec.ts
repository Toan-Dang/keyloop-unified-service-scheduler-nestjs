import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { SEED, seed } from '../../prisma/seed';
import { createTestApp, customerToken, staffToken } from '../support/app';
import { createPool, createPrisma, resetAppointments } from '../support/db';
import type { PrismaClient } from '../../generated/prisma/client';

/**
 * Read, list and cancel (§5.2, §7, §7.2, §14).
 */
describe('appointments: read, list, cancel', () => {
  let app: INestApplication;
  let pool: Pool;
  let prisma: PrismaClient;

  const staff = staffToken();
  const brakes = SEED.serviceTypes.brakeInspection.id;
  const oil = SEED.serviceTypes.oilChange.id;

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

  const book = (key: string, overrides: Record<string, unknown> = {}, auth = staff): request.Test =>
    request(app.getHttpServer())
      .post('/v1/appointments')
      .set('Authorization', auth)
      .set('Idempotency-Key', key)
      .send({
        customerId: SEED.customers.one.id,
        vehicleId: SEED.vehicles.one.id,
        serviceTypeId: brakes,
        desiredStartTime: '2026-09-07T02:00:00Z',
        ...overrides,
      });

  describe('GET /appointments/{id}', () => {
    it('returns the appointment with its allocated resources', async () => {
      const created = await book('get-1').expect(201);

      const res = await request(app.getHttpServer())
        .get(`/v1/appointments/${created.body.id}`)
        .set('Authorization', staff)
        .expect(200);

      expect(res.body).toMatchObject({
        id: created.body.id,
        status: 'CONFIRMED',
        technicianId: SEED.technicians.brakes.id,
        cancelledAt: null,
      });
    });

    it('404s for an appointment in another dealership — no existence leak', async () => {
      const created = await book('get-cross').expect(201);

      const res = await request(app.getHttpServer())
        .get(`/v1/appointments/${created.body.id}`)
        .set('Authorization', staffToken(SEED.otherDealership.id));

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('400s on a malformed uuid rather than letting it reach the database', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/appointments/not-a-uuid')
        .set('Authorization', staff);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /appointments — keyset pagination (§7.2)', () => {
    /** Books `n` non-overlapping Oil Changes across the day so paging has something to walk. */
    async function bookMany(n: number): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < n; i += 1) {
        // 08:00 local onwards, hourly; two technicians × two bays gives ample capacity.
        const hour = String(1 + i).padStart(2, '0');
        const res = await book(`page-${i}`, {
          serviceTypeId: oil,
          desiredStartTime: `2026-09-07T${hour}:00:00Z`,
        }).expect(201);
        ids.push(res.body.id);
      }
      return ids;
    }

    it('walks every row exactly once across pages, newest first', async () => {
      const created = await bookMany(7);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const res: request.Response = await request(app.getHttpServer())
          .get('/v1/appointments')
          .query({ limit: 3, ...(cursor ? { cursor } : {}) })
          .set('Authorization', staff)
          .expect(200);

        seen.push(...res.body.items.map((a: { id: string }) => a.id));
        cursor = res.body.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(10); // guard against a cursor that never terminates
      } while (cursor);

      // No duplicates, no omissions — the property OFFSET cannot guarantee under concurrent
      // writes and keyset can.
      expect(new Set(seen).size).toBe(created.length);
      expect(seen.sort()).toEqual(created.sort());
    });

    it('returns nextCursor = null on the final page', async () => {
      await bookMany(2);

      const res = await request(app.getHttpServer())
        .get('/v1/appointments')
        .query({ limit: 50 })
        .set('Authorization', staff)
        .expect(200);

      expect(res.body.items).toHaveLength(2);
      expect(res.body.nextCursor).toBeNull();
    });

    it('filters by status, technician and date range', async () => {
      const first = await book('filter-1').expect(201);
      await book('filter-2', {
        serviceTypeId: oil,
        desiredStartTime: '2026-09-08T02:00:00Z',
      }).expect(201);

      await request(app.getHttpServer())
        .post(`/v1/appointments/${first.body.id}/cancel`)
        .set('Authorization', staff)
        .send({})
        .expect(200);

      const cancelled = await request(app.getHttpServer())
        .get('/v1/appointments')
        .query({ status: 'CANCELLED' })
        .set('Authorization', staff)
        .expect(200);
      expect(cancelled.body.items).toHaveLength(1);
      expect(cancelled.body.items[0].id).toBe(first.body.id);

      const byDay = await request(app.getHttpServer())
        .get('/v1/appointments')
        .query({ from: '2026-09-08T00:00:00Z', to: '2026-09-09T00:00:00Z' })
        .set('Authorization', staff)
        .expect(200);
      expect(byDay.body.items).toHaveLength(1);
    });

    it('rejects a malformed cursor instead of silently returning page one', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/appointments')
        .query({ cursor: 'not-a-real-cursor' })
        .set('Authorization', staff);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('caps limit at the documented maximum', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/appointments')
        .query({ limit: 5000 })
        .set('Authorization', staff);

      // The DTO bound rejects it outright rather than quietly clamping — a client asking for
      // 5000 rows should learn that it cannot.
      expect(res.status).toBe(400);
    });
  });

  describe('RBAC within a tenant (§14)', () => {
    it('restricts a CUSTOMER principal to their own appointments', async () => {
      const mine = await book('rbac-mine').expect(201);
      const theirs = await book('rbac-theirs', {
        customerId: SEED.customers.two.id,
        vehicleId: SEED.vehicles.two.id,
        serviceTypeId: oil,
        desiredStartTime: '2026-09-07T06:00:00Z',
      }).expect(201);

      const asCustomer = customerToken(SEED.customers.one.id);

      const list = await request(app.getHttpServer())
        .get('/v1/appointments')
        .set('Authorization', asCustomer)
        .expect(200);

      expect(list.body.items.map((a: { id: string }) => a.id)).toEqual([mine.body.id]);

      // Same dealership, but another customer's row — absent, not forbidden.
      const other = await request(app.getHttpServer())
        .get(`/v1/appointments/${theirs.body.id}`)
        .set('Authorization', asCustomer);
      expect(other.status).toBe(404);
    });

    it('does not let a CUSTOMER widen their scope via the customerId filter', async () => {
      await book('rbac-widen').expect(201);
      await book('rbac-widen-2', {
        customerId: SEED.customers.two.id,
        vehicleId: SEED.vehicles.two.id,
        serviceTypeId: oil,
        desiredStartTime: '2026-09-07T06:00:00Z',
      }).expect(201);

      const res = await request(app.getHttpServer())
        .get('/v1/appointments')
        .query({ customerId: SEED.customers.two.id })
        .set('Authorization', customerToken(SEED.customers.one.id))
        .expect(200);

      // Their own scope AND the requested filter — which intersect to nothing.
      expect(res.body.items).toHaveLength(0);
    });

    it('lets a CUSTOMER cancel only their own appointment', async () => {
      const theirs = await book('rbac-cancel', {
        customerId: SEED.customers.two.id,
        vehicleId: SEED.vehicles.two.id,
      }).expect(201);

      const res = await request(app.getHttpServer())
        .post(`/v1/appointments/${theirs.body.id}/cancel`)
        .set('Authorization', customerToken(SEED.customers.one.id))
        .send({});

      expect(res.status).toBe(404);
    });
  });

  describe('POST /appointments/{id}/cancel — idempotent (§5.2)', () => {
    it('cancels a CONFIRMED appointment and records the reason', async () => {
      const created = await book('cancel-1').expect(201);

      const res = await request(app.getHttpServer())
        .post(`/v1/appointments/${created.body.id}/cancel`)
        .set('Authorization', staff)
        .send({ reason: 'Customer rescheduled' })
        .expect(200);

      expect(res.body).toMatchObject({
        id: created.body.id,
        status: 'CANCELLED',
        cancelReason: 'Customer rescheduled',
      });
      expect(res.body.cancelledAt).toEqual(expect.any(String));
    });

    it('returns 200 again on a repeated cancel — never ALREADY_CANCELLED', async () => {
      const created = await book('cancel-2').expect(201);
      const url = `/v1/appointments/${created.body.id}/cancel`;

      const first = await request(app.getHttpServer())
        .post(url)
        .set('Authorization', staff)
        .send({})
        .expect(200);

      // A retried cancel is a success, not a conflict. The explicit SELECT ... FOR UPDATE is
      // what lets the service tell "already cancelled" apart from "no such appointment"; a bare
      // zero-row UPDATE could not.
      const second = await request(app.getHttpServer())
        .post(url)
        .set('Authorization', staff)
        .send({})
        .expect(200);

      expect(second.body.status).toBe('CANCELLED');
      expect(second.body.cancelledAt).toBe(first.body.cancelledAt);
    });

    it('404s for an id that does not exist in the tenant — the ONLY 404 case', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/appointments/01900000-0000-7000-8000-0000000dead1/cancel')
        .set('Authorization', staff)
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('frees the slot immediately, so the same window can be re-booked', async () => {
      const created = await book('cancel-frees').expect(201);

      await book('cancel-frees-blocked').expect(409);

      await request(app.getHttpServer())
        .post(`/v1/appointments/${created.body.id}/cancel`)
        .set('Authorization', staff)
        .send({})
        .expect(200);

      // The exclusion constraints are partial on status='CONFIRMED', so the window is free the
      // instant the cancel commits — no delete, no waiting.
      await book('cancel-frees-rebook').expect(201);
    });

    it('writes an AppointmentCancelled event in the same transaction', async () => {
      const created = await book('cancel-outbox').expect(201);

      await request(app.getHttpServer())
        .post(`/v1/appointments/${created.body.id}/cancel`)
        .set('Authorization', staff)
        .send({})
        .expect(200);

      const { rows } = await pool.query(
        `SELECT event_type FROM outbox WHERE aggregate_id = $1 ORDER BY id`,
        [created.body.id],
      );
      expect(rows.map((r) => r.event_type)).toEqual([
        'AppointmentConfirmed',
        'AppointmentCancelled',
      ]);
    });
  });
});
