import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { SEED, seed } from '../../prisma/seed';
import { createTestApp, staffToken } from '../support/app';
import { createPool, createPrisma, resetAppointments } from '../support/db';
import type { PrismaClient } from '../../generated/prisma/client';

/**
 * `GET /availability` (§7.2) — advisory, and shares the booking path's rule.
 *
 * The load-bearing assertion is the last block: the preview and the booking outcome must agree.
 * If they could diverge, the preview would be worse than useless — it would be confidently wrong.
 */
describe('availability preview (§7.2)', () => {
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

  const preview = (query: Record<string, unknown>, auth = staff): request.Test =>
    request(app.getHttpServer()).get('/v1/availability').query(query).set('Authorization', auth);

  const book = (key: string, overrides: Record<string, unknown> = {}): request.Test =>
    request(app.getHttpServer())
      .post('/v1/appointments')
      .set('Authorization', staff)
      .set('Idempotency-Key', key)
      .send({
        customerId: SEED.customers.one.id,
        vehicleId: SEED.vehicles.one.id,
        serviceTypeId: brakes,
        desiredStartTime: '2026-09-07T02:00:00Z',
        ...overrides,
      });

  it('enumerates the dealership-LOCAL day, not the UTC day', async () => {
    const res = await preview({ serviceTypeId: oil, date: '2026-09-07' }).expect(200);

    expect(res.body.timezone).toBe('Asia/Ho_Chi_Minh');
    expect(res.body.slots.length).toBeGreaterThan(0);

    // Opening hours are 08:00–18:00 local = 01:00–11:00Z. Every slot must sit inside that, which
    // it would not if the day had been enumerated in UTC.
    for (const slot of res.body.slots) {
      const hourUtc = new Date(slot.startTime).getUTCHours();
      expect(hourUtc).toBeGreaterThanOrEqual(1);
      expect(hourUtc).toBeLessThan(11);
    }
  });

  it('reports bookable = min(free technicians, free bays), not the pair cross-product', async () => {
    // Oil Change: 2 qualified technicians × 2 bays = 4 candidate pairs, but only 2 bookable
    // slots, because a booking consumes one technician AND one bay (§7.2).
    const res = await preview({ serviceTypeId: oil, date: '2026-09-07' }).expect(200);

    const slot = res.body.slots.find((s: { startTime: string }) =>
      s.startTime.startsWith('2026-09-07T02:00'),
    );
    expect(slot.bookable).toBe(2);
  });

  it('reports 1 for a service only one technician can perform', async () => {
    const res = await preview({ serviceTypeId: brakes, date: '2026-09-07' }).expect(200);

    const slot = res.body.slots.find((s: { startTime: string }) =>
      s.startTime.startsWith('2026-09-07T02:00'),
    );
    expect(slot.bookable).toBe(1);
  });

  it('drops a slot to zero once its only qualified technician is booked', async () => {
    const before = await preview({ serviceTypeId: brakes, date: '2026-09-07' }).expect(200);
    expect(
      before.body.slots.some((s: { startTime: string }) =>
        s.startTime.startsWith('2026-09-07T02:00'),
      ),
    ).toBe(true);

    await book('avail-1').expect(201);

    const after = await preview({ serviceTypeId: brakes, date: '2026-09-07' }).expect(200);
    // 02:00Z is gone entirely (bookable 0 is filtered out), and so is every slot the 90-minute
    // window overlaps.
    expect(
      after.body.slots.some((s: { startTime: string }) =>
        s.startTime.startsWith('2026-09-07T02:00'),
      ),
    ).toBe(false);
  });

  it('returns no slots on a day the dealership is closed', async () => {
    // 2026-09-13 is a Sunday.
    const res = await preview({ serviceTypeId: oil, date: '2026-09-13' }).expect(200);
    expect(res.body.slots).toEqual([]);
  });

  it('honours granularityMinutes', async () => {
    const coarse = await preview({
      serviceTypeId: oil,
      date: '2026-09-07',
      granularityMinutes: 60,
    }).expect(200);
    const fine = await preview({
      serviceTypeId: oil,
      date: '2026-09-07',
      granularityMinutes: 30,
    }).expect(200);

    expect(fine.body.slots.length).toBeGreaterThan(coarse.body.slots.length);
    for (const slot of coarse.body.slots) {
      expect(new Date(slot.startTime).getUTCMinutes()).toBe(0);
    }
  });

  it('404s for a service type belonging to another dealership', async () => {
    const res = await preview({
      serviceTypeId: SEED.otherTenant.serviceTypeId,
      date: '2026-09-07',
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it.each([
    ['a missing serviceTypeId', { date: '2026-09-07' }],
    [
      'a malformed date',
      { serviceTypeId: '01900000-0000-7000-8000-00000000cc02', date: '07-09-2026' },
    ],
    [
      'an out-of-range granularity',
      {
        serviceTypeId: '01900000-0000-7000-8000-00000000cc02',
        date: '2026-09-07',
        granularityMinutes: 1,
      },
    ],
  ])('400s on %s', async (_label, query) => {
    const res = await preview(query);
    expect(res.status).toBe(400);
  });

  /**
   * The claim that makes this endpoint worth having: preview and booking share `findCandidates`,
   * so they cannot disagree about what "available" means.
   */
  describe('preview agrees with the booking outcome', () => {
    it('every slot the preview offers can actually be booked', async () => {
      const res = await preview({ serviceTypeId: brakes, date: '2026-09-07' }).expect(200);

      // Take a few well-separated slots so the 90-minute windows do not consume each other.
      const candidates = res.body.slots
        .filter((_: unknown, i: number) => i % 4 === 0)
        .slice(0, 3) as { startTime: string; bookable: number }[];

      expect(candidates.length).toBeGreaterThan(0);

      for (const [i, slot] of candidates.entries()) {
        await resetAppointments(pool);
        const booked = await book(`agree-${i}`, { desiredStartTime: slot.startTime });
        expect(booked.status).toBe(201);
      }
    });

    it('offers nothing at a slot the booking path rejects as outside hours', async () => {
      // 17:00 local + 90 min overruns the 18:00 close, so booking answers 422. The preview must
      // not advertise it.
      const late = '2026-09-07T10:00:00Z';
      await book('agree-late', { desiredStartTime: late }).expect(422);

      const res = await preview({ serviceTypeId: brakes, date: '2026-09-07' }).expect(200);
      expect(res.body.slots.some((s: { startTime: string }) => s.startTime === late)).toBe(false);
    });
  });
});
