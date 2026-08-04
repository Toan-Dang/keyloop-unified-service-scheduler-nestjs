# CLAUDE.md — Working instructions for the code phase

> **Repo layout:** this `CLAUDE.md` lives at the repo **root**; all design docs live under **`docs/`**.
> Read this first, then treat the design docs as the source of truth:
> **`docs/system-design.md`** (architecture, API, concurrency, NFRs), **`docs/database-design.md`** (schema, DDL, indexes), **`docs/adr/`** (6 decisions), **`docs/infrastructure.drawio`** / **`docs/infrastructure-local.drawio`**, and **`docs/BUILD-PLAN.md`** (build sequence).
> If code and these docs disagree, the docs win — or update the docs in the same change and say why. Section refs below (§) are into `docs/system-design.md` unless noted.

## What we are building

A backend **Unified Service Scheduler** (Scenario A). A customer requests a service appointment for a vehicle at a dealership; the system verifies — **in real time and under concurrency** — that **both a qualified technician and a service bay** are free for the whole service duration, then persists a confirmed appointment. The hard part is **preventing double-booking under concurrent requests**, not CRUD.

**Layer to implement:** Backend only. The client is stubbed via the OpenAPI spec + cURL + tests.
**Run model:** local-first via `docker-compose` (Postgres + Redis). **No AWS account, no LocalStack.** AWS is design-only (see §11 of `docs/system-design.md`).

## Golden rules — invariants that must never be broken

These are load-bearing. Do not "simplify" them away. Section refs are to `system-design.md`.

1. **The database is the sole authority for no-double-booking (§6.1, ADR-001).** Two partial `btree_gist` EXCLUDE constraints on `appointments` (per technician, per bay; `WHERE status='CONFIRMED'`) over a generated `during tstzrange(start,end,'[)')` column. Never rely on an application-level "check then insert" for correctness.
2. **Isolation = `READ COMMITTED` (§6.2).** Do **not** use SERIALIZABLE — the constraint carries correctness.
3. **Allocation loop = SAVEPOINT per candidate (§6.2).** Query candidate `(technician, bay)` pairs **in deterministic order** (`ORDER BY technician_id, service_bay_id`), then per pair: `SAVEPOINT` → INSERT → on `23P01`/`55P03` `ROLLBACK TO SAVEPOINT` and try next; on `23505` return the existing appointment; on success `RELEASE` + `COMMIT`. `SET LOCAL lock_timeout='2s'`. On `40P01` (deadlock) abort and **restart the whole transaction** (bounded retry ≈3) — deliberate choice, not a savepoint-local recovery.
4. **Availability is advisory; the SELECT never decides correctness (§6.7).** Booking and `GET /availability` share one `findCandidates` function.
5. **Notifications via transactional outbox (§6.6, ADR-006).** Write the `outbox` row in the **same transaction** as the appointment. A relay **leases** rows (`UPDATE ... SET available_at = now()+30s ... FOR UPDATE SKIP LOCKED RETURNING`, without bumping `attempts`), commits, publishes, then marks `SENT` per event; `attempts++` only on real failure. At-least-once → consumers idempotent on `event_id`.
6. **Multi-tenant everywhere (§14).** `dealership_id` on every tenant-owned table. Tenant comes **only from the auth token**, never the request body. Out-of-tenant references → `404`. Production isolation = RLS with **`SET LOCAL`** inside each transaction (every read is transaction-wrapped; GUC set right after `BEGIN`, before savepoints; Prisma prepared statements off under PgBouncer).
7. **Idempotency (§6.3).** `POST /appointments` requires an `Idempotency-Key`. Durable uniqueness = `(dealership_id, idempotency_key)`; store a `request_hash` (SHA-256, RFC 8785 JCS canonical body) on the row; same key + different body → `422`. Redis is the fast path (201 cached ~24h, 409 cached ~60s, best-effort).
8. **Time (§2, §6.7).** All timestamps `timestamptz` in **UTC**. Overlap windows are **half-open** `[start, end)`. Working/opening hours are local wall-clock JSONB evaluated via the dealership timezone; a window must fit inside a single contiguous range.
9. **Cancel is idempotent (§5.2).** `200` whether it was `CONFIRMED` or already `CANCELLED`; `404` only if the id doesn't exist in the tenant. No `ALREADY_CANCELLED` error.

