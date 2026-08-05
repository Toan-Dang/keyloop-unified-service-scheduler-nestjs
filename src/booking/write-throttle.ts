/**
 * Rate limit for the two appointment-mutating routes (`POST /appointments`,
 * `POST /appointments/:id/cancel`), tighter than the API-wide default
 * (`RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`, §14) because both do real transactional writes —
 * `POST /appointments` up to N SAVEPOINT attempts against Postgres per call — not a read.
 *
 * Fixed rather than env-driven: `@Throttle` metadata is set at class-definition time, before
 * `ConfigModule` has parsed `.env`, so an env var read here would only ever see a value already
 * present in the process (fine in prod/docker, silently ignored from a local `.env` file).
 * `RATE_LIMIT_ENABLED=false` (the default under NODE_ENV=test) still turns this off — the
 * module's `skipIf` gates every named throttler, including per-route overrides of `default`.
 */
export const APPOINTMENT_WRITE_THROTTLE = { default: { limit: 20, ttl: 10_000 } };
