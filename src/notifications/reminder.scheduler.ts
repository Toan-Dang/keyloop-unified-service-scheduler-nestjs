import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MetricsService } from '../common/metrics/metrics.service';
import { newCorrelationId } from '../common/correlation/correlation';
import type { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';

interface ClaimedReminder {
  id: string;
  dealershipId: string;
  customerId: string;
  startTime: Date;
  endTime: Date;
}

/**
 * The T-24h reminder scan (§5.3).
 *
 * **Gate-first**, and that is the whole design. `@nestjs/schedule` runs in *every* core instance,
 * so two schedulers can fire at once. `SELECT` the due rows and then `UPDATE` them would let both
 * instances read the same rows before either marks them — duplicate reminders. Instead a single
 * `UPDATE ... WHERE reminder_sent_at IS NULL ... RETURNING id` claims rows atomically: row locks
 * serialize the two updates and only one instance's update wins each row. The outbox insert is
 * for the returned ids in the *same* transaction.
 *
 * **The window is a band, not a ceiling.** `start_time BETWEEN now()+23h AND now()+24h`, not
 * `<= now()+24h` — a ceiling would sweep up every short-notice booking whose start is only hours
 * away and "remind" the customer immediately. Short-notice bookings (<24h out) deliberately get
 * no separate reminder; the confirmation serves as one (R-7).
 *
 * **The scan interval must be smaller than the band.** Every ~10 minutes against a 1-hour band
 * means each appointment is seen by several scans while inside it, so none can slip between runs.
 * The `reminder_sent_at IS NULL` gate makes those repeated scans idempotent.
 */
@Injectable()
export class ReminderScheduler {
  private readonly logger = new Logger(ReminderScheduler.name);
  private readonly config: AppConfig['reminder'];
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<AppConfig['reminder']>('reminder');
  }

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'appointment-reminders' })
  async scheduledScan(): Promise<void> {
    if (!this.config.enabled || this.running) return;
    this.running = true;
    try {
      const claimed = await this.claimDueReminders();
      if (claimed > 0) {
        this.logger.log({ claimed }, 'Enqueued T-24h reminders');
      }
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Reminder scan failed',
      );
    } finally {
      this.running = false;
    }
  }

  /** Returns how many reminders this instance claimed. Exposed so tests can drive it directly. */
  async claimDueReminders(): Promise<number> {
    const { leadHours, bandHours } = this.config;

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRawUnsafe<ClaimedReminder[]>(
        `
        UPDATE appointments
           SET reminder_sent_at = now(), updated_at = now()
         WHERE status = 'CONFIRMED'
           AND reminder_sent_at IS NULL
           AND start_time >= now() + ($1 || ' hours')::interval
           AND start_time <= now() + ($2 || ' hours')::interval
        RETURNING id,
                  dealership_id AS "dealershipId",
                  customer_id   AS "customerId",
                  start_time    AS "startTime",
                  end_time      AS "endTime"
        `,
        String(leadHours - bandHours),
        String(leadHours),
      );

      // Same transaction as the claim: if this insert fails, the claim rolls back too and the
      // rows stay eligible. Claiming without enqueuing would lose the reminder silently.
      for (const appointment of claimed) {
        await tx.$executeRawUnsafe(
          `INSERT INTO outbox (dealership_id, aggregate_type, aggregate_id, event_type, payload)
           VALUES ($1::uuid, 'appointment', $2::uuid, 'AppointmentReminder', $3::jsonb)`,
          appointment.dealershipId,
          appointment.id,
          JSON.stringify({
            appointmentId: appointment.id,
            dealershipId: appointment.dealershipId,
            customerId: appointment.customerId,
            startTime: appointment.startTime.toISOString(),
            endTime: appointment.endTime.toISOString(),
            correlationId: newCorrelationId(),
          }),
        );
      }

      this.metrics.reminderSentTotal.inc(claimed.length);
      return claimed.length;
    });
  }
}
