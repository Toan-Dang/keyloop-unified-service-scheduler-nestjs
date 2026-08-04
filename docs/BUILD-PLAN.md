# BUILD-PLAN.md — Implementation sequence

Ordered milestones for the code phase. Build the **hard, load-bearing part first** (schema + the concurrency proof), then widen. This file lives in `docs/`; section refs (§) point to `system-design.md` (sibling), schema detail is in `database-design.md` (sibling). Read **`../CLAUDE.md`** (repo root) for the invariants that must hold throughout.

Each milestone lists **acceptance criteria** — do not move on until they pass.

---

## M0 — Scaffold & infra (foundations)

- NestJS 11 + TypeScript 5.9 (strict) project; ESLint/Prettier; pino logger; config from env.
- `docker-compose.yml`: Postgres 18 + Redis 8.
- Prisma 7 wired to Postgres; health/readiness (`/health`, `/ready` — DB hard-dep, Redis non-fatal, §13), `/metrics` (prom-client).
- GitHub Actions CI: lint + typecheck + test.

**Acceptance:** `docker compose up -d` then `npm run start:dev` boots; `/health` 200; CI green on an empty test.

## M1 — Schema & migrations (the foundation of correctness)

- Prisma models for all tables (`database-design.md` §2). `dealership_id` on every tenant-owned table.
- **Raw-SQL migration** (hand-written, runs alongside Prisma): `CREATE EXTENSION btree_gist`; `appointment_status` + `outbox_status` enums; generated `during` column; the **two partial EXCLUDE constraints**; partial unique `(dealership_id, idempotency_key)`; partial reminder index; `outbox` table; `CHECK (duration_minutes > 0)`; `CHECK (end_time > start_time)`; tenant-scoped unique indexes (`(dealership_id, email)`, `(dealership_id, vin)`); FK + supporting indexes (§4).
- Seed fixture (§6 of database-design.md): 1 dealership (`Asia/Ho_Chi_Minh`, Mon–Sat 08:00–18:00), 2 service types (Oil Change 60m `['general']`, **Brake Inspection 90m `['brakes']`**), 2 technicians (`['general']` and `['general','brakes']`), 2 bays, 2 customers each with 1 vehicle.

**Acceptance:** migrate + seed clean on a fresh DB; a raw SQL test proves an overlapping second `CONFIRMED` insert for the same technician is rejected with SQLSTATE `23P01`, and a cancelled row frees the slot.

## M2 — The concurrency proof (do this before the rest of the API)

- Minimal `POST /appointments` happy path: resolve service window, `findCandidates` (§6.7), allocation loop with SAVEPOINT + `READ COMMITTED` + `lock_timeout` + deterministic order + `40P01` whole-tx retry (§6.2), persist appointment **+ outbox row in one transaction**.
- **Concurrency test (signature):** N parallel bookings for one **Brake Inspection** slot ⇒ exactly one `201`, rest `409 NO_AVAILABILITY`. Testcontainers + real Postgres.

**Acceptance:** the concurrency test passes reliably (run it 100×/in a loop); zero double-bookings ever observed.

## M3 — Booking robustness

- Idempotency (§6.3): required `Idempotency-Key`; `(dealership_id, key)` unique + `request_hash`; Redis fast path (201/409 TTLs); `422` on key+different-body.
- Deterministic pre-checks → correct error codes (§5.1, §7.1): past start (`400`), out-of-tenant ref (`404`), `VEHICLE_OWNERSHIP_MISMATCH` (`422`), `NO_QUALIFIED_TECHNICIAN` (`422`), `OUTSIDE_WORKING_HOURS` (`422`).
- Working/opening-hours evaluation with timezone + single-range fit + half-open (§6.7).

**Acceptance:** e2e tests for each error code; idempotent retry returns the original `201`; the hours logic has unit tests incl. lunch-gap and boundary cases.

## M4 — Remaining endpoints + contract

- `GET /appointments/{id}`, `GET /appointments` (keyset pagination + RBAC: customer sees only own, §14), `POST /appointments/{id}/cancel` (idempotent, §5.2), `GET /availability` (advisory, `bookable = min(free techs, free bays)`, §7.2), reference-data reads.
- OpenAPI 3 spec published at `/docs` and committed as `openapi.yaml`; cURL examples.

**Acceptance:** responses conform to the OpenAPI schema (contract test); cancel frees the slot; availability preview matches booking outcomes.

## M5 — Notifications & reminders (local)

- `NotificationPublisher` port + in-process `@nestjs/event-emitter` adapter (ADR-005); consumer logs/mocks the email.
- **Outbox relay**: lease-on-claim → publish → mark `SENT`; backoff/`FAILED` on failure (§6.6, db §2.8).
- Reminder cron (`@nestjs/schedule`, every ~10m): gate-first `UPDATE ... reminder_sent_at ... RETURNING` → outbox (§5.3).

**Acceptance:** booking emits exactly one delivered `AppointmentConfirmed` (dedupe on `event_id`); relay survives a simulated publish failure (row retried, not lost); no duplicate reminders when two scheduler instances run.

## M6 — Docs, observability polish, video

- README: build/run/test + **AI Collaboration Narrative** (from §16, incl. the "AI got it wrong → I caught it" table).
- Confirm logs/metrics/traces (§13); tidy.
- Record the 5–10 min video: intro + scenario, design highlights (exclusion constraint, outbox, tenant scoping), AI collaboration story (1–2 min), live demo (run the concurrency test on camera), what you learned.

**Acceptance:** a reviewer can `git clone` → `docker compose up` → run tests → see the concurrency proof, guided only by the README.

---

### Priority if time runs short (16h budget)

Must-have: M0–M4 + the concurrency test + README/AI-narrative + video. Nice-to-have: full M5 relay polish (an EventEmitter stub is enough), `GET /availability`, Redis fast-path (the DB backstop already guarantees idempotency), full metrics. Never cut: the exclusion constraints, the allocation loop, and the concurrency test — that is the whole point.
