import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { SEED, seed } from '../../prisma/seed';
import { createTestApp, staffToken } from '../support/app';
import { createPool, createPrisma, resetAppointments } from '../support/db';
import { OutboxRelayService } from '../../src/notifications/outbox-relay.service';
import { NotificationConsumer } from '../../src/notifications/notification.consumer';
import {
  NOTIFICATION_PUBLISHER,
  type NotificationEvent,
  type NotificationPublisher,
} from '../../src/notifications/notification-publisher.port';
import type { PrismaClient } from '../../generated/prisma/client';

/**
 * The outbox relay (ADR-006, db §2.8).
 *
 * The relay is driven **explicitly** here rather than by waiting on its poll timer — a test that
 * sleeps on a background interval is slow and flaky, and proves less. The polling loop itself is
 * a two-line `setTimeout`; what needs proving is the lease/publish/mark protocol.
 */
describe('outbox relay (ADR-006)', () => {
  let app: INestApplication;
  let pool: Pool;
  let prisma: PrismaClient;
  let relay: OutboxRelayService;
  let consumer: NotificationConsumer;
  let publisher: NotificationPublisher;

  const staff = staffToken();

  beforeAll(async () => {
    pool = createPool();
    prisma = createPrisma();
    await seed(prisma);
    // The background timer stays off; every drain below is deliberate.
    app = await createTestApp({ outboxRelay: false });
    relay = app.get(OutboxRelayService);
    consumer = app.get(NotificationConsumer);
    publisher = app.get<NotificationPublisher>(NOTIFICATION_PUBLISHER);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await pool.end();
  });

  beforeEach(async () => {
    await resetAppointments(pool);
    consumer.reset();
    jest.restoreAllMocks();
  });

  const book = (key: string, start = '2026-09-07T02:00:00Z'): request.Test =>
    request(app.getHttpServer())
      .post('/v1/appointments')
      .set('Authorization', staff)
      .set('Idempotency-Key', key)
      .send({
        customerId: SEED.customers.one.id,
        vehicleId: SEED.vehicles.one.id,
        serviceTypeId: SEED.serviceTypes.brakeInspection.id,
        desiredStartTime: start,
      });

  async function outboxRow(id?: string): Promise<Record<string, unknown>> {
    const { rows } = await pool.query(
      id ? `SELECT * FROM outbox WHERE aggregate_id = $1` : `SELECT * FROM outbox`,
      id ? [id] : [],
    );
    return rows[0] as Record<string, unknown>;
  }

  describe('the happy path', () => {
    it('publishes a booking’s event exactly once and marks it SENT', async () => {
      const created = await book('relay-1').expect(201);

      const published = await relay.drainOnce();

      expect(published).toBe(1);
      const row = await outboxRow(created.body.id);
      expect(row.status).toBe('SENT');
      expect(row.published_at).not.toBeNull();
      // Untouched: leasing and publishing successfully are not failures (db §2.8).
      expect(row.attempts).toBe(0);

      const delivered = consumer.delivered();
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        eventType: 'AppointmentConfirmed',
        aggregateId: created.body.id,
      });
    });

    it('does not re-publish rows already marked SENT', async () => {
      await book('relay-2').expect(201);

      expect(await relay.drainOnce()).toBe(1);
      expect(await relay.drainOnce()).toBe(0);
      expect(consumer.delivered()).toHaveLength(1);
    });

    it('carries the booking’s correlation id onto the delivered event (§13)', async () => {
      await request(app.getHttpServer())
        .post('/v1/appointments')
        .set('Authorization', staff)
        .set('Idempotency-Key', 'relay-corr')
        .set('x-correlation-id', 'trace-relay-123')
        .send({
          customerId: SEED.customers.one.id,
          vehicleId: SEED.vehicles.one.id,
          serviceTypeId: SEED.serviceTypes.brakeInspection.id,
          desiredStartTime: '2026-09-07T02:00:00Z',
        })
        .expect(201);

      await relay.drainOnce();

      expect(consumer.delivered()[0]!.payload.correlationId).toBe('trace-relay-123');
    });
  });

  describe('lease-on-claim', () => {
    it('pushes available_at forward so a second relay will not re-pick the row mid-flight', async () => {
      await book('relay-lease').expect(201);

      // Claim without letting the publish complete, by making the publisher hang until released.
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      jest.spyOn(publisher, 'publish').mockImplementation(() => gate);

      const inFlight = relay.drainOnce();
      // Give the claim transaction time to commit.
      await new Promise((r) => setTimeout(r, 200));

      const leased = await pool.query<{ available_at: Date; status: string }>(
        `SELECT available_at, status FROM outbox`,
      );
      expect(leased.rows[0]!.status).toBe('PENDING');
      // Still PENDING, but no longer DUE — which is exactly what stops a second relay instance
      // from re-publishing it as normal operation rather than only after a crash.
      expect(leased.rows[0]!.available_at.getTime()).toBeGreaterThan(Date.now() + 20_000);

      const dueNow = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM outbox WHERE status='PENDING' AND available_at <= now()`,
      );
      expect(dueNow.rows[0]!.n).toBe('0');

      release();
      await inFlight;
    });

    it('claims nothing when every pending row is still leased', async () => {
      await book('relay-lease-2').expect(201);
      await pool.query(`UPDATE outbox SET available_at = now() + interval '30 seconds'`);

      expect(await relay.drainOnce()).toBe(0);
    });
  });

  describe('failure handling', () => {
    it('retries a failed publish instead of losing the event, and counts the failure', async () => {
      await book('relay-fail').expect(201);

      const spy = jest
        .spyOn(publisher, 'publish')
        .mockRejectedValueOnce(new Error('broker unavailable'));

      expect(await relay.drainOnce()).toBe(0);

      let row = await outboxRow();
      expect(row.status).toBe('PENDING'); // not lost
      expect(row.attempts).toBe(1); // a REAL failure, so attempts moves
      expect(spy).toHaveBeenCalledTimes(1);

      // Backoff pushed it into the future; clear it to simulate the wait elapsing.
      await pool.query(`UPDATE outbox SET available_at = now()`);

      expect(await relay.drainOnce()).toBe(1);
      row = await outboxRow();
      expect(row.status).toBe('SENT');
      expect(consumer.delivered()).toHaveLength(1);
    });

    it('backs off exponentially between attempts', async () => {
      await book('relay-backoff').expect(201);
      jest.spyOn(publisher, 'publish').mockRejectedValue(new Error('still down'));

      const delays: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        await pool.query(`UPDATE outbox SET available_at = now()`);
        await relay.drainOnce();
        const { rows } = await pool.query<{ delay: string }>(
          `SELECT extract(epoch FROM (available_at - now()))::int::text AS delay FROM outbox`,
        );
        delays.push(Number(rows[0]!.delay));
      }

      // 2^1, 2^2, 2^3 seconds — strictly increasing, capped at 300 (db §2.8).
      expect(delays[1]).toBeGreaterThan(delays[0]!);
      expect(delays[2]).toBeGreaterThan(delays[1]!);
      expect(Math.max(...delays)).toBeLessThanOrEqual(300);
    });

    it('moves an event to FAILED after the attempt cap — a dead letter, not a silent drop', async () => {
      await book('relay-dead').expect(201);
      jest.spyOn(publisher, 'publish').mockRejectedValue(new Error('permanently broken'));

      // One short of the cap, so the next failure crosses it.
      await pool.query(`UPDATE outbox SET attempts = 7, available_at = now()`);

      await relay.drainOnce();

      const row = await outboxRow();
      expect(row.status).toBe('FAILED');
      expect(row.attempts).toBe(8);

      // FAILED rows are never claimed again — they wait for a human.
      await pool.query(`UPDATE outbox SET available_at = now()`);
      expect(await relay.drainOnce()).toBe(0);
    });

    it('marks each event individually, so one bad event cannot strand the batch', async () => {
      const first = await book('relay-batch-1', '2026-09-07T02:00:00Z').expect(201);
      const second = await book('relay-batch-2', '2026-09-07T06:00:00Z').expect(201);

      // Fail only the second event; the first must still be delivered and marked.
      jest.spyOn(publisher, 'publish').mockImplementation((event: NotificationEvent) => {
        if (event.aggregateId === second.body.id) {
          return Promise.reject(new Error('this one fails'));
        }
        return Promise.resolve();
      });

      expect(await relay.drainOnce()).toBe(1);

      const rows = await pool.query<{ aggregate_id: string; status: string; attempts: number }>(
        `SELECT aggregate_id, status, attempts FROM outbox ORDER BY id`,
      );
      const byId = new Map(rows.rows.map((r) => [r.aggregate_id, r]));
      expect(byId.get(first.body.id)).toMatchObject({ status: 'SENT', attempts: 0 });
      expect(byId.get(second.body.id)).toMatchObject({ status: 'PENDING', attempts: 1 });
    });
  });

  describe('at-least-once delivery and consumer dedupe', () => {
    it('delivers once to the consumer even if the same event is published twice', async () => {
      const created = await book('relay-dupe').expect(201);
      await relay.drainOnce();

      // Simulate the crash-between-publish-and-mark case: the lease expires and another relay
      // legitimately republishes. The consumer must absorb it.
      await pool.query(`UPDATE outbox SET status='PENDING', published_at=NULL, available_at=now()`);
      await relay.drainOnce();

      const delivered = consumer.delivered();
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.aggregateId).toBe(created.body.id);
    });
  });

  describe('observability (§13)', () => {
    it('reports the pending backlog on /metrics', async () => {
      await book('relay-metrics-1', '2026-09-07T02:00:00Z').expect(201);
      await book('relay-metrics-2', '2026-09-07T06:00:00Z').expect(201);

      await relay.drainOnce();

      const res = await request(app.getHttpServer()).get('/metrics').expect(200);

      // The backlog gauge is absolute and must be zero once the relay has drained.
      expect(res.text).toMatch(/outbox_backlog 0/);

      // The counters are process-wide and accumulate across every test in this file, so assert
      // that they are present and non-zero rather than pinning an exact value — a fixed number
      // here would only be measuring test execution order.
      const published = /outbox_published_total\{event_type="AppointmentConfirmed"\} (\d+)/.exec(
        res.text,
      );
      expect(published).not.toBeNull();
      expect(Number(published![1])).toBeGreaterThanOrEqual(2);
    });
  });
});
