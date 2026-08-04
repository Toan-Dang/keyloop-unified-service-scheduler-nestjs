# ADR-005: Notifications behind a `NotificationPublisher` port (hexagonal seam)

- **Status:** Accepted
- **Related:** ADR-004 (prod compute), ADR-006 (outbox), system-design §4 / §11

## Context

The booking core must trigger side-effects (confirmation email, reminders) without being coupled to any specific messaging infrastructure. Two conflicting needs:

1. The submission must **run fully local-first** — no AWS account, no cloud emulator — so reviewers can build and run it with `docker-compose`.
2. The design must credibly target a **production event pipeline** (SNS → SQS(+DLQ) → Lambda → SES).

Hard-coding SNS/SQS into the core would break (1); building only a local mechanism would fail to demonstrate (2). We need one codebase that satisfies both.

## Decision

Introduce a **`NotificationPublisher` port** (an interface) that the core depends on. Provide two **adapters** behind it, selected by configuration:

- **Local adapter** — in-process event bus (`@nestjs/event-emitter`); the consumer logs / mocks the email.
- **Production adapter** — publishes to SNS; SQS(+DLQ) → Lambda → SES carries it onward.

The core imports the interface only; it never references AWS SDKs. Swapping environments is a configuration change, not a redesign. (This is the hexagonal / ports-and-adapters pattern.)

## Alternatives considered

- **Call SNS directly from the core.** Simplest to write, but forces AWS (or LocalStack) to run the system at all, breaking local-first, and couples the transactional core to a vendor SDK.
- **LocalStack to emulate SNS/SQS locally.** Keeps one code path but adds a heavy dependency and container just to run locally, for little illustrative gain over an in-process adapter — rejected for the effort/value trade-off at this scope.
- **Only an in-process bus, no production story.** Fails to demonstrate the production pipeline the design targets.

## Consequences

**Positive**
- One codebase runs identically local-first and in production; the difference is one adapter binding.
- The core is testable in isolation with a fake publisher; no infrastructure needed for unit tests.
- Cleanly enables future extraction of a standalone Notification service (ADR-003 / system-design §15) — it already sits behind the port.

**Negative / costs**
- A small amount of indirection (interface + two adapters) versus a direct call. Well worth it for the decoupling.
- The two adapters must be kept behaviourally aligned (same event shape); covered by contract expectations on the port.

**Neutral**
- The port defines *how* the event leaves the core, not *whether* it is durable. Durability is handled separately by the transactional outbox (ADR-006), which sits between the committed transaction and the port.
