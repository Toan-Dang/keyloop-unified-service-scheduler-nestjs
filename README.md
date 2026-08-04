# Unified Service Scheduler

A backend for dealership service booking. A customer requests a service for a vehicle; the system
verifies — **in real time and under concurrency** — that both a qualified technician **and** a
service bay are free for the entire service duration, then persists a confirmed appointment.

The hard part is not CRUD. It is guaranteeing that **no technician and no bay is ever
double-booked**, however many requests race for the same slot. That guarantee is enforced
**physically by PostgreSQL**, not by application logic, and it is proved by an executable test
rather than argued in prose.

```
N parallel POST /appointments for one Brake Inspection slot
  n=2  → 201×1, 409×1        n=10 → 201×1, 409×9
  n=5  → 201×1, 409×4        n=25 → 201×1, 409×24
  25 rounds × 8 parallel     → exactly one winner, every round
  10 consecutive suite runs  → 10 passed, 0 failed
```

≈330 races, ≈2,660 booking requests, **zero double-bookings**.

**Design documents** (the source of truth this code implements):
[`docs/system-design.md`](docs/system-design.md) ·
[`docs/database-design.md`](docs/database-design.md) ·
[`docs/adr/`](docs/adr/) ·
[`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md) ·
[`docs/curl-examples.md`](docs/curl-examples.md)

---

## Contents

1. [Quick start](#quick-start)
2. [How the invariant works](#how-the-invariant-works)
3. [Running the tests](#running-the-tests)
4. [API](#api)
5. [Project layout](#project-layout)
6. [Configuration](#configuration)
7. [Operations](#operations)
8. [Troubleshooting](#troubleshooting)
9. [AI Collaboration Narrative](#ai-collaboration-narrative)
10. [What is deliberately not built](#what-is-deliberately-not-built)

---

## Quick start

**Prerequisites:** Node.js 24 LTS, Docker, Docker Compose. No AWS account, no LocalStack, no
cloud anything.

```bash
git clone <this-repo> && cd keyloop-unified-service-scheduler-nestjs
cp .env.example .env

docker compose up -d          # PostgreSQL 18 + Redis 8
npm install
npx prisma generate           # generate the typed client

npm run db:migrate            # apply the hand-written SQL migrations
npm run db:seed               # 1 dealership, 2 services, 2 technicians, 2 bays, 2 customers

npm run start:dev             # API on http://localhost:3000/v1
```

Then:

| URL | What |
|---|---|
| <http://localhost:3000/docs> | Swagger UI — the interactive contract |
| <http://localhost:3000/health> | Liveness |
| <http://localhost:3000/ready> | Readiness (DB hard-dependency; Redis reported but non-fatal) |
| <http://localhost:3000/metrics> | Prometheus metrics |

[`docs/curl-examples.md`](docs/curl-examples.md) walks the whole API from the shell — including a
20-way race you can watch resolve to a single `201`.

> **`npm run db:migrate`, never `prisma migrate dev`.** The invariant lives in hand-written SQL
> that Prisma cannot model declaratively. `migrate dev` reads those objects as drift and offers
> to drop them — which would silently delete the exclusion constraints this system exists to
> enforce.

---

## How the invariant works

Three layers, in order of authority.

### 1. The database is the sole authority

```sql
ALTER TABLE appointments
  ADD CONSTRAINT no_technician_overlap
  EXCLUDE USING gist (technician_id WITH =, during WITH &&)
  WHERE (status = 'CONFIRMED');
-- …and the same for service_bay_id.
```

`during` is a generated column, `tstzrange(start_time, end_time, '[)')`. PostgreSQL evaluates the
constraint atomically at write time, under the row lock the INSERT takes. No matter how many app
instances run, **at most one confirmed appointment can exist per resource per overlapping
window** — the violation is not caught, it is *impossible*.

Both constraints are **partial** on `status = 'CONFIRMED'`, which is why cancelling frees the slot
the instant it commits, with no delete and no compaction.

Half-open `[start, end)` means an appointment ending at 10:00 does not conflict with one starting
at 10:00 — back-to-back bookings are legal, which is the intuitive real-world behaviour.

### 2. The allocation loop — SAVEPOINT per candidate

```
BEGIN (READ COMMITTED)            -- not SERIALIZABLE: the constraint carries correctness,
                                  -- so the cheaper isolation level is sufficient
  SET LOCAL lock_timeout = '2s'   -- set BEFORE any savepoint, so no rollback can discard it
  for each (technician, bay):     -- ORDER BY technician_id, service_bay_id
    SAVEPOINT
    INSERT appointment + outbox row
      23P01 / 55P03 → ROLLBACK TO SAVEPOINT, try the next pair
      23505         → this request already committed; return that row
      success       → RELEASE, COMMIT
COMMIT with nothing inserted      → 409 NO_AVAILABILITY
40P01                             → restart the WHOLE transaction (bounded, ≈3)
```

Every line earns its place:

- **`SAVEPOINT` is not optional.** On PostgreSQL *any* error — `23P01` included — aborts the
  **entire** transaction; every subsequent statement fails with `25P02`. The obvious "catch the
  error and insert the next candidate" simply does not work. `test/integration/exclusion-constraint.spec.ts`
  pins this with an explicit `25P02` assertion, then shows `ROLLBACK TO SAVEPOINT` recovering.
- **`lock_timeout` is not optional either.** An exclusion violation is only raised *immediately*
  when the conflicting row is already committed. Against an **uncommitted** one the INSERT
  **blocks** — measured in the same suite as `55P03`, not `23P01`. Without the cap, one hot slot
  could pin a request indefinitely.
- **Deterministic candidate order** gives every request the same lock-acquisition order, which is
  what keeps deadlocks rare rather than routine.
- **`40P01` restarts the whole transaction** — a deliberate robustness choice, not a necessity. A
  deadlock is savepoint-recoverable like any error, but it signals a lock-ordering clash, and
  continuing under the locks already held would likely deadlock again.

### 3. Availability is advisory — always

`findCandidates()` narrows the search; it **never** decides correctness. Another request can
commit in the gap between that SELECT and our INSERT, and the constraint settles it. Treating the
read as authoritative would be precisely the check-then-insert race the whole design avoids.

Booking and `GET /availability` share one rule (`src/availability/candidate-sql.ts`) so the
preview and the booking decision can never disagree about what "available" means.

### Reliability: the transactional outbox

The appointment and its `outbox` row commit in the **same transaction**, closing both halves of
the dual-write problem: no notification for a booking that rolled back, and no lost notification
for one that committed. A relay then **leases** rows (pushing `available_at` forward inside a
`FOR UPDATE SKIP LOCKED` claim), commits, publishes, and marks each event individually.

Leasing rather than merely locking is the subtle part: releasing the lock while the row is still
`PENDING` and due would let a second relay re-publish it as *normal operation*, not just after a
crash.

---

## Running the tests

```bash
npm test                 # everything
npm run test:unit        # pure logic — no I/O, fast
npm run test:integration # repository + constraints, real PostgreSQL
npm run test:concurrency # THE SIGNATURE TEST
npm run test:e2e         # the HTTP surface via Supertest
```

| Suite | Tests | What it proves |
|---|---:|---|
| unit | 35 | Hours arithmetic, half-open boundaries, lunch-gap straddling, DST enumeration, the error catalog, tenant resolution |
| integration | 47 | The exclusion constraints themselves, the allocation loop's SQLSTATE branches, the outbox relay protocol, the reminder scan |
| concurrency | 8 | **Exactly one `201`** under N parallel bookings — the core claim |
| e2e | 75 | Every error code, idempotency incl. Redis-down, pagination, RBAC, cancel, availability, OpenAPI conformance |
| **Total** | **165** | |

Everything except `unit` needs **real PostgreSQL** — a `btree_gist` EXCLUDE constraint cannot be
mocked or emulated, and it is the thing under test. Testcontainers starts `postgres:18-alpine`
automatically.

> **If Docker is not reachable from your test process** (commonly: Docker Desktop with WSL
> integration disabled), point the suites at the running compose stack instead:
>
> ```bash
> TEST_DATABASE_URL="postgresql://scheduler:scheduler_dev_pw@localhost:5432/scheduler" npm test
> ```
>
> The proof is unchanged — still real PostgreSQL running the real constraint. CI uses the
> Testcontainers path.

### Watching the invariant hold

```bash
npm run test:concurrency
```

The suite fires 2, 5, 10 and 25 parallel bookings at one slot, then repeats 25 rounds of 8. It
also carries two tests that exist to keep the proof honest:

- **A control case.** The same burst against an *Oil Change* legitimately places **two**
  appointments (two qualified technicians, two bays) on distinct technicians and distinct bays.
  Asserting "exactly one 201" there would be asserting a falsehood — which is exactly why the
  proof must use Brake Inspection, where only one technician holds the `brakes` skill.
- **A non-vacuity check.** The double-booking detector is shown to actually fire, and the
  database is shown to refuse the bad state even when constructed by hand.

---

## API

All routes are under `/v1`. Full contract: [`openapi.yaml`](openapi.yaml) and `/docs`.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/appointments` | Requires `Idempotency-Key`. `201` / `409` |
| `GET` | `/appointments/{id}` | |
| `GET` | `/appointments` | Keyset (cursor) pagination, RBAC-scoped |
| `POST` | `/appointments/{id}/cancel` | **Idempotent** — `200` whether confirmed or already cancelled |
| `GET` | `/availability` | Advisory preview |
| `GET` | `/dealerships` `/service-types` `/technicians` `/service-bays` | Reference data |
| `GET` | `/health` `/ready` `/metrics` | Operational |

**Tenancy.** The dealership is resolved from the access token and is **never a request field**. A
resource belonging to another dealership returns `404`, not `403` — a different status would
confirm the row exists somewhere, which is the leak.

**Error envelope.** Every error is `{code, message, details, correlationId}`.

| HTTP | `code` | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Malformed body, a past start time, or a missing `Idempotency-Key` |
| `404` | `NOT_FOUND` | Not in the caller's dealership (including out-of-tenant) |
| `422` | `VEHICLE_OWNERSHIP_MISMATCH` | Vehicle exists here but belongs to another customer |
| `422` | `NO_QUALIFIED_TECHNICIAN` | Nobody here holds the required skills **at all** |
| `422` | `OUTSIDE_WORKING_HOURS` | Outside the **dealership's** opening hours |
| `409` | `NO_AVAILABILITY` | Qualified technicians exist, but no pair is free |
| `422` | `IDEMPOTENCY_KEY_REUSE` | Known key, different body |
| `403` | `FORBIDDEN` | Authentication/role — never used for cross-tenant references |
| `429` | `RATE_LIMITED` | |
| `500` | `INTERNAL_ERROR` | Logged with `correlationId`; never leaks internals |

Two distinctions in that table are load-bearing and separately tested: `422 NO_QUALIFIED_TECHNICIAN`
("nobody can do this") is a configuration miss, while `409 NO_AVAILABILITY` ("the one who can is
busy") is a state conflict that may succeed on retry. Likewise `OUTSIDE_WORKING_HOURS` covers only
the *dealership's* opening hours — a window inside those but outside every technician's own shift
is per-technician availability, and comes back `409`.

---

## Project layout

```
src/
  booking/          POST/cancel, THE ALLOCATION LOOP (allocation.service.ts), reads
  availability/     findCandidates + the shared rule + the day preview + hours arithmetic
  resources/        reference-data reads
  notifications/    NotificationPublisher port, in-process adapter, outbox relay, reminder cron
  common/           errors, auth/tenancy, idempotency, correlation, metrics, health, pagination
  prisma/           PrismaService (schema + migrations live in the root `prisma/`)
prisma/             schema.prisma, hand-written SQL migrations, seed
test/               unit · integration · concurrency · e2e
```

Two deviations from `CLAUDE.md`'s *suggested* layout, both deliberate:

- **`prisma/` is at the repo root**, not `src/prisma/`, because that is Prisma's own tooling
  convention and fighting it bought nothing. The Nest module/service do live in `src/prisma/`.
- **A second seeded dealership** beyond `database-design.md` §6's "1 dealership". Two design
  requirements need it and neither is servable by a single tenant: the "out-of-tenant reference →
  404" guarantee needs somewhere to *be* out of, and the DST enumeration case needs a zone that
  observes DST, which `Asia/Ho_Chi_Minh` never has.

---

## Configuration

All configuration comes from the environment; see [`.env.example`](.env.example). No secrets are
committed. The values the design pins are surfaced explicitly rather than buried:

| Variable | Default | Why it has that value |
|---|---|---|
| `BOOKING_LOCK_TIMEOUT_MS` | `2000` | Caps the wait on an uncommitted conflicting row |
| `BOOKING_TX_TIMEOUT_MS` | `10000` | Must exceed `lock_timeout` + loop work; Prisma's ~5s default would kill a legitimate wait |
| `BOOKING_DEADLOCK_RETRIES` | `3` | Bounded whole-transaction restarts on `40P01` |
| `IDEMPOTENCY_TTL_CREATED_SECONDS` | `86400` | Cached `201` replay window |
| `IDEMPOTENCY_TTL_CONFLICT_SECONDS` | `60` | Cached `409` — deliberately short; availability is time-sensitive |
| `OUTBOX_LEASE_SECONDS` | `30` | Must exceed worst-case single-batch publish time |
| `OUTBOX_MAX_ATTEMPTS` | `8` | Then `FAILED` — the DB equivalent of a dead-letter queue |
| `REMINDER_BAND_HOURS` | `1` | The scan band width; the cron interval must be smaller |

---

## Operations

- **Logs:** structured JSON (pino) with one correlation id shared by the response header, the log
  line, and every emitted event — so an async notification traces back to the booking that caused
  it. A client-supplied `x-correlation-id` is honoured. PII is redacted.
- **Metrics:** RED (`http_requests_total`, `http_request_duration_seconds`) plus domain series —
  `booking_confirmed_total`, `booking_conflicts_total`, `booking_candidate_attempts`,
  `booking_deadlock_retries_total`, `outbox_backlog`, `outbox_dead_letter_total`,
  `reminder_sent_total`.
- **Readiness** hard-depends on the database only. Redis is checked and reported as `degraded`,
  never fatal — bookings stay correct without it, so failing readiness would turn a tolerable
  degradation into an outage. There is an e2e test that boots the app against a dead Redis and
  asserts bookings still work.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Cannot find module '../generated/prisma/client'` | Run `npx prisma generate`. |
| Tests fail to start a container | Docker is not reachable from the test process. Use the `TEST_DATABASE_URL` escape hatch above, or enable Docker Desktop → Resources → WSL Integration. |
| Postgres container restart-loops on first run | You have a stale volume from a pre-18 image. `docker compose down -v` then `up -d`. PG18 wants the mount at `/var/lib/postgresql`, not `.../data`. |
| `prisma migrate dev` wants to drop constraints | Expected, and why you must not run it. Use `npm run db:migrate`. |
| `openapi.yaml` differs in CI | Run `npm run openapi:generate` and commit the result. |

---

## AI Collaboration Narrative

GenAI (Claude) was used as a **directed collaborator** across both the design and the code phase.
Every decision remained mine; model output was treated as a draft to be verified, never as truth.
The design-phase story is in [`docs/system-design.md` §16](docs/system-design.md#16-how-genai-assisted-the-design);
what follows is the **code phase**.

### How I directed it

- **Docs first, and the docs win.** The design was frozen before a line of code. `CLAUDE.md`
  states nine Golden Rules and one arbitration rule: if code and docs disagree, the docs win — or
  the doc is updated in the same commit, with the reason. That kept the model implementing a
  design rather than inventing one mid-file.
- **Hard part first.** The build order put the migration and the concurrency proof *before* the
  rest of the API. Anything that could invalidate the core had to surface in the first two
  milestones, not the last.
- **Demand measurement, not recall.** Where behaviour was load-bearing I required the model to
  *run* the case against real PostgreSQL and paste the output rather than assert what PostgreSQL
  does. Several entries in the table below exist only because of that rule.
- **Milestone gates.** Each milestone had written acceptance criteria, and nothing moved on with
  a failing test.

### Verification — what the AI got wrong, and how it was caught

These are real defects from this build. Each is followed by the mechanism that caught it, because
the mechanism is the transferable part.

| The AI's first attempt | Why it was wrong | Correction | Caught by |
|---|---|---|---|
| Assumed a concurrent same-key retry surfaces `23505`, per §6.3, and handled only that. | **Measured and false.** When two retries hit the same slot the INSERT violates the exclusion constraint *and* the idempotency index; PostgreSQL reports the **lower index OID** — `no_technician_overlap`, created first. The loop read it as a lost race and returned `409` to a client retrying its own booking. | Re-read the key on candidate exhaustion. `docs/system-design.md` §6.2/§6.3 updated with the measurement. | A written test, then a direct probe against PG 18 |
| Handled idempotent replay **only** inside the allocation loop. | On a *sequential* retry the original booking already occupies the slot, so `findCandidates` returns empty, the loop never reaches an INSERT, and no violation can occur. The retry got `409`. | Durable `(dealership_id, idempotency_key)` lookup moved **before** allocation, as §5.1's flow always showed. | An e2e test asserting a plain retry returns the original `201` |
| `localToUtc` probed the DST offset twice — with `pass * 0`, which is always zero. | Both probes were identical, so a fall-back overlap only ever found one instant, and it returned the **later** one. | Probe the offsets a day either side. | The DST unit test |
| Duplicated the availability predicate SQL into the day-preview query. | Compiled, passed every test, and would have drifted the first time anyone edited one copy — violating §6.7's "one shared rule". A preview that disagrees with booking is worse than none: it is confidently wrong. | Predicates extracted to `candidate-sql.ts`; both queries compose from them; two tests assert preview and booking agree. | Reading the code against §6.7 after the tests were green |
| Reminder-rollback test mocked the **test's** Prisma client, not the app's. | The mock never touched the code under test. It passed while proving nothing. | Replaced with a real `BEFORE INSERT` trigger that rejects reminder events, asserting `reminder_sent_at` did not stick. | Noticing the test passed for the wrong reason |
| `recordFailure` used `$2` as both a `smallint` and a `power()` argument. | PostgreSQL deduces one type per parameter: `42P08 inconsistent types deduced`. | Backoff computed in TypeScript, which also puts `least(2^n, 300)` in one testable place. | The relay failure test |
| Per-project `maxWorkers: 1` in the Jest config. | `maxWorkers` is a **global** option. Silently ignored, so two e2e files ran in parallel against one database and truncated each other's rows mid-test — surfacing as a booking that "succeeded" against an empty table. | `--runInBand` in the npm scripts. | A test failing with an impossible result |
| `canonicalize` v3 for RFC 8785 hashing. | ESM-only. It would have failed at **runtime** in a CommonJS build, not merely under Jest. | Pinned to v2. | Module resolution failure |
| `RedisService.onModuleDestroy` awaited `quit()` unconditionally. | On a client stuck reconnecting to a dead port there is nobody to answer, so graceful shutdown hung indefinitely. | Quit only when ready, bounded by a timeout, then hard-disconnect. | A test run that hung for ten minutes |

### The one that matters most

The design's §16.2 already records the AI's original claim that you could *"catch the error and
try the next candidate in the same transaction"* — false on PostgreSQL, and the reason SAVEPOINTs
exist in this design. In the code phase I turned that correction into an **executable assertion**:
`test/integration/exclusion-constraint.spec.ts` issues a bare `SELECT 1` after a `23P01` and
asserts it fails with `25P02`, then shows `ROLLBACK TO SAVEPOINT` recovering and the next
candidate committing.

A prose correction can rot. A test cannot.

### How final quality was ensured

- **Executable proof over prose.** The central claim is not argued, it is tested — and the test
  suite includes a control case and a non-vacuity check so a green run cannot be a false positive.
- **Real infrastructure everywhere it matters.** No mocked database on any path that touches the
  invariant. Fault injection uses real database triggers and real dead ports, not stubs.
- **Verified the risky ORM assumption before building on it.** Prisma 7's interactive transaction
  tolerating a caught error plus `ROLLBACK TO SAVEPOINT` was *checked against a live database*
  before the allocation loop was written — the whole milestone depended on it.
- **Docs kept in sync.** The one place implementation contradicted the design, the design document
  was updated in the same commit with the measurement and the reasoning, per `CLAUDE.md`.

---

## What is deliberately not built

Real AWS resources, LocalStack, `cdk deploy`, multi-region, payments/invoicing, a production UI,
RBAC beyond the stubbed guard, and `COMPLETED`/`NO_SHOW` states. Design foresight for these lives
in the docs; building them was out of scope.

Known limitations, stated rather than hidden:

- **Authentication is a stub** (§14, R-4). The token is an unsigned base64url claims blob. The
  seam is real — swapping in JWT verification changes one file — but this is not production-secure.
- **RLS is designed, not enabled.** Tenant isolation is enforced in the application layer this
  iteration; §14 specifies the `SET LOCAL` GUC approach for production hardening.
- **`end_time = start_time + duration` is app-enforced** (db §5.9). The database guarantees only
  `end_time > start_time`.
- **Windows crossing midnight are rejected**, and short-notice bookings (<24h) get no separate
  T-24h reminder (R-7) — both documented assumptions, not oversights.
- **`npm run db:reset` is unverified.** Prisma 7 refuses `migrate reset` when it detects an AI
  agent, since it irreversibly destroys the database. The clean-slate path was proved instead by
  destroying the Docker volume and re-running migrate + seed.
