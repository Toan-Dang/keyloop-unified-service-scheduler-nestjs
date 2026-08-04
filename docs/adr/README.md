# Architecture Decision Records

Each ADR captures one significant decision: the context that forced it, the options weighed, the choice made, and the consequences accepted. They are the "why" behind the design in [`../../system-design.md`](../../system-design.md) and [`../../database-design.md`](../../database-design.md).

| # | Decision | Status |
|---|----------|--------|
| [ADR-001](./0001-postgresql-exclusion-constraints.md) | PostgreSQL exclusion constraints as the authoritative double-booking guard | Accepted |
| [ADR-002](./0002-exclusion-constraint-over-redis-lock.md) | Exclusion constraint over a Redis distributed lock as the primary mechanism | Accepted |
| [ADR-003](./0003-modular-monolith-over-microservices.md) | Modular monolith over microservices for the transactional core | Accepted |
| [ADR-004](./0004-fargate-core-lambda-tail.md) | Containers (Fargate) for the transactional core, functions (Lambda) for the async tail | Accepted |
| [ADR-005](./0005-notifications-behind-port.md) | Notifications behind a `NotificationPublisher` port (hexagonal seam) | Accepted |
| [ADR-006](./0006-transactional-outbox.md) | Transactional outbox for reliable event publishing | Accepted |

**Format.** Each record follows a light MADR structure: *Context → Decision → Alternatives considered → Consequences*. Status values: `Proposed`, `Accepted`, `Superseded by ADR-NNN`.
