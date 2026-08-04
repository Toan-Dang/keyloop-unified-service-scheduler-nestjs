# ADR-003: Modular monolith over microservices for the transactional core

- **Status:** Accepted
- **Related:** ADR-005 (port seam that keeps extraction cheap), system-design §15 (scaling path)

## Context

The system has a synchronous, transactional core (booking, availability, resources) and an asynchronous tail (notifications, reminders). A choice must be made about service boundaries: a single deployable **modular monolith**, or a set of **microservices** (e.g. a Booking service, an Availability service, a Notification service) from the outset.

The dominant constraint is the double-booking invariant (ADR-001): it must be enforced inside **one consistency boundary** — a single database transaction protected by an exclusion constraint. Booking, availability evaluation, and appointment persistence all participate in that one transaction.

## Decision

Build the transactional core as a **modular monolith** — one deployable, internally organized into clear modules (API, Booking, Resources, Notification port) with explicit boundaries and dependency direction. Keep the async tail decoupled behind a port (ADR-005) so it can be extracted later. Do **not** split the transactional core into services now.

## Alternatives considered

- **Microservices from day one** (Booking / Availability / Resource / Notification as separate services).
  - Splitting availability and booking across services would put the double-booking check and the write in **different databases/transactions**, forcing distributed transactions or sagas to preserve the invariant — turning a one-line database constraint into a hard distributed-consistency problem. This is the decisive argument against.
  - Adds operational surface (deploys, networking, tracing, failure modes) with no benefit at current scale.
- **Distributed monolith** (services that share one database) — worst of both: network hops plus shared-schema coupling. Rejected.

## Consequences

**Positive**
- The invariant stays in a single transaction/consistency boundary — simple and correct.
- One deployable: straightforward local run, testing, and debugging; lower operational overhead.
- Clear internal module seams keep the code organized and make future extraction low-risk.

**Negative / costs**
- A single deployable scales as a unit; a hotspot in one module scales the whole process. Mitigated by the core being **stateless and horizontally scalable** (correctness lives in the DB, not memory), so adding instances is safe.
- Requires discipline to keep module boundaries from eroding into a big ball of mud.

**Neutral / future**
- The migration path is explicit (system-design §15): the **Notification** concern already sits behind a port (ADR-005) and is the first, lowest-risk candidate to extract; read-heavy **Availability/Resource** could follow. The **Booking** core stays cohesive because its invariant must remain in one consistency boundary. Extraction is deferred until load or org boundaries justify it — not built now.
