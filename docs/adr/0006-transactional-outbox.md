# ADR-006: Transactional outbox for reliable event publishing

- **Status:** Accepted
- **Related:** ADR-005 (the port the relay publishes through), ADR-001 (the transaction the outbox joins)

## Context

The confirmation event must be published **after** the appointment is durably committed — publishing before commit risks notifying a customer about a booking that then rolls back (a phantom notification).

But the naive fix — `COMMIT`, then call `publish()` — introduces the opposite failure. If the process crashes, or the broker is briefly unavailable, in the window **between** the commit and the publish, the appointment exists yet the event is **lost forever**. This is the classic **dual-write problem**: two systems (the database and the message broker) cannot be updated atomically, so "write to DB" and "write to broker" can diverge on failure.

Both failure directions must be closed: never notify for a non-persisted booking, **and** never lose the notification for a persisted one.

## Decision

Use the **transactional outbox** pattern:

1. The booking transaction writes an `outbox` row (`event_type`, `payload`, `status='PENDING'`) **in the same transaction** as the appointment. Either both commit or neither does.
2. A separate **relay** polls `PENDING` rows, publishes each through the `NotificationPublisher` port (ADR-005), and marks them `SENT`, retrying with backoff on failure.
3. Because delivery is **at-least-once**, downstream consumers are made **idempotent** on the event id (the `outbox.id`), so a possible re-delivery is harmless.

The `outbox` table, its status enum, and the relay's `FOR UPDATE SKIP LOCKED` claim query are specified in `database-design.md` §2.8 / §3.

## Alternatives considered

- **Publish-after-commit (no outbox).** Simple, but has the lost-event failure mode above. Rejected — reliability is a stated goal.
- **Two-phase commit (XA) across DB and broker.** Would make the two writes atomic, but 2PC is operationally heavy, poorly supported across these systems, and hurts availability. Rejected.
- **Change Data Capture (e.g. Debezium) instead of an app-level relay.** A valid production evolution that tails the WAL rather than polling; noted as the production option in the §11 mapping. Not needed locally, where a simple poller is clearer and dependency-free.
- **Listen/notify or in-memory queue only.** Loses events on crash (not durable). Rejected for the reliability path.

## Consequences

**Positive**
- The event can never be lost: appointment and intent-to-notify commit atomically.
- No phantom notifications either: the outbox row only exists if the appointment committed.
- Works identically local-first (in-process relay) and in production (poller or CDC), behind the same port.

**Negative / costs**
- Adds a table and a background relay to build, run, and monitor (backlog and dead-letter counts are surfaced in observability, system-design §13).
- At-least-once delivery pushes an **idempotency requirement onto consumers** (dedupe on event id).
- Slight added latency between commit and delivery (one relay poll interval) — acceptable for an asynchronous confirmation email.

**Neutral**
- The outbox complements, and does not replace, the exclusion-constraint invariant (ADR-001) or the notification port (ADR-005); it is the durability layer between them.
