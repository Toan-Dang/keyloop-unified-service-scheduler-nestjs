import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../common/metrics/metrics.service';
import { runWithCorrelationId } from '../common/correlation/correlation';
import type { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import {
  NOTIFICATION_PUBLISHER,
  type NotificationEvent,
  type NotificationPublisher,
} from './notification-publisher.port';

interface OutboxRow {
  id: string;
  dealershipId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
}

/**
 * The outbox relay (ADR-006, db §2.8).
 *
 * The sequence is **lease → commit → publish → mark**, and each arrow is deliberate:
 *
 *  1. **Lease, don't just lock.** The claim pushes `available_at` forward inside a short
 *     `FOR UPDATE SKIP LOCKED` transaction. Merely locking would not survive the commit: the
 *     moment the lock is released the row is still `PENDING` with `available_at <= now()`, so a
 *     second relay instance would re-publish it as *normal operation*, not just after a crash.
 *     The lease makes the claim durable rather than lock-scoped.
 *  2. **Commit before publishing.** Holding a transaction open across a network publish would pin
 *     a database connection for the broker's latency.
 *  3. **Mark each event individually.** Marking the batch as a unit would let one slow or failing
 *     event strand every other event in it.
 *
 * `attempts` counts **failures only** — leasing never touches it. Conflating the two would drift
 * a healthy but repeatedly-leased row toward the `FAILED` cap with nothing actually wrong (this
 * is one of the corrections recorded in §16.2).
 *
 * A crash mid-publish simply lets the lease expire, and another relay retries: at-least-once,
 * with consumers deduping on `event_id`.
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly config: AppConfig['outbox'];
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    @Inject(NOTIFICATION_PUBLISHER) private readonly publisher: NotificationPublisher,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<AppConfig['outbox']>('outbox');
  }

  onModuleInit(): void {
    if (!this.config.relayEnabled) {
      this.logger.log('Outbox relay disabled by configuration');
      return;
    }
    this.schedule();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, this.config.pollIntervalMs);
    // Never hold the process open just to poll.
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    // A slow batch must not overlap the next tick and double-publish.
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      await this.drainOnce();
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Outbox relay tick failed',
      );
    } finally {
      this.running = false;
    }
  }

  /** One poll: claim a batch, publish each event, mark it. Returns how many were published. */
  async drainOnce(): Promise<number> {
    const claimed = await this.claimBatch();
    if (claimed.length === 0) {
      await this.refreshBacklogGauge();
      return 0;
    }

    let published = 0;
    for (const row of claimed) {
      const delivered = await this.publishOne(row);
      if (delivered) published += 1;
    }

    await this.refreshBacklogGauge();
    return published;
  }

  /**
   * Claims a batch by leasing it: one short transaction that pushes `available_at` forward and
   * commits. `SKIP LOCKED` keeps concurrent relays from contending *during* the claim; pushing
   * `available_at` is what keeps them apart *after* it.
   */
  private async claimBatch(): Promise<OutboxRow[]> {
    return this.prisma.$queryRawUnsafe<OutboxRow[]>(
      `
      UPDATE outbox
         SET available_at = now() + ($1 || ' seconds')::interval
       WHERE id IN (
         SELECT id FROM outbox
          WHERE status = 'PENDING' AND available_at <= now()
          ORDER BY id                      -- uuidv7 is time-ordered, so this is insertion order
            FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
      RETURNING id,
                dealership_id  AS "dealershipId",
                aggregate_type AS "aggregateType",
                aggregate_id   AS "aggregateId",
                event_type     AS "eventType",
                payload,
                attempts,
                created_at     AS "createdAt"
      `,
      String(this.config.leaseSeconds),
      this.config.batchSize,
    );
  }

  private async publishOne(row: OutboxRow): Promise<boolean> {
    const event: NotificationEvent = {
      eventId: row.id,
      eventType: row.eventType,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      dealershipId: row.dealershipId,
      payload: row.payload,
      occurredAt: row.createdAt,
    };

    // The booking's correlation id rides on the payload, so an async notification's logs join up
    // with the request that caused it (§13).
    const correlationId =
      typeof row.payload.correlationId === 'string' ? row.payload.correlationId : row.id;

    try {
      await runWithCorrelationId(correlationId, () => this.publisher.publish(event));
      await this.markSent(row.id);
      this.metrics.outboxPublishedTotal.inc({ event_type: row.eventType });
      return true;
    } catch (err) {
      await this.recordFailure(row, err);
      return false;
    }
  }

  private async markSent(id: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE outbox SET status = 'SENT', published_at = now() WHERE id = $1::uuid`,
      id,
    );
  }

  /**
   * A real failure: bump `attempts`, back off exponentially, and give up into `FAILED` at the
   * cap — the database equivalent of a dead-letter queue, kept for inspection rather than
   * silently dropped.
   */
  private async recordFailure(row: OutboxRow, err: unknown): Promise<void> {
    const attempts = row.attempts + 1;
    const exhausted = attempts >= this.config.maxAttempts;

    this.metrics.notificationPublishFailuresTotal.inc({ event_type: row.eventType });
    if (exhausted) this.metrics.outboxDeadLetterTotal.inc({ event_type: row.eventType });

    await this.prisma.$executeRawUnsafe(
      `UPDATE outbox
          SET attempts = $2::smallint,
              status = $3::outbox_status,
              available_at = now() + ($4 || ' seconds')::interval
        WHERE id = $1::uuid`,
      row.id,
      attempts,
      exhausted ? 'FAILED' : 'PENDING',
      String(OutboxRelayService.backoffSeconds(attempts)),
    );

    this.logger[exhausted ? 'error' : 'warn'](
      {
        eventId: row.id,
        eventType: row.eventType,
        attempts,
        exhausted,
        err: err instanceof Error ? err.message : String(err),
      },
      exhausted
        ? 'Outbox event moved to FAILED (dead letter)'
        : 'Outbox publish failed, will retry',
    );
  }

  /**
   * Exponential backoff, capped: `least(2^attempts, 300)` seconds (db §2.8).
   *
   * Computed here rather than in SQL. The obvious inline form —
   * `attempts = $2, available_at = now() + (least(power(2, $2), 300) || ' seconds')::interval` —
   * does not work: PostgreSQL deduces one type per parameter, and using `$2` as both a smallint
   * and a `power()` argument fails with `42P08 inconsistent types deduced for parameter`.
   * Keeping it in TypeScript also puts the whole rule in one readable, directly testable place.
   */
  static backoffSeconds(attempts: number): number {
    return Math.min(2 ** attempts, 300);
  }

  /** `outbox_backlog` is the alarm signal for a stalled relay (§13). */
  private async refreshBacklogGauge(): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<{ pending: number }[]>(
      `SELECT count(*)::int AS pending FROM outbox WHERE status = 'PENDING'`,
    );
    this.metrics.outboxBacklog.set(rows[0]?.pending ?? 0);
  }
}
