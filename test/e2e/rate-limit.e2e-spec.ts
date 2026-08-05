import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { seed } from '../../prisma/seed';
import { createTestApp, staffToken } from '../support/app';
import { createPrisma } from '../support/db';
import type { PrismaClient } from '../../generated/prisma/client';

/**
 * Rate limiting on the appointment-mutating routes (§7.1, `429 RATE_LIMITED`).
 *
 * Throttling is off by default under NODE_ENV=test (`loadConfiguration` / `createTestApp`) so
 * every other suite's parallel bursts and retry loops — the concurrency suite's whole reason for
 * existing — are never perturbed by it. This suite explicitly opts back in, the same way the
 * idempotency suite opts into a dead Redis for its own scenario, to prove the throttle itself
 * actually fires rather than only asserting a status-code mapping exists.
 */
describe('rate limiting (§7.1)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  const token = staffToken();

  beforeAll(async () => {
    prisma = createPrisma();
    await seed(prisma);
    app = await createTestApp({ rateLimitEnabled: true });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('returns 429 RATE_LIMITED with a Retry-After header once the write-path limit is exceeded', async () => {
    // write-throttle.ts allows 20 requests / 10s on this route. Cancelling a random,
    // never-created id still runs every guard ahead of the handler's own 404, so the limiter can
    // be exercised without booking real state.
    const responses = await Promise.all(
      Array.from({ length: 25 }, () =>
        request(app.getHttpServer())
          .post(`/v1/appointments/${randomUUID()}/cancel`)
          .set('Authorization', token)
          .send({}),
      ),
    );

    const limited = responses.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    // The requests that got through still ran the real handler and got a real 404 — the limiter
    // rejects *some* requests, not the route itself.
    expect(responses.filter((r) => r.status === 404).length).toBeGreaterThan(0);

    const first = limited.at(0);
    expect(first).toBeDefined();
    expect(first?.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(first?.body.correlationId).toEqual(expect.any(String));
    expect(first?.headers).toHaveProperty('retry-after');
  });

  it('does not throttle GET routes under the same tight write-path limit', async () => {
    const responses = await Promise.all(
      Array.from({ length: 25 }, () =>
        request(app.getHttpServer())
          .get('/v1/appointments')
          .set('Authorization', token)
          .query({ limit: 1 }),
      ),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
  });
});
