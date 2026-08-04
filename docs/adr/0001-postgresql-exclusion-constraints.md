# ADR-001: PostgreSQL exclusion constraints as the authoritative double-booking guard

- **Status:** Accepted
- **Related:** ADR-002 (why not a Redis lock), ADR-006 (reliable side-effects)

## Context

The core invariant of the scheduler is that **no technician and no bay may be booked for two overlapping time windows**. This must hold under concurrency: multiple booking requests for the same resource and overlapping window can arrive simultaneously (retries, multiple clients, load-balanced app instances).

The classic failure is a **check-then-act race**: two requests each run "is this slot free?", both read *free* in the gap before either writes, and both insert — a double-booking. Any correctness mechanism that lives only in application code (read, decide, write) is vulnerable to this window unless it serializes access to the resource somehow.

We need a mechanism that makes an overlapping confirmed booking **impossible to persist**, evaluated atomically at write time, independent of how many app instances run.

## Decision

Enforce the invariant **physically in the database** using PostgreSQL **`btree_gist` exclusion constraints** on the `appointments` table — one per resource:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE appointments
  ADD CONSTRAINT no_technician_overlap
  EXCLUDE USING gist (technician_id WITH =, during WITH &&)
  WHERE (status = 'CONFIRMED');

ALTER TABLE appointments
  ADD CONSTRAINT no_bay_overlap
  EXCLUDE USING gist (service_bay_id WITH =, during WITH &&)
  WHERE (status = 'CONFIRMED');
```

`during` is a generated `tstzrange(start_time, end_time, '[)')` (half-open). The constraint rejects any insert whose resource id equals an existing row's **and** whose time range overlaps (`&&`) it. The constraints are **partial** (`WHERE status = 'CONFIRMED'`) so a cancelled row immediately frees the slot.

The database is the single source of truth for the invariant. Application code treats the candidate-selection query as advisory only and relies on the constraint for correctness.

## Alternatives considered

- **Application-level check-then-insert** — simplest to write, but wrong under concurrency (the race above). Rejected.
- **`SELECT ... FOR UPDATE` pessimistic locking** — would require locking a row that represents the resource+window, which doesn't naturally exist (windows are continuous, not discrete rows). Awkward and easy to get wrong; serializes more than necessary.
- **`SERIALIZABLE` isolation** — would catch the anomaly via serialization failures, but forces retry loops on every conflict and adds overhead for the whole transaction, when only this one invariant needs protection. See ADR-002 / system-design §6.2 for why `READ COMMITTED` + the constraint is sufficient.
- **Redis distributed lock per resource+window** — viable but weaker and more moving parts; see ADR-002.

## Consequences

**Positive**
- Correctness is guaranteed by the engine, atomically, regardless of app-instance count — the invariant cannot be violated even in principle.
- Enables the cheaper `READ COMMITTED` isolation level (ADR-002 / system-design §6.2).
- The GiST index that backs the constraint also accelerates overlap queries.
- The guarantee is **testable**: a concurrency test firing N parallel bookings for one slot asserts exactly one `201` and the rest `409`.

**Negative / costs**
- Couples correctness to PostgreSQL (needs `btree_gist`). Portable to any engine with range-exclusion support, but not to engines without it — a deliberate, documented trade-off.
- The exclusion constraint plus the generated column live in a **hand-written SQL migration** (beyond the ORM's declarative surface).
- On a large existing table, adding the constraint takes an `ACCESS EXCLUSIVE` lock; production rollout uses `CONCURRENTLY` / `NOT VALID`+`VALIDATE` (database-design §5.10). Not an issue greenfield.

**Neutral**
- On conflict the database raises SQLSTATE `23P01`; the allocation loop maps this to "try the next candidate, else `409`" (system-design §6.2).