## Prove it — the signature test

A **concurrency test** fires N parallel `POST /appointments` for the **same slot of a single-qualified-technician service (Brake Inspection in the seed)** and asserts **exactly one `201`, the rest `409`** (§6.5, §12). Booking an Oil Change (two qualified techs, two bays) would allow two valid appointments and must NOT be used for this test. Use **Testcontainers with real Postgres** — the exclusion constraint must actually run.

## Tech stack (pinned — Aug 2026 baseline)

Node.js 24 LTS · TypeScript 5.9 (strict) · NestJS 11 · PostgreSQL 18 (native `uuidv7()`, `btree_gist`) · Prisma 7 · Redis 8 (ioredis) · `@nestjs/event-emitter` (local notification adapter) · `@nestjs/schedule` (reminder cron) · OpenAPI 3 (`@nestjs/swagger`) · Jest 30 + Supertest + Testcontainers · pino (nestjs-pino) · prom-client · Docker + docker-compose.

> The `btree_gist` extension, the exclusion constraints, the generated `during` column, and the partial indexes are **hand-written raw-SQL migrations** (beyond Prisma's declarative surface). The savepoint allocation loop uses a manually held transaction (`$executeRawUnsafe('SAVEPOINT ...')`), not `prisma.$transaction` sugar; raise the interactive-tx timeout to ~10s.

## Suggested module layout (modular monolith)

```
src/
  app.module.ts
  booking/         # POST/cancel appointments, allocation loop (the core)
  availability/    # findCandidates() shared by booking + GET /availability
  resources/       # technicians, bays, service-types, dealerships (read models + seed)
  notifications/   # NotificationPublisher port + in-process adapter + outbox relay + reminder cron
  common/          # idempotency, error envelope, tenant guard, correlation-id, health/metrics
  prisma/          # schema.prisma + migrations/ (incl. raw-SQL)
test/              # unit, integration (Testcontainers), concurrency, e2e (Supertest)
```

## Commands (target — implement these)

- `docker compose up -d` → Postgres + Redis.
- `npm run db:migrate && npm run db:seed` → schema + seed fixture (§6 of `docs/database-design.md`).
- `npm run start:dev` → API on `/v1`, Swagger at `/docs`, `/health` `/ready` `/metrics`.
- `npm test` (unit + integration), `npm run test:concurrency`, `npm run test:e2e`.

The README must document build/run/test **and** contain the **AI Collaboration Narrative** (draw from `docs/system-design.md` §16 — including the "AI got it wrong, I caught it" table).

## Conventions

- Errors use the envelope `{code, message, details, correlationId}`; codes per §7.1. Never leak internals.
- Routes are `/v1/...`; list endpoints use **keyset (cursor) pagination** (not OFFSET).
- Structured JSON logs (pino) with a correlation id propagated onto emitted events; RED + domain metrics (§13).
- No secrets in code/repo; config from env.
- Every DB write that must reflect immediately is read from the primary (read-after-write, §11.2).

## Definition of done (per feature)

Compiles under `tsc --strict`; unit + integration tests green; the concurrency invariant test green; endpoint conforms to the OpenAPI schema; logs/metrics emitted; no secret committed.

## Out of scope (do NOT build)

Real AWS resources, LocalStack, `cdk deploy`, multi-region, payments/invoicing, a production UI, RBAC beyond the stubbed guard, `COMPLETED`/`NO_SHOW` states (Risks §18). Design foresight for these lives in the docs only.

## Build order

Follow **`docs/BUILD-PLAN.md`** — migration + concurrency test come **first**, before the rest of the API.
