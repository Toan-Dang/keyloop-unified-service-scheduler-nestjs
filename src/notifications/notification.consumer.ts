import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { NotificationEvent } from './notification-publisher.port';

/**
 * The local notification consumer: stands in for the email side-effect (SES in production, a log
 * line here — §11.1).
 *
 * **Idempotent on `event_id`**, which is not optional. Outbox delivery is at-least-once by
 * construction: a relay that crashes between publishing and marking `SENT` will republish after
 * the lease expires. Consumers therefore must tolerate seeing an event twice, and ADR-006 makes
 * that the consumer's contract.
 *
 * The in-memory `Set` here is honest about its scope — it dedupes within one process, which is
 * all a single-process local run needs. A production consumer would dedupe against a durable
 * store (a processed-events table, or the idempotency features of the delivery provider).
 */
@Injectable()
export class NotificationConsumer {
  private readonly logger = new Logger(NotificationConsumer.name);
  private readonly handled = new Set<string>();
  private readonly deliveries: NotificationEvent[] = [];

  @OnEvent('AppointmentConfirmed')
  onConfirmed(event: NotificationEvent): void {
    if (this.alreadyHandled(event)) return;
    this.logger.log(
      {
        eventId: event.eventId,
        appointmentId: event.aggregateId,
        correlationId: event.payload.correlationId,
      },
      'Sending appointment confirmation (mock email transport)',
    );
  }

  @OnEvent('AppointmentCancelled')
  onCancelled(event: NotificationEvent): void {
    if (this.alreadyHandled(event)) return;
    this.logger.log(
      { eventId: event.eventId, appointmentId: event.aggregateId },
      'Sending cancellation notice (mock email transport)',
    );
  }

  @OnEvent('AppointmentReminder')
  onReminder(event: NotificationEvent): void {
    if (this.alreadyHandled(event)) return;
    this.logger.log(
      {
        eventId: event.eventId,
        appointmentId: event.aggregateId,
        startTime: event.payload.startTime,
      },
      'Sending T-24h reminder (mock email transport)',
    );
  }

  /** Test/inspection hook: what this consumer actually delivered, after dedupe. */
  delivered(): readonly NotificationEvent[] {
    return this.deliveries;
  }

  reset(): void {
    this.handled.clear();
    this.deliveries.length = 0;
  }

  private alreadyHandled(event: NotificationEvent): boolean {
    if (this.handled.has(event.eventId)) {
      this.logger.debug(
        { eventId: event.eventId },
        'Duplicate delivery ignored — at-least-once is expected, not exceptional',
      );
      return true;
    }
    this.handled.add(event.eventId);
    this.deliveries.push(event);
    return false;
  }
}
