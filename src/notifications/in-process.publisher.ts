import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { NotificationEvent, NotificationPublisher } from './notification-publisher.port';

/**
 * The **local** adapter behind the port (ADR-005): an in-process `@nestjs/event-emitter` bus.
 *
 * This is what lets the whole system run with `docker compose up` and nothing else — no AWS
 * account, no LocalStack. In production this class is replaced by an SNS publisher and nothing
 * upstream changes.
 *
 * `emitAsync` matters: it awaits every listener, so a listener that throws surfaces here as a
 * rejection and the relay records a real failure. Fire-and-forget `emit` would report success
 * for an event nobody managed to handle.
 */
@Injectable()
export class InProcessNotificationPublisher implements NotificationPublisher {
  private readonly logger = new Logger(InProcessNotificationPublisher.name);

  constructor(private readonly emitter: EventEmitter2) {}

  async publish(event: NotificationEvent): Promise<void> {
    const results = await this.emitter.emitAsync(event.eventType, event);

    this.logger.debug(
      {
        eventId: event.eventId,
        eventType: event.eventType,
        listeners: results.length,
        correlationId: event.payload.correlationId,
      },
      'Published notification event',
    );
  }
}
