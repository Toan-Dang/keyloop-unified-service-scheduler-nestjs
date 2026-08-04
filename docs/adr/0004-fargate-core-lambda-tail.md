# ADR-004: Containers (Fargate) for the transactional core, functions (Lambda) for the async tail

- **Status:** Accepted
- **Scope:** production deployment target only (the repo runs local-first; see system-design §11)
- **Related:** ADR-003 (monolith), ADR-005 (port), ADR-006 (outbox)

## Context

In the production target on AWS, two workloads have very different runtime profiles:

- The **transactional core** is connection-oriented and latency-sensitive: it holds a warm database connection pool and runs short transactions guarded by row/predicate locks.
- The **async tail** (publish → consume → send email; scheduled reminders) is **bursty, stateless, and event-driven**.

Forcing both onto one compute model would compromise one of them.

## Decision

Run the **transactional core on ECS Fargate** (long-lived containers) and the **async tail on Lambda** (event-driven functions). Use each where its runtime model is strongest rather than standardizing on one.

## Alternatives considered

- **Everything on Lambda.** The core would suffer **connection storms** — each concurrent invocation opening its own DB connection — mitigable only by adding RDS Proxy and accepting cold-start latency on a latency-sensitive path. Poor fit for a connection-pooled, transaction-heavy service.
- **Everything on Fargate/containers.** The notification tail would run as always-on containers sized for peak burst, wasting capacity for a workload that is idle most of the time and scales naturally per-event on Lambda.
- **Kubernetes (EKS) for both.** More operational weight than this system warrants at current scale; no benefit that Fargate + Lambda don't already provide.

## Consequences

**Positive**
- The core keeps a warm connection pool and predictable latency; the tail scales to zero and bursts per-event without idle cost.
- Blast radius is separated: a spike in notifications cannot starve the booking path, and vice versa.

**Negative / costs**
- Two compute models to build and operate (two deployment/IaC paths, two sets of logs/metrics). Acceptable, and both are covered by the same CDK definitions.
- Connection budget must still be managed for the core: `instances × pool_size` under Postgres `max_connections`, with PgBouncer/RDS Proxy beyond a few instances (system-design §10).

**Neutral**
- This is a **production-target** decision. Locally the same code runs as a single Node process with an in-process tail (system-design §11 mapping); the split only materializes on AWS.
