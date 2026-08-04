import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { SEED, seed } from '../../prisma/seed';
import { createTestApp } from '../support/app';
import { createPool, createPrisma, resetAppointments } from '../support/db';
import { ReminderScheduler } from '../../src/notifications/reminder.scheduler';
import type { PrismaClient } from '../../generated/prisma/client';

/**
 * The T-24h reminder scan (§5.3).
 *
 * The interesting cases are all about *not* sending: not twice when two schedulers race, not at
 * all for short-notice bookings, not again once claimed.
 */
describe('reminder scheduler (§5.3)', () => {
  let app: INestApplication;
  let pool: Pool;
  let prisma: PrismaClient;
  let scheduler: ReminderScheduler;

  beforeAll(async () => {
    pool = createPool();
    prisma = createPrisma();
    await seed(prisma);
    // Cron off — the scan is invoked directly so the test does not wait on a 10-minute timer.
    app = await createTestApp({ reminderCron: false, outboxRelay: false });
    scheduler = app.get(ReminderScheduler);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await pool.end();
  });

  beforeEach(async () => {
    await resetAppointments(pool);
  });

  /**
   * Inserts a CONFIRMED appointment `hoursFromNow` in the future, bypassing the API so the test
   * can place it anywhere on the timeline (including inside opening hours it would not normally
   * satisfy — the reminder scan does not care about hours).
   */
  async function appointmentIn(
    hoursFromNow: number,
    {
      durationMinutes = 30,
      bay = SEED.bays.one.id,
    }: { durationMinutes?: number; bay?: string } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO appointments
         (dealership_id, customer_id, vehicle_id, service_type_id,
          technician_id, service_bay_id, start_time, end_time)
       VALUES ($1,$2,$3,$4,$5,$6,
               now() + ($7 || ' hours')::interval,
               now() + ($7 || ' hours')::interval + ($8 || ' minutes')::interval)
       RETURNING id`,
      [
        SEED.dealership.id,
        SEED.customers.one.id,
        SEED.vehicles.one.id,
        SEED.serviceTypes.brakeInspection.id,
        SEED.technicians.brakes.id,
        bay,
        String(hoursFromNow),
        String(durationMinutes),
      ],
    );
    return rows[0]!.id;
  }

  const outboxCount = async (): Promise<number> => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE event_type = 'AppointmentReminder'`,
    );
    return rows[0]!.n;
  };

  it('claims an appointment inside the T-24h band and enqueues one reminder', async () => {
    const id = await appointmentIn(23.5);

    expect(await scheduler.claimDueReminders()).toBe(1);
    expect(await outboxCount()).toBe(1);

    const { rows } = await pool.query<{ reminder_sent_at: Date | null }>(
      `SELECT reminder_sent_at FROM appointments WHERE id = $1`,
      [id],
    );
    expect(rows[0]!.reminder_sent_at).not.toBeNull();
  });

  it('is idempotent across repeated scans — the reminder_sent_at gate', async () => {
    await appointmentIn(23.5);

    expect(await scheduler.claimDueReminders()).toBe(1);
    expect(await scheduler.claimDueReminders()).toBe(0);
    expect(await scheduler.claimDueReminders()).toBe(0);

    expect(await outboxCount()).toBe(1);
  });

  /**
   * The reason the claim is a gate-first UPDATE rather than SELECT-then-UPDATE (§5.3).
   */
  it('sends exactly ONE reminder when two schedulers scan simultaneously', async () => {
    await appointmentIn(23.5);

    // `@nestjs/schedule` runs in every instance, so this is the real production shape, not a
    // contrived race. SELECT-then-UPDATE would let both read the row before either marked it.
    const [a, b] = await Promise.all([
      scheduler.claimDueReminders(),
      scheduler.claimDueReminders(),
    ]);

    expect(a + b).toBe(1);
    expect(await outboxCount()).toBe(1);
  });

  it('sends exactly one reminder per appointment under a wider stampede', async () => {
    // Short, non-overlapping windows spaced 6 minutes apart inside the 1-hour band. They must
    // not overlap each other, or the exclusion constraints would reject the FIXTURES — the same
    // invariant the rest of the suite exists to prove.
    for (let i = 0; i < 5; i += 1) {
      await appointmentIn(23.1 + i * 0.1, { durationMinutes: 5 });
    }

    const results = await Promise.all(
      Array.from({ length: 6 }, () => scheduler.claimDueReminders()),
    );

    expect(results.reduce((a, b) => a + b, 0)).toBe(5);
    expect(await outboxCount()).toBe(5);
  });

  describe('the band has a LOWER bound, not just a ceiling', () => {
    it('ignores a short-notice booking only hours away (R-7)', async () => {
      await appointmentIn(3);

      // A `<= now()+24h` ceiling would sweep this up and "remind" the customer about a booking
      // they made minutes ago. The confirmation already served as the reminder.
      expect(await scheduler.claimDueReminders()).toBe(0);
      expect(await outboxCount()).toBe(0);
    });

    it('ignores an appointment still beyond the band', async () => {
      await appointmentIn(48);
      expect(await scheduler.claimDueReminders()).toBe(0);
    });

    it('ignores an appointment in the past', async () => {
      await appointmentIn(-5);
      expect(await scheduler.claimDueReminders()).toBe(0);
    });
  });

  it('never reminds about a CANCELLED appointment', async () => {
    const id = await appointmentIn(23.5);
    await pool.query(`UPDATE appointments SET status='CANCELLED', cancelled_at=now() WHERE id=$1`, [
      id,
    ]);

    expect(await scheduler.claimDueReminders()).toBe(0);
    expect(await outboxCount()).toBe(0);
  });

  it('rolls the claim back if the outbox insert fails — a claim without an event loses it', async () => {
    const id = await appointmentIn(23.5);

    // Make the outbox insert fail for real, in the database, rather than by mocking a client.
    // Mocking would only prove that a rejected promise rejects; this proves the CLAIM and the
    // INSERT actually share a transaction boundary.
    await pool.query(`
      CREATE OR REPLACE FUNCTION reject_reminder_events() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type = 'AppointmentReminder' THEN
          RAISE EXCEPTION 'simulated outbox failure';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;

      CREATE TRIGGER reject_reminder_events_trg
        BEFORE INSERT ON outbox
        FOR EACH ROW EXECUTE FUNCTION reject_reminder_events();
    `);

    try {
      await expect(scheduler.claimDueReminders()).rejects.toThrow();

      // reminder_sent_at must NOT have stuck. Claiming without enqueuing would drop the reminder
      // forever, because that column gates every future scan.
      const { rows } = await pool.query<{ reminder_sent_at: Date | null }>(
        `SELECT reminder_sent_at FROM appointments WHERE id = $1`,
        [id],
      );
      expect(rows[0]!.reminder_sent_at).toBeNull();
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS reject_reminder_events_trg ON outbox`);
      await pool.query(`DROP FUNCTION IF EXISTS reject_reminder_events()`);
    }

    // With the fault removed, the appointment is still eligible and the reminder goes out.
    expect(await scheduler.claimDueReminders()).toBe(1);
    expect(await outboxCount()).toBe(1);
  });
});
