# Database Design — Unified Service Scheduler

**Technical Assessment · Scenario A (Domain: Ownership)**
Author: Dang Phuc Toan · Version: 1.0

> Companion to [`system-design.md`](./system-design.md). That document holds the summary domain model (§3) and schema notes (§8); **this document is the detailed, implementation-level reference** for the schema, constraints, indexes, and the reasoning behind them. It is the source the code phase (Prisma schema + raw-SQL migrations) is generated and reviewed against.
>
> **Tech stack:** PostgreSQL 18 (`btree_gist` extension required).
> **Conventions:**
> - Primary keys are `UUID` defaulting to native **`uuidv7()`** (time-ordered — good index locality, no enumeration). No `SERIAL`/`INTEGER` keys.
> - All timestamps are `timestamptz` stored in **UTC**. Wall-clock presentation uses the dealership's `timezone`.
> - All tables carry `created_at` / `updated_at` (`NOT NULL DEFAULT now()`).
> - Naming: `snake_case` columns, plural table names.
> - Reference data (dealerships, customers, vehicles, service types, technicians, bays) is **seeded** for local runs; the booking flow references it by id.

---

## Table of Contents

1. [ERD Diagram](#1-erd-diagram)
2. [Table Definitions](#2-table-definitions)
   - 2.1 [`dealerships`](#21-dealerships)
   - 2.2 [`customers`](#22-customers)
   - 2.3 [`vehicles`](#23-vehicles)
   - 2.4 [`service_types`](#24-service_types)
   - 2.5 [`technicians`](#25-technicians)
   - 2.6 [`service_bays`](#26-service_bays)
   - 2.7 [`appointments`](#27-appointments) — the transactional core
   - 2.8 [`outbox`](#28-outbox) — reliable event publishing
3. [Constraints & DDL — the concurrency guard](#3-constraints--ddl--the-concurrency-guard)
4. [Indexes](#4-indexes)
5. [Design Notes](#5-design-notes)
6. [Seed Data (local fixtures)](#6-seed-data-local-fixtures)

---

## 1. ERD Diagram

The full entity-relationship diagram lives in [`system-design.md` §3](./system-design.md#3-domain-model). Simplified relationship overview:

```
dealerships ──┬── technicians ───┐
              ├── service_bays ──┤
              └── appointments ◄─┴──────┐  (technician_id, service_bay_id)
                       ▲                │
customers ──┬── vehicles ── appointments (customer_id, vehicle_id)
            └── appointments
service_types ── appointments (service_type_id)
```

An `appointment` is the join point of six references (dealership, customer, vehicle, service type, technician, bay) plus a time window. It is the only table under concurrent write pressure and the only one carrying overlap-exclusion constraints.

---

## 2. Table Definitions

### 2.1 `dealerships`

The tenant/location that owns technicians, bays, and appointments; carries the timezone and opening hours used to evaluate availability.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | UUID | NO | `uuidv7()` | Primary key. |
| `name` | VARCHAR(255) | NO | — | Dealership display name. |
| `timezone` | VARCHAR(64) | NO | — | IANA timezone (e.g. `Asia/Ho_Chi_Minh`). Used to interpret `opening_hours` and to present UTC times locally. |
| `opening_hours` | JSONB | NO | — | Weekly opening hours (see rationale). |
| `created_at` | TIMESTAMPTZ | NO | `now()` | |
| `updated_at` | TIMESTAMPTZ | NO | `now()` | |

> **Schema rationale:**
> - **`opening_hours` as JSONB, not a table** — hours are 1:1 with the dealership, read on every availability check, and rarely mutated. Shape: `{"mon":[["08:00","18:00"]], "sat":[["08:00","12:00"]], "sun":[]}` (list-of-ranges per weekday supports split shifts / lunch closes). Local wall-clock strings, interpreted in `timezone`. Keeping it inline avoids a join on the hot path.
> - **`timezone` on the dealership, not global** — a booking's `desiredStartTime` arrives in UTC; opening-hours evaluation converts to the dealership's local day-of-week and time. Storing the zone per dealership makes multi-location correct from day one.

### 2.2 `customers`

The requesting party. Seeded reference data for local runs.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | UUID | NO | `uuidv7()` | Primary key. |
| `dealership_id` | UUID | NO | — | FK → `dealerships.id`. Tenant boundary — a customer record belongs to the dealership it registered with. |
| `name` | VARCHAR(255) | NO | — | Customer name. |
| `email` | VARCHAR(255) | NO | — | Contact email. Recipient of the confirmation notification. Unique **per dealership** (`(dealership_id, email)`). |
| `phone` | VARCHAR(20) | YES | NULL | Optional contact phone (E.164). |
| `created_at` | TIMESTAMPTZ | NO | `now()` | |
| `updated_at` | TIMESTAMPTZ | NO | `now()` | |

> **Schema rationale:**
> - **`dealership_id` on every tenant-owned table** — the tenant id is denormalized onto `customers`, `vehicles`, and `service_types` (not just the resources) so that every tenant-scoped lookup and every RLS policy (§14 of `system-design.md`) can filter on a single local column without a join. This is what makes the API's "out-of-tenant reference → `404`" guarantee implementable.
> - **`email` unique per dealership** (`(dealership_id, email)`), not globally — the same person may be a customer at two independent dealerships.

### 2.3 `vehicles`

The asset being serviced; owned by a customer.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | UUID | NO | `uuidv7()` | Primary key. |
| `dealership_id` | UUID | NO | — | FK → `dealerships.id`. Tenant boundary (denormalized; must equal `customers.dealership_id` of the owner). |
| `vin` | VARCHAR(17) | NO | — | Vehicle Identification Number (unique **per dealership**). |
| `make` | VARCHAR(64) | NO | — | Manufacturer. |
| `model` | VARCHAR(64) | NO | — | Model. |
| `year` | SMALLINT | NO | — | Model year. |
| `customer_id` | UUID | NO | — | FK → `customers.id`. Owner of the vehicle. |
| `created_at` | TIMESTAMPTZ | NO | `now()` | |
| `updated_at` | TIMESTAMPTZ | NO | `now()` | |

> **Schema rationale:**
> - **`vin` unique per dealership** (`(dealership_id, vin)`) — a VIN is globally unique in the real world, but a vehicle can legitimately exist in more than one dealership's records; scoping the uniqueness avoids cross-tenant collisions while still catching double-registration within a tenant.
> - **Ownership via `customer_id` + tenant via `dealership_id`** — booking validates that the vehicle belongs to the requesting customer **and** the same dealership; a mismatch is `422 VEHICLE_OWNERSHIP_MISMATCH`, an out-of-tenant reference is `404` (app-layer rules, enforced under RLS in production).

### 2.4 `service_types`

Defines what a service is: how long it takes and which skills it needs. Duration drives the booking window.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | UUID | NO | `uuidv7()` | Primary key. |
| `dealership_id` | UUID | NO | — | FK → `dealerships.id`. Tenant boundary — each dealership defines its own service catalogue (durations/skills can differ). |
| `name` | VARCHAR(128) | NO | — | e.g. "Oil Change", "Brake Inspection". |
| `duration_minutes` | INTEGER | NO | — | Deterministic service duration. Window = `[start, start + duration_minutes)`. **`CHECK (duration_minutes > 0)`** — a zero/negative duration would make `end_time = start_time` and trip `appointments_time_valid` on every booking, so it is forbidden at the source. |
| `required_skills` | TEXT[] | NO | `'{}'` | Skills a technician must have to perform this service. A technician qualifies iff `technicians.skills @> required_skills`. |
| `created_at` | TIMESTAMPTZ | NO | `now()` | |
| `updated_at` | TIMESTAMPTZ | NO | `now()` | |

> **Schema rationale:**
> - **Duration on the service type, not the request** — makes the window deterministic and server-authoritative; a client cannot ask for an arbitrary-length slot. (Assumption 1 in `system-design.md` §2.)
> - **`dealership_id`** — service types are per-dealership so durations and required skills can vary by location, and so the tenant-scoped `404` guarantee applies uniformly.
> - **`required_skills TEXT[]`** — matched against a technician's `skills` with the array-containment operator `@>`. Simple, index-friendly (GIN), and adequate while skills are opaque tags. If skills gain attributes (levels, certifications), this migrates to a normalized `skills` + join table (noted in Design Notes).

### 2.5 `technicians`

A bookable human resource with skills and working hours. One of the two resources guarded against double-booking.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | UUID | NO | `uuidv7()` | Primary key. |
| `dealership_id` | UUID | NO | — | FK → `dealerships.id`. |
| `name` | VARCHAR(255) | NO | — | Technician name. |
| `skills` | TEXT[] | NO | `'{}'` | Skills held; qualifies for a service type when it is a superset of `required_skills`. |
| `working_hours` | JSONB | NO | — | Weekly working hours, same shape as `dealerships.opening_hours`. Local wall-clock, dealership timezone. |
| `is_active` | BOOLEAN | NO | `true` | Soft on/off switch; inactive technicians are excluded from candidate selection. |
| `created_at` | TIMESTAMPTZ | NO | `now()` | |
| `updated_at` | TIMESTAMPTZ | NO | `now()` | |

> **Schema rationale:**
> - **`working_hours` mirrors dealership `opening_hours`** — an appointment must fall inside *both* the technician's shift and the dealership's opening hours. Same JSONB shape keeps the evaluation code uniform.
> - **`is_active` instead of hard delete** — historical appointments must retain their technician reference; deactivation removes a technician from future candidacy without breaking foreign keys or audit trails.

### 2.6 `service_bays`

A bookable physical resource. The second resource guarded against double-booking.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | UUID | NO | `uuidv7()` | Primary key. |
| `dealership_id` | UUID | NO | — | FK → `dealerships.id`. |
| `name` | VARCHAR(64) | NO | — | e.g. "Bay 1". |
| `is_active` | BOOLEAN | NO | `true` | Inactive bays are excluded from candidate selection. |
| `created_at` | TIMESTAMPTZ | NO | `now()` | |
| `updated_at` | TIMESTAMPTZ | NO | `now()` | |

> **Schema rationale:**
> - **Bays have no working hours of their own** — they inherit the dealership's `opening_hours`. Availability of a bay = within opening hours AND no overlapping confirmed appointment.

### 2.7 `appointments`

The transactional record — the object protected against overlap. This is the only table under concurrent write pressure and the only one carrying exclusion constraints (§3).

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | UUID | NO | `uuidv7()` | Primary key. |
| `dealership_id` | UUID | NO | — | FK → `dealerships.id`. |
| `customer_id` | UUID | NO | — | FK → `customers.id`. |
| `vehicle_id` | UUID | NO | — | FK → `vehicles.id`. |
| `service_type_id` | UUID | NO | — | FK → `service_types.id`. Determines the duration/window. |
| `technician_id` | UUID | NO | — | FK → `technicians.id`. The allocated technician. |
| `service_bay_id` | UUID | NO | — | FK → `service_bays.id`. The allocated bay. |
| `start_time` | TIMESTAMPTZ | NO | — | Window start (UTC). |
| `end_time` | TIMESTAMPTZ | NO | — | Window end (UTC) = `start_time + service_type.duration_minutes`. |
| `during` | TSTZRANGE | NO | GENERATED | Generated column: `tstzrange(start_time, end_time, '[)')`. The half-open range the exclusion constraints operate on. |
| `status` | `appointment_status` ENUM | NO | `'CONFIRMED'` | `CONFIRMED` \| `CANCELLED`. Exclusion constraints apply only to `CONFIRMED` rows. |
| `idempotency_key` | VARCHAR(255) | YES | NULL | Client-supplied key; unique **per dealership** among non-null values (`(dealership_id, idempotency_key)`). A retry with the same key returns the original appointment instead of creating a duplicate; the tenant scope prevents cross-dealership collisions. |
| `request_hash` | CHAR(64) | YES | NULL | SHA-256 of the canonicalized request body that created this row. Stored so the **durable** idempotency path (when Redis is cold) can reject a same-key/different-body reuse with `422` without depending on the cache — see §5.4. NULL only for rows created without a key. |
| `cancelled_at` | TIMESTAMPTZ | YES | NULL | Set when `status → CANCELLED`; NULL otherwise. |
| `cancel_reason` | TEXT | YES | NULL | Optional free-text reason for cancellation. |
| `reminder_sent_at` | TIMESTAMPTZ | YES | NULL | Set when the T-24h reminder has been enqueued; NULL = not yet reminded. Makes the reminder scan idempotent (system-design.md §5.3). |
| `created_at` | TIMESTAMPTZ | NO | `now()` | |
| `updated_at` | TIMESTAMPTZ | NO | `now()` | |

> **Schema rationale:**
> - **`during` generated column** — deriving the range once (`GENERATED ALWAYS AS ... STORED`) keeps `start_time`/`end_time` as the human-readable source of truth while giving the GiST exclusion constraint a single indexed expression. Equivalent to the inline `tstzrange(...)` shown in `system-design.md` §6.1, but cleaner and guaranteed consistent.
> - **`customer_id` is a booking-time snapshot, not redundant with `vehicles.customer_id`** — it records *who booked* this appointment. It is validated to equal the vehicle's owner at booking (`422 VEHICLE_OWNERSHIP_MISMATCH` otherwise), but is stored on the appointment so that if the vehicle later changes owner, historical appointments still attribute to the customer who actually made them.
> - **`status` as an enum with `CONFIRMED` default** — a row is confirmed the moment it is inserted; there is no "pending" state because availability is decided synchronously at write time by the DB constraint. Cancellation is a status transition, not a delete.
> - **`idempotency_key` unique (partial, non-null)** — the DB is the second line of idempotency defense behind Redis: even if the cache is cold or evicted, a duplicate key cannot create a second row. See §3.
> - **No `deleted_at`** — appointments are never hard/soft-deleted; cancellation (`status='CANCELLED'` + `cancelled_at`) is the lifecycle end state and is what frees a slot.

### 2.8 `outbox`

The transactional-outbox table (system-design.md §6.6 / ADR-006). A row is inserted **in the same transaction** as the appointment it announces; a relay publishes `PENDING` rows through the `NotificationPublisher` port and marks them `SENT`. This makes "appointment persisted" and "notification will be delivered" a single atomic fact.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | UUID | NO | `uuidv7()` | Primary key. Also the `event_id` consumers dedupe on. |
| `dealership_id` | UUID | NO | — | Tenant of the source aggregate. Lets the (privileged) relay filter/observe per tenant and keeps the table RLS-consistent (see rationale). |
| `aggregate_type` | VARCHAR(64) | NO | — | e.g. `appointment`. |
| `aggregate_id` | UUID | NO | — | The appointment id this event is about. |
| `event_type` | VARCHAR(64) | NO | — | e.g. `AppointmentConfirmed`. |
| `payload` | JSONB | NO | — | Serialized event body (ids + denormalized fields the consumer needs, e.g. customer email). |
| `status` | `outbox_status` ENUM | NO | `'PENDING'` | `PENDING` \| `SENT` \| `FAILED`. |
| `attempts` | SMALLINT | NO | 0 | Publish attempts; drives backoff and the move to `FAILED`. |
| `available_at` | TIMESTAMPTZ | NO | `now()` | Next eligible time. The relay picks rows with `available_at <= now()`; the **claim leases the row by pushing this forward** (see rationale) so a concurrent relay won't re-pick it during publish. |
| `published_at` | TIMESTAMPTZ | YES | NULL | Set when the row transitions to `SENT`. |
| `created_at` | TIMESTAMPTZ | NO | `now()` | |

> **Schema rationale:**
> - **Same-transaction write** — the row is inserted alongside the appointment INSERT (§3), so it is impossible to have a committed appointment without its pending event, or vice versa. This is the entire point of the pattern.
> - **`id` doubles as `event_id`** — downstream consumers are made idempotent on it, tolerating the at-least-once relay's possible re-delivery.
> - **`attempts` counts *failures*, not claims.** A failed publish increments `attempts` and reschedules the row with exponential backoff; after a cap it becomes `FAILED` for inspection (the DB equivalent of a dead-letter). Leasing a row (below) does **not** touch `attempts` — otherwise a healthy-but-slowly-published or relay-restarted row would drift toward the `FAILED` cap without any real failure. Lease timeout and failure count are deliberately separate concerns sharing the `available_at` schedule.
> - **Relay operating parameters (pinned):** poll interval ≈ 1 s; batch size `LIMIT 100` per poll; **lease** = `available_at = now() + 30 s` on claim (must exceed the worst-case time to publish one batch — mark each event `SENT` individually so a slow tail can't strand the whole batch); **failure backoff** = on a publish error set `attempts = attempts + 1`, `available_at = now() + least(2^attempts, 300) s`; `attempts` cap = 8 → `FAILED`. Ordering within a poll is `ORDER BY id` (time-ordered uuidv7).
> - **Lease-on-claim, then publish, then mark (do not hold a row lock across the network).** A relay must not hold a `FOR UPDATE` lock across the (network) publish — that would pin a transaction open for the broker's latency. But simply releasing the lock while the row is still `PENDING` with `available_at <= now()` would let a second relay (we advertise multi-instance) immediately re-pick and **re-publish it as normal operation**, not just on crash. So the claim **leases** the batch in one short transaction (pushing `available_at` forward *without* bumping `attempts`):
>   ```sql
>   UPDATE outbox SET available_at = now() + interval '30 s'
>   WHERE id IN (
>     SELECT id FROM outbox
>     WHERE status='PENDING' AND available_at <= now()
>     ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100)
>   RETURNING *;
>   ```
>   This commits (releasing the lock) but pushes `available_at` 30 s into the future, so no other relay re-picks the row during publish. The relay then publishes each event and, **per event**, either marks it `SENT` (success) or applies the failure backoff above (`attempts + 1`). If the relay crashes mid-publish, the lease expires after 30 s and another relay retries — **at-least-once**, with consumer dedupe on `event_id` (ADR-006) making a rare double-delivery harmless. This makes the claim *durable*, not just lock-scoped.
> - **No cross-aggregate ordering guarantee.** Parallel relays do not guarantee `AppointmentConfirmed` is delivered before a later `AppointmentCancelled` for the *same* appointment. Benign for email; if strict per-appointment ordering is ever needed, lease/serialize by `aggregate_id`. Documented, not built.
> - **Convention exception:** `outbox` intentionally has **no `updated_at`** (and no soft-delete) — it is an append-and-purge operational log, not audited business data, so the blanket "every table has `created_at`/`updated_at`" rule (Conventions) does not apply here.
> - **Retention:** `SENT` rows older than a few days are purged; the table stays small because it is a transient event log, not a store of record.

---

## 3. Constraints & DDL — the concurrency guard

This is the heart of the schema. A naive "check-then-insert" is unsafe under concurrency; correctness is enforced **physically by the database**, not by application logic. Two exclusion constraints (via `btree_gist`) make an overlapping confirmed booking *impossible* to persist.

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE appointment_status AS ENUM ('CONFIRMED', 'CANCELLED');

CREATE TABLE appointments (
    id              UUID PRIMARY KEY DEFAULT uuidv7(),
    dealership_id   UUID NOT NULL REFERENCES dealerships(id),
    customer_id     UUID NOT NULL REFERENCES customers(id),
    vehicle_id      UUID NOT NULL REFERENCES vehicles(id),
    service_type_id UUID NOT NULL REFERENCES service_types(id),
    technician_id   UUID NOT NULL REFERENCES technicians(id),
    service_bay_id  UUID NOT NULL REFERENCES service_bays(id),
    start_time      TIMESTAMPTZ NOT NULL,
    end_time        TIMESTAMPTZ NOT NULL,
    during          TSTZRANGE GENERATED ALWAYS AS (tstzrange(start_time, end_time, '[)')) STORED,
    status           appointment_status NOT NULL DEFAULT 'CONFIRMED',
    idempotency_key  VARCHAR(255),
    request_hash     CHAR(64),
    cancelled_at     TIMESTAMPTZ,
    cancel_reason    TEXT,
    reminder_sent_at TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT appointments_time_valid CHECK (end_time > start_time)
);

-- No technician is confirmed for two overlapping windows.
ALTER TABLE appointments
  ADD CONSTRAINT no_technician_overlap
  EXCLUDE USING gist (technician_id WITH =, during WITH &&)
  WHERE (status = 'CONFIRMED');

-- No bay is confirmed for two overlapping windows.
ALTER TABLE appointments
  ADD CONSTRAINT no_bay_overlap
  EXCLUDE USING gist (service_bay_id WITH =, during WITH &&)
  WHERE (status = 'CONFIRMED');

-- Idempotency: a non-null key is unique PER DEALERSHIP (tenant-scoped).
CREATE UNIQUE INDEX appointments_idempotency_key_uniq
  ON appointments (dealership_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Reminder scan: find confirmed, not-yet-reminded appointments due in the window.
CREATE INDEX appointments_reminder_due_idx
  ON appointments (start_time)
  WHERE status = 'CONFIRMED' AND reminder_sent_at IS NULL;
```

**Transactional outbox** — written in the same transaction as the appointment (§2.8):

```sql
CREATE TYPE outbox_status AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE outbox (
    id             UUID PRIMARY KEY DEFAULT uuidv7(),
    dealership_id  UUID NOT NULL,
    aggregate_type VARCHAR(64) NOT NULL,
    aggregate_id   UUID NOT NULL,
    event_type     VARCHAR(64) NOT NULL,
    payload        JSONB NOT NULL,
    status         outbox_status NOT NULL DEFAULT 'PENDING',
    attempts       SMALLINT NOT NULL DEFAULT 0,
    available_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Relay hot path: fetch due, unpublished rows in insertion order.
CREATE INDEX outbox_due_idx
  ON outbox (available_at)
  WHERE status = 'PENDING';
```

> The relay **leases** a batch in one transaction — `UPDATE outbox SET available_at = now() + interval '30 s' WHERE id IN (SELECT id FROM outbox WHERE status='PENDING' AND available_at <= now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100) RETURNING *` — commits, then publishes and marks each row `SENT` (or applies failure backoff, bumping `attempts`, per §2.8). `SKIP LOCKED` avoids inter-relay contention *during* the claim; pushing `available_at` forward makes the claim **durable after the lock is released**, so a second relay won't re-publish the batch while it is in flight. The lease (30 s) must exceed the worst-case single-batch publish time. The `outbox` runs under a privileged/RLS-bypassing relay role — it is a cross-tenant operational table (each row still carries `dealership_id` for filtering and tenant-aware payload handling).

**How this guarantees no double-booking:** `EXCLUDE USING gist (technician_id WITH =, during WITH &&)` tells PostgreSQL to reject any insert whose `technician_id` equals an existing row's *and* whose `during` range overlaps (`&&`) it — evaluated atomically under the row lock the insert takes. No matter how many requests race for the same slot, at most one `CONFIRMED` row can exist per resource per overlapping window. The `WHERE (status = 'CONFIRMED')` makes both constraints **partial**, so a `CANCELLED` row stops occupying the slot the instant it is cancelled.

> These constraints are added via a **raw-SQL migration** (Prisma models the table; the exclusion constraints, generated column, and partial unique index are applied through a hand-written migration step because they are beyond the ORM's declarative surface).

---

## 4. Indexes

| Table | Index | Type | Purpose |
|-------|-------|------|---------|
| `appointments` | `no_technician_overlap` | GiST (partial) | Backs the technician exclusion constraint; also serves overlap lookups. |
| `appointments` | `no_bay_overlap` | GiST (partial) | Backs the bay exclusion constraint. |
| `appointments` | `appointments_idempotency_key_uniq` — `(dealership_id, idempotency_key)` | B-tree unique (partial) | Idempotent-retry enforcement, **tenant-scoped** (no cross-dealership collision). |
| `appointments` | `(dealership_id, start_time)` | B-tree | List/availability queries by dealership and date range. |
| `appointments` | `(technician_id, start_time)` | B-tree | Per-technician schedule reads. |
| `appointments` | `(customer_id)` | B-tree | "A customer's appointments" listing + FK-restrict checks. |
| `appointments` | `(vehicle_id)` | B-tree | Per-vehicle history + FK-restrict checks. |
| `appointments` | `appointments_reminder_due_idx` — `(start_time) WHERE status='CONFIRMED' AND reminder_sent_at IS NULL` | B-tree (partial) | Reminder scan for due, not-yet-reminded appointments; stays tiny. |
| `vehicles` | `(dealership_id, vin)` | B-tree unique | VIN lookup / dedupe, **tenant-scoped**. |
| `vehicles` | `(customer_id)` | B-tree | Vehicles by owner. |
| `technicians` | `(dealership_id)` | B-tree | Candidate selection by dealership. |
| `technicians` | `skills` | GIN | `@>` containment for qualification checks. |
| `service_bays` | `(dealership_id)` | B-tree | Candidate selection by dealership. |
| `service_types` | `(dealership_id)` | B-tree | Tenant-scoped service catalogue lookup. |
| `customers` | `(dealership_id, email)` | B-tree unique | Contact uniqueness, **tenant-scoped**. |
| `outbox` | `outbox_due_idx` — `(available_at) WHERE status='PENDING'` | B-tree (partial) | Relay fetch of due, unpublished events; stays tiny (only pending rows indexed). |

> The two GiST indexes are created implicitly by the exclusion constraints — they are listed here for completeness, not defined twice. There is deliberately **no standalone `(status)` index**: `status` is a 2-value enum (poor selectivity) and the partial indexes above already encode `status='CONFIRMED'` where it matters.

---

## 5. Design Notes

**5.1 Half-open windows `[start, end)`.** Every overlap check uses the half-open range `tstzrange(start_time, end_time, '[)')`. An appointment ending at 10:00 does **not** conflict with one starting at 10:00 — back-to-back bookings are legal, which is the intuitive real-world behavior. This is consistent across the generated column, the constraints, and the availability logic.

**5.2 UUIDv7 primary keys.** Native `uuidv7()` (PostgreSQL 18) yields time-ordered UUIDs: insert locality close to a sequence (less B-tree fragmentation, better cache behavior) while remaining non-enumerable in the API. Chosen over `uuidv4` (random → index bloat) and over `SERIAL` (enumerable, leaks volume).

**5.3 Cancellation frees the slot, deletes never happen.** Because the exclusion constraints are partial on `status = 'CONFIRMED'`, transitioning a row to `CANCELLED` immediately removes it from the overlap set without deleting history. A subsequent booking for the same window then succeeds. Appointments are an audit record; they are never physically removed.

**5.4 Idempotency is defense-in-depth (tenant-scoped, with an honest durability scope).** The key is scoped to the dealership everywhere — the durable uniqueness is `(dealership_id, idempotency_key)` and the Redis cache key is `(dealership_id, key)` — so two dealerships that reuse the same key value can never collide or read each other's appointment. The **durable** guarantee covers the **created (`201`) path**: the partial unique index means that even if Redis is cold, evicted, or bypassed, the database refuses a second appointment for the same tenant+key — the concurrent check-then-act race on Redis is benign because the second INSERT hits `23505`, which the app maps to "return the existing appointment" **after re-checking that the stored row's `dealership_id` matches the caller and its `request_hash` matches the incoming request's fingerprint** (a mismatch → `422`, not a silent wrong-body replay). Because `request_hash` is a column on the row, this check works with Redis down. Redis (fast path) additionally caches a **request fingerprint** (hash of the normalized body) and the prior response so rapid retries replay instantly; a known key arriving with a *different* fingerprint is rejected with `422`. **Non-`201` outcomes (e.g. `409 NO_AVAILABILITY`) are cached only in Redis with a short TTL** — a best-effort dedupe for immediate retries, **not** a durable promise: after the TTL a retry re-runs allocation, which is the *correct* behaviour because availability is time-sensitive and the slot may since have freed (see system-design.md §6.3).

**5.5 Times stored UTC, evaluated in dealership timezone.** All `timestamptz` columns are UTC. Opening-hours and working-hours evaluation converts the UTC window to the dealership's local day/time via `dealerships.timezone`. Presentation layers format back to local time. This keeps arithmetic unambiguous and DST-safe.

**5.6 Skills as arrays now, normalized later.** `TEXT[]` + GIN + `@>` is the right weight while skills are opaque tags and matching is pure superset. The moment skills need attributes (proficiency level, certification expiry, dealership-specific grants), the migration path is a `skills` dimension table plus `technician_skills` / `service_type_required_skills` join tables. Deferred until justified — documented, not built.

**5.7 Referential integrity.** All foreign keys are `NOT NULL` and enforced at the DB. `is_active` flags (not deletes) protect historical appointment references for technicians and bays. `ON DELETE` is left as `RESTRICT` (default) for seeded reference data — deletion is not a supported operation in this iteration.

**5.8 What the ORM owns vs. raw SQL.** Prisma owns table/column/relation modeling and standard migrations. The DB features beyond its declarative surface — the `btree_gist` exclusion constraints, the `during` generated column, the partial unique index, and the `outbox` partial index — are applied through a hand-authored SQL migration that runs alongside Prisma's. This is called out so it is clear where the hand-tuned SQL lives.

**5.9 `end_time` = `start_time + duration` is an app-enforced invariant.** The DB guarantees `end_time > start_time` (a `CHECK`), and the exclusion constraints protect whatever window is stored — but nothing at the DB level ties `end_time` to the `service_type.duration_minutes` on a *joined* row. The Booking module is the single writer and computes the window server-side, so the invariant holds in practice; it is documented here (rather than enforced by a trigger) as a deliberate simplicity trade-off. A trigger validating the window length against the service type is the hardening step if writers ever multiply.

**5.10 Migration locking.** Adding an `EXCLUDE` constraint takes an `ACCESS EXCLUSIVE` lock and scans the table to validate existing rows — instant on an empty/greenfield table (the case here), but on a large live table it briefly blocks writes. Note that the usual online-DDL escapes **do not apply to exclusion constraints**: `ADD CONSTRAINT ... USING INDEX` accepts only `PRIMARY KEY`/`UNIQUE` (not `EXCLUDE`), and `NOT VALID` is accepted only for `CHECK`/`FOREIGN KEY` (not `EXCLUDE`). So there is no fully non-blocking, in-place way to add it in vanilla PostgreSQL. Production-safe options: (a) add it during a **low-traffic maintenance window** with a bounded `lock_timeout` and retry; or (b) build the constraint on a **new table** and switch over via a backfill + rename (or a tool like `pg_repack`/logical replication). Not needed at this scale; noted for operational honesty.

**5.11 Tenant consistency invariant.** `dealership_id` is denormalized onto `customers`, `vehicles`, `service_types`, `technicians`, `service_bays`, `appointments`, and `outbox`. All rows referenced by one appointment must share the **same** `dealership_id` (the vehicle's owner, the service type, the technician, the bay). Because this spans rows, it is enforced in the **application layer** (the booking service resolves everything within the caller's tenant, §6.7 / §14 of `system-design.md`) rather than by a single DB constraint; in production, RLS makes cross-tenant rows invisible so the invariant holds even against a buggy query. Composite FKs like `FOREIGN KEY (dealership_id, customer_id) REFERENCES customers (dealership_id, id)` are the belt-and-braces DB-level option, noted but not required at this scale.

---

## 6. Seed Data (local fixtures)

To make the acceptance criteria (and the concurrency test) runnable out of the box, the repo seeds a minimal but sufficient fixture:

- **1 dealership** — `Asia/Ho_Chi_Minh`, opening hours Mon–Sat 08:00–18:00, closed Sunday.
- **2 service types** — e.g. `Oil Change` (60 min, skills `['general']`), `Brake Inspection` (90 min, skills `['brakes']`).
- **2 technicians** — one with `['general']`, one with `['general','brakes']`; overlapping working hours so qualification and availability can both be exercised.
- **2 service bays** — both active.
- **2 customers**, each with **1 vehicle** (distinct VINs).

This fixture is deliberately shaped so the concurrency test has a **genuine single bottleneck**: only **one** technician holds `brakes`, so a burst of parallel **Brake Inspection** bookings for one window can place exactly one appointment (the sole qualified technician) — the rest get `409`. This is the exact condition the concurrency test asserts on (system-design.md §6.5). Note that a burst of *Oil Change* bookings (both technicians qualify, two bays) could legitimately place two appointments, so the test must use Brake Inspection.

---

*End of Database Design v1.0. Kept in sync with `system-design.md` §3 (domain model) and §8 (schema notes); the exclusion-constraint decision is recorded in ADR-001/002.*
