import { Module } from '@nestjs/common';
import { InProcessNotificationPublisher } from './in-process.publisher';
import { NOTIFICATION_PUBLISHER } from './notification-publisher.port';
import { NotificationConsumer } from './notification.consumer';
import { OutboxRelayService } from './outbox-relay.service';
import { ReminderScheduler } from './reminder.scheduler';

/**
 * The asynchronous tail (§4, ADR-005/006).
 *
 * The binding below is the entire environment switch: replacing
 * `InProcessNotificationPublisher` with an SNS adapter changes this line and nothing else in the
 * codebase. Note the honest scope though (§11.1) — only the *publish* step is a behind-the-port
 * swap. The relay becomes a scheduled poller or Debezium CDC, and the scheduler becomes
 * EventBridge; those are infrastructure substitutions, not adapter changes.
 */
@Module({
  providers: [
    { provide: NOTIFICATION_PUBLISHER, useClass: InProcessNotificationPublisher },
    OutboxRelayService,
    NotificationConsumer,
    ReminderScheduler,
  ],
  exports: [NOTIFICATION_PUBLISHER, OutboxRelayService, NotificationConsumer, ReminderScheduler],
})
export class NotificationsModule {}
