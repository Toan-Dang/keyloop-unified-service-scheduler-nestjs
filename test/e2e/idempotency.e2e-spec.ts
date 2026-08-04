import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { SEED, seed } from '../../prisma/seed';
import { createTestApp, staffToken } from '../support/app';
import { createPool, createPrisma, resetAppointments } from '../support/db';
import type { PrismaClient } from '../../generated/prisma/client';

/**
 * Idempotency (§6.3) — and, more importantly, the *scope* of each tier.
 *
 * The durable guarantee is the `(dealership_id, idempotency_key)` unique index plus the
 * persisted `request_hash`. Redis is a fast path and nothing else. The final block here boots
 * the app against a dead Redis to prove exactly that: with the cache gone, duplicates are still
 * impossible and same-key/different-body is still a 422 (ADR-002, §10.1, db §5.4).
 */
describe('idempotency (§6.3)', () => {
  let app: INestApplication;
  let pool: Pool;
  let prisma: PrismaClient;

  const token = staffToken();
  const brakes = SEED.serviceTypes.brakeInspection.id;
  /** Monday 09:00 in Asia/Ho_Chi_Minh (UTC+7). */
  const SLOT = '2026-09-07T02:00:00Z';
  /** The same Monday, 10:00 in Europe/Berlin (CEST, UTC+2) — inside that tenant's hours. */
  const BERLIN_SLOT = '2026-09-07T08:00:00Z';

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

  const book = (
    target: INestApplication,
    key: string,
    body: Record<string, unknown> = {},
  ): request.Test =>
    request(target.getHttpServer())
      .post('/v1/appointments')
      .set('Authorization', token)
      .set('Idempotency-Key', key)
      .send({
        customerId: SEED.customers.one.id,
        vehicleId: SEED.vehicles.one.id,
        serviceTypeId: brakes,
        desiredStartTime: SLOT,
        ...body,
      });

  describe('retrying with the same key', () => {
    it('returns the ORIGINAL 201 and the same appointment, not a 200', async () => {
      const first = await book(app, 'retry-1').expect(201);
      const retry = await book(app, 'retry-1').expect(201);

      expect(retry.body).toEqual(first.body);

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM appointments');
      expect(rows[0].n).toBe(1);
    });

    it('survives many sequential retries without ever creating a second row', async () => {
      const first = await book(app, 'retry-many').expect(201);
      for (let i = 0; i < 5; i += 1) {
        const res = await book(app, 'retry-many').expect(201);
        expect(res.body.id).toBe(first.body.id);
      }

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM appointments');
      expect(rows[0].n).toBe(1);
    });

    it('collapses a burst of CONCURRENT retries of the same key to one appointment', async () => {
      // This is the race the in-loop 23505 handler exists for: several retries pass the durable
      // pre-check before any of them commits. Whoever loses the unique index replays the winner.
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => book(app, 'retry-concurrent')),
      );

      const ids = new Set(responses.map((r) => r.body.id));
      expect(responses.every((r) => r.status === 201)).toBe(true);
      expect(ids.size).toBe(1);

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM appointments');
      expect(rows[0].n).toBe(1);
    });

    it('emits exactly one outbox event no matter how many times the request is retried', async () => {
      await book(app, 'retry-outbox').expect(201);
      await book(app, 'retry-outbox').expect(201);
      await book(app, 'retry-outbox').expect(201);

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox');
      expect(rows[0].n).toBe(1);
    });
  });

  describe('the key is tenant-scoped', () => {
    it('lets a different dealership use the same key value without collision', async () => {
      await book(app, 'shared-key').expect(201);

      // The other tenant books its own resources with an identical key. Nothing may collide,
      // and neither may read the other's appointment (§6.3).
      //
      // Note the different instant: the other dealership is in Europe/Berlin, where SLOT (02:00Z)
      // is 04:00 local and outside opening hours. Opening hours are evaluated per dealership in
      // its own timezone, so "the same slot" is not the same wall clock for both tenants.
      const other = await request(app.getHttpServer())
        .post('/v1/appointments')
        .set('Authorization', staffToken(SEED.otherDealership.id))
        .set('Idempotency-Key', 'shared-key')
        .send({
          customerId: SEED.otherTenant.customerId,
          vehicleId: SEED.otherTenant.vehicleId,
          serviceTypeId: SEED.otherTenant.serviceTypeId,
          desiredStartTime: BERLIN_SLOT,
        });

      expect(other.status).toBe(201);

      const { rows } = await pool.query(
        `SELECT dealership_id, count(*)::int AS n FROM appointments GROUP BY 1 ORDER BY 1`,
      );
      expect(rows).toHaveLength(2);
    });
  });

  describe('a cached 409 expires — availability is time-sensitive', () => {
    it('re-runs allocation once the slot frees, rather than replaying a stale conflict forever', async () => {
      const winner = await book(app, 'conflict-win').expect(201);
      await book(app, 'conflict-lose').expect(409);

      // Free the slot, then retry with a FRESH key: a new booking attempt, not a retry of the
      // rejected one. The rejected key's own cache entry is deliberately short-lived (§6.3), but
      // a new request must see the freed slot immediately.
      await pool.query(
        `UPDATE appointments SET status='CANCELLED', cancelled_at=now() WHERE id=$1`,
        [winner.body.id],
      );

      await book(app, 'conflict-after-free').expect(201);
    });
  });

  /**
   * The claim under test: **Redis is not in the correctness path** (ADR-002, §10.1).
   */
  describe('with Redis unavailable', () => {
    let degraded: INestApplication;

    beforeAll(async () => {
      // A port nothing is listening on. The client is configured to fail fast rather than queue
      // offline commands, so every cache call errors and is swallowed.
      degraded = await createTestApp({ redisUrl: 'redis://127.0.0.1:6399' });
    });

    afterAll(async () => {
      await degraded.close();
    });

    it('still books successfully', async () => {
      await resetAppointments(pool);
      const res = await book(degraded, 'nocache-1');
      expect(res.status).toBe(201);
    });

    it('still refuses to create a duplicate for the same key', async () => {
      await resetAppointments(pool);
      const first = await book(degraded, 'nocache-dup').expect(201);
      const retry = await book(degraded, 'nocache-dup').expect(201);

      expect(retry.body.id).toBe(first.body.id);
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM appointments');
      expect(rows[0].n).toBe(1);
    });

    it('still rejects same-key/different-body with 422 — the hash lives on the ROW, not the cache', async () => {
      await resetAppointments(pool);
      await book(degraded, 'nocache-reuse').expect(201);

      const res = await book(degraded, 'nocache-reuse', {
        serviceTypeId: SEED.serviceTypes.oilChange.id,
      });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSE');
    });

    it('reports readiness as degraded, not not-ready — a Redis outage is not an outage', async () => {
      const res = await request(degraded.getHttpServer()).get('/ready');

      // 200, because bookings still work. Failing readiness here would turn a tolerable
      // degradation into a real outage (§13).
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
      expect(res.body.checks).toMatchObject({ database: 'up', redis: 'degraded' });
    });
  });
});
