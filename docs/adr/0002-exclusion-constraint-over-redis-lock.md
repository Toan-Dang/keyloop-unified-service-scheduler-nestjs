# ADR-002: Exclusion constraint over a Redis distributed lock as the primary mechanism

- **Status:** Accepted
- **Related:** ADR-001 (the chosen mechanism)

## Context

Given the double-booking invariant (ADR-001), a common alternative to a database constraint is an **application-level distributed lock** — e.g. a Redis lock keyed by `technician_id + window` (and another for the bay) — acquired before the availability check and released after the write. This is a well-known pattern and worth evaluating explicitly rather than dismissing.

The question is which mechanism should be the **authoritative** guard.

## Decision

Use the **PostgreSQL exclusion constraint (ADR-001) as the sole authority**. A Redis distributed lock is documented as a considered alternative and remains available as an optional optimization/defense-in-depth layer, but it is **not** relied upon for correctness.

## Alternatives considered

- **Redis distributed lock as the primary guard.** Acquire a lock per resource+window, do the check, write, release.
  - Correctness depends on the lock being correct under failure: lock expiry vs. long transactions, clock skew, the well-documented Redlock safety debates, and the need to fence against a lock lost mid-operation. Getting this right is subtle.
  - It is a **second system in the correctness path** — if Redis is down or partitioned, either bookings stop or the lock is bypassed (unsafe).
  - It still needs the database to actually persist the row, so the lock is *additional* machinery on top of, not instead of, the DB write.
- **Both, with Redis as the authority and the DB as a check** — inverts the trust boundary the wrong way: the stronger guarantee (DB) becomes advisory and the weaker one (Redis) becomes authoritative.

## Consequences

**Positive**
- **Fewer moving parts in the correctness path.** The invariant lives in exactly one place — the database that already must be consulted to persist the appointment. No second system can compromise it.
- **Stronger guarantee.** The constraint is atomic and does not depend on lock TTLs, fencing tokens, or clock assumptions.
- **Simpler failure modes.** If Redis is unavailable, correctness is unaffected (Redis is used only for the idempotency fast-path and optional locking); the DB constraint still holds.

**Negative / costs**
- Under very high contention for the *same* slot, competing inserts do real work (attempt + rollback to savepoint) rather than being gated earlier by a lock. In practice contention is naturally low (per-resource, per-window) and the retry cost is bounded by the candidate count — acceptable, and cheaper than operating a correct distributed lock.

**Neutral**
- A Redis lock can still be layered in later as an *optimization* to reduce wasted insert attempts on hot slots, without changing where correctness lives. Documented as optional, not built.
