import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { SEED, seed } from '../../prisma/seed';
import { createTestApp, staffToken } from '../support/app';
import { createPool, createPrisma, resetAppointments } from '../support/db';
import type { PrismaClient } from '../../generated/prisma/client';

/**
 * The error catalog end to end (§7.1). One test per code, asserting the *distinctions* the
 * catalog draws — several of which are easy to collapse by accident:
 *
 *   404 vs 403  — an out-of-tenant reference must not reveal that it exists.
 *   422 vs 409  — a deterministic pre-check failure is not a state conflict.
 *   OUTSIDE_WORKING_HOURS vs NO_AVAILABILITY — dealership opening hours are a property of the
 *                 request (422); a technician's own shift is a per-technician availability fact
 *                 and yields 409.
 */
describe('booking error catalog (§7.1)', () => {
  let app: INestApplication;
  let pool: Pool;
  let prisma: PrismaClient;

  const token = staffToken();
  const brakes = SEED.serviceTypes.brakeInspection.id;
  const oil = SEED.serviceTypes.oilChange.id;

  /** Monday 09:00 local (Asia/Ho_Chi_Minh, UTC+7) — comfortably inside opening hours. */
  const VALID_SLOT = '2026-09-07T02:00:00Z';

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

  const post = (body: unknown, key: string, auth: string = token): request.Test =>
    request(app.getHttpServer())
      .post('/v1/appointments')
      .set('Authorization', auth)
      .set('Idempotency-Key', key)
      .send(body as object);

  const validBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    customerId: SEED.customers.one.id,
    vehicleId: SEED.vehicles.one.id,
    serviceTypeId: brakes,
    desiredStartTime: VALID_SLOT,
    ...overrides,
  });

  describe('400 VALIDATION_ERROR', () => {
    it('rejects a missing Idempotency-Key header', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/appointments')
        .set('Authorization', token)
        .send(validBody());

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a start time in the past', async () => {
      const res = await post(validBody({ desiredStartTime: '2020-01-01T02:00:00Z' }), 'past-1');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.details.field).toBe('desiredStartTime');
    });

    it('rejects a malformed uuid', async () => {
      const res = await post(validBody({ customerId: 'not-a-uuid' }), 'bad-uuid-1');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.details.fieldErrors).toEqual(expect.arrayContaining([expect.any(String)]));
    });

    it('rejects a body that tries to name its own dealership — the tenant is not a request field', async () => {
      // forbidNonWhitelisted turns this into a 400 rather than silently stripping it, so a
      // client attempting cross-tenant booking learns it is impossible instead of being
      // quietly redirected to its own tenant (§7, §14).
      const res = await post(
        validBody({ dealershipId: SEED.otherDealership.id }),
        'tenant-in-body-1',
      );

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects an attempt to dictate the appointment duration', async () => {
      const res = await post(validBody({ endTime: '2026-09-07T23:00:00Z' }), 'duration-1');
      expect(res.status).toBe(400);
    });
  });

  describe('404 NOT_FOUND — including out-of-tenant, with no existence leak (§14)', () => {
    it.each([
      ['customer', { customerId: '01900000-0000-7000-8000-0000000dead1' }],
      ['vehicle', { vehicleId: '01900000-0000-7000-8000-0000000dead2' }],
      ['service type', { serviceTypeId: '01900000-0000-7000-8000-0000000dead3' }],
    ])('reports a non-existent %s as 404', async (label, override) => {
      const res = await post(validBody(override), `missing-${label.replace(' ', '-')}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it.each([
      ['customer', () => ({ customerId: SEED.otherTenant.customerId })],
      ['vehicle', () => ({ vehicleId: SEED.otherTenant.vehicleId })],
      ['service type', () => ({ serviceTypeId: SEED.otherTenant.serviceTypeId })],
    ])(
      'reports another dealership’s %s as 404 — identical to "does not exist"',
      async (label, override) => {
        const res = await post(validBody(override()), `cross-${label.replace(' ', '-')}`);

        // 404 and not 403: a different status would confirm the row exists somewhere, which is
        // precisely the leak the design forbids.
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('NOT_FOUND');
      },
    );
  });

  describe('422 VEHICLE_OWNERSHIP_MISMATCH', () => {
    it('rejects a vehicle that exists in the tenant but belongs to another customer', async () => {
      const res = await post(
        validBody({
          customerId: SEED.customers.one.id,
          vehicleId: SEED.vehicles.two.id, // owned by customer two
        }),
        'ownership-1',
      );

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VEHICLE_OWNERSHIP_MISMATCH');
    });
  });

  describe('422 NO_QUALIFIED_TECHNICIAN — a configuration miss, not a busy resource', () => {
    it('fires when NO technician holds the required skills at all', async () => {
      const exotic = '01900000-0000-7000-8000-00000000cc55';
      await pool.query(
        `INSERT INTO service_types (id, dealership_id, name, duration_minutes, required_skills)
         VALUES ($1,$2,'Transmission Rebuild',120,'{transmission}')
         ON CONFLICT (id) DO NOTHING`,
        [exotic, SEED.dealership.id],
      );

      const res = await post(validBody({ serviceTypeId: exotic }), 'unqualified-1');

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('NO_QUALIFIED_TECHNICIAN');
      expect(res.body.details.requiredSkills).toEqual(['transmission']);
    });

    it('does NOT fire when a qualified technician exists but is busy — that is 409', async () => {
      await post(validBody(), 'busy-win').expect(201);
      const res = await post(validBody(), 'busy-lose');

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NO_AVAILABILITY');
    });
  });

  describe('422 OUTSIDE_WORKING_HOURS — dealership opening hours only', () => {
    it('rejects a Sunday, when the dealership is closed', async () => {
      // 2026-09-13 is a Sunday; 02:00Z = 09:00 local.
      const res = await post(validBody({ desiredStartTime: '2026-09-13T02:00:00Z' }), 'sunday-1');

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('OUTSIDE_WORKING_HOURS');
    });

    it('rejects a window before opening', async () => {
      // 2026-09-07T00:00Z = 07:00 local, before the 08:00 open.
      const res = await post(validBody({ desiredStartTime: '2026-09-07T00:00:00Z' }), 'early-1');

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('OUTSIDE_WORKING_HOURS');
    });

    it('rejects a window that would overrun closing time', async () => {
      // 17:00 local + 90min Brake Inspection = 18:30, past the 18:00 close.
      const res = await post(validBody({ desiredStartTime: '2026-09-07T10:00:00Z' }), 'late-1');

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('OUTSIDE_WORKING_HOURS');
    });

    it('accepts a window ending exactly at closing time — half-open [start, end)', async () => {
      // 16:30 local + 90min = exactly 18:00.
      const res = await post(validBody({ desiredStartTime: '2026-09-07T09:30:00Z' }), 'edge-1');
      expect(res.status).toBe(201);
    });

    it('returns 409, NOT 422, when the window is inside opening hours but no technician is free', async () => {
      // The distinction §7.1 draws explicitly. A technician's own shift is per-technician
      // availability, so it belongs in the allocation loop's answer, not the pre-check's.
      await post(validBody(), 'distinct-win').expect(201);

      const res = await post(validBody(), 'distinct-lose');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NO_AVAILABILITY');
    });
  });

  describe('422 IDEMPOTENCY_KEY_REUSE', () => {
    it('rejects a known key presented with a different body', async () => {
      await post(validBody(), 'reuse-1').expect(201);

      const res = await post(validBody({ serviceTypeId: oil }), 'reuse-1');

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSE');
    });

    it('treats a body with reordered keys as the SAME request — canonical JSON, not byte order', async () => {
      // RFC 8785 (JCS) canonicalization exists precisely so a client that serialises its keys in
      // a different order is not punished with a spurious 422 (§7).
      const first = await post(validBody(), 'jcs-1').expect(201);

      const reordered = {
        desiredStartTime: VALID_SLOT,
        serviceTypeId: brakes,
        vehicleId: SEED.vehicles.one.id,
        customerId: SEED.customers.one.id,
      };
      const second = await post(reordered, 'jcs-1');

      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);
    });
  });

  describe('403 FORBIDDEN — authentication, never cross-tenant references', () => {
    it.each([
      ['no Authorization header', undefined],
      ['a malformed token', 'Bearer not-base64'],
      [
        'a token with no dealership claim',
        `Bearer ${Buffer.from('{"role":"STAFF"}').toString('base64url')}`,
      ],
    ])('rejects %s', async (_label, auth) => {
      const req = request(app.getHttpServer())
        .post('/v1/appointments')
        .set('Idempotency-Key', 'auth-1');
      if (auth) req.set('Authorization', auth);

      const res = await req.send(validBody());

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });
  });

  describe('the error envelope itself (§7.1)', () => {
    it('always carries {code, message, details, correlationId}', async () => {
      const res = await post(validBody({ desiredStartTime: '2020-01-01T02:00:00Z' }), 'envelope-1');

      expect(res.body).toEqual({
        code: expect.any(String),
        message: expect.any(String),
        details: expect.any(Object),
        correlationId: expect.any(String),
      });
    });

    it('echoes a client-supplied correlation id so a caller can stitch its own trace', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/appointments')
        .set('Authorization', token)
        .set('Idempotency-Key', 'corr-1')
        .set('x-correlation-id', 'client-trace-abc')
        .send(validBody({ desiredStartTime: '2020-01-01T02:00:00Z' }));

      expect(res.body.correlationId).toBe('client-trace-abc');
      expect(res.headers['x-correlation-id']).toBe('client-trace-abc');
    });

    it('never leaks internals on an unexpected failure', async () => {
      // A syntactically valid but non-existent uuid takes the ordinary 404 path; the assertion
      // that matters is that no stack trace or SQL ever reaches the client.
      const res = await post(
        validBody({ customerId: '01900000-0000-7000-8000-0000000dead9' }),
        'leak-1',
      );

      const serialised = JSON.stringify(res.body);
      expect(serialised).not.toMatch(/select|insert|pg_|prisma|at Object\./i);
    });
  });
});
