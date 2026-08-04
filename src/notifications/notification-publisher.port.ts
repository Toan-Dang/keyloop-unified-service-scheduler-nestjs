/**
 * The `NotificationPublisher` **port** (ADR-005) — the hexagonal seam between the booking core
 * and whatever carries an event onward.
 *
 * The core depends on this interface and never on infrastructure: no AWS SDK import exists
 * anywhere in `src/`. Locally the adapter is an in-process `@nestjs/event-emitter` bus; in
 * production it publishes to SNS. Swapping environments is a binding change, not a redesign.
 *
 * Note precisely what the port does and does not own. It defines *how an event leaves the core* —
 * not whether it is durable. Durability is the transactional outbox's job (ADR-006), which sits
 * between the committed transaction and this port. And per §11.1, only the **publish** step is a
 * behind-the-port swap; the relay and the scheduler are genuine infrastructure substitutions in
 * production, not one-line adapter changes.
 */
export interface NotificationEvent {
  /** The outbox row id. Consumers dedupe on this — delivery is at-least-once (ADR-006). */
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  dealershipId: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface NotificationPublisher {
  /**
   * Publishes one event. Must throw on failure — the relay distinguishes success from failure
   * by whether this rejects, and only a real failure increments `attempts` (db §2.8).
   */
  publish(event: NotificationEvent): Promise<void>;
}

/** DI token; the interface itself cannot be one, since interfaces vanish at runtime. */
export const NOTIFICATION_PUBLISHER = Symbol('NOTIFICATION_PUBLISHER');
