import { Injectable } from '@nestjs/common';
import {
  Counter,
  type CounterConfiguration,
  Gauge,
  Histogram,
  type HistogramConfiguration,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * RED (Rate, Errors, Duration) for the request path plus the domain gauges named in §13.
 * Held in a private Registry so tests can instantiate the service without global-state bleed.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** Rate + Errors. */
  readonly httpRequestsTotal: Counter<'route' | 'method' | 'status'>;
  /** Duration. */
  readonly httpRequestDuration: Histogram<'route' | 'method' | 'status'>;

  /** Domain — booking outcomes. */
  readonly bookingAttemptsTotal: Counter<string>;
  readonly bookingConfirmedTotal: Counter<string>;
  readonly bookingConflictsTotal: Counter<'reason'>;
  /** How many savepoint attempts a booking burned before settling — the contention signal. */
  readonly bookingCandidateAttempts: Histogram<'outcome'>;
  readonly bookingDeadlockRetriesTotal: Counter<string>;

  readonly availabilityCheckSeconds: Histogram<string>;
  readonly bookingTransactionSeconds: Histogram<'outcome'>;

  /** Domain — async tail. */
  readonly notificationPublishFailuresTotal: Counter<'event_type'>;
  readonly outboxBacklog: Gauge<string>;
  readonly outboxDeadLetterTotal: Counter<'event_type'>;
  readonly outboxPublishedTotal: Counter<'event_type'>;
  readonly reminderSentTotal: Counter<string>;

  constructor() {
    collectDefaultMetrics({ register: this.registry });

    const counter = <T extends string>(config: CounterConfiguration<T>): Counter<T> =>
      new Counter({ ...config, registers: [this.registry] });
    const histogram = <T extends string>(config: HistogramConfiguration<T>): Histogram<T> =>
      new Histogram({ ...config, registers: [this.registry] });

    this.httpRequestsTotal = counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests by route and status',
      labelNames: ['route', 'method', 'status'] as const,
    });

    this.httpRequestDuration = histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['route', 'method', 'status'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2, 5],
    });

    this.bookingAttemptsTotal = counter({
      name: 'booking_attempts_total',
      help: 'Booking requests that reached the allocation path',
    });

    this.bookingConfirmedTotal = counter({
      name: 'booking_confirmed_total',
      help: 'Bookings that produced a CONFIRMED appointment',
    });

    this.bookingConflictsTotal = counter({
      name: 'booking_conflicts_total',
      help: 'Bookings rejected because no candidate pair could be allocated',
      labelNames: ['reason'] as const,
    });

    this.bookingCandidateAttempts = histogram({
      name: 'booking_candidate_attempts',
      help: 'Candidate (technician, bay) pairs tried inside one allocation transaction',
      labelNames: ['outcome'] as const,
      buckets: [1, 2, 3, 4, 5, 8, 13, 21, 34],
    });

    this.bookingDeadlockRetriesTotal = counter({
      name: 'booking_deadlock_retries_total',
      help: 'Whole-transaction restarts triggered by SQLSTATE 40P01',
    });

    this.availabilityCheckSeconds = histogram({
      name: 'availability_check_seconds',
      help: 'Duration of the findCandidates availability query',
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    });

    this.bookingTransactionSeconds = histogram({
      name: 'booking_transaction_seconds',
      help: 'Duration of the whole allocation transaction',
      labelNames: ['outcome'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2, 5, 10],
    });

    this.notificationPublishFailuresTotal = counter({
      name: 'notification_publish_failures_total',
      help: 'Failed publishes through the NotificationPublisher port',
      labelNames: ['event_type'] as const,
    });

    this.outboxBacklog = new Gauge({
      name: 'outbox_backlog',
      help: 'Outbox rows still PENDING',
      registers: [this.registry],
    });

    this.outboxDeadLetterTotal = counter({
      name: 'outbox_dead_letter_total',
      help: 'Outbox rows moved to FAILED after exhausting the attempt budget',
      labelNames: ['event_type'] as const,
    });

    this.outboxPublishedTotal = counter({
      name: 'outbox_published_total',
      help: 'Outbox rows successfully published and marked SENT',
      labelNames: ['event_type'] as const,
    });

    this.reminderSentTotal = counter({
      name: 'reminder_sent_total',
      help: 'T-24h reminders claimed and enqueued',
    });
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
