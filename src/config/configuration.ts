/**
 * Typed configuration, sourced exclusively from the environment (§14 — no secrets in code).
 * Every knob that the design pins by value (lock_timeout, lease seconds, TTLs) is surfaced
 * here with the documented default so it is visible and tunable without a code change.
 */

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly logLevel: string;
  readonly database: {
    readonly url: string;
    /** `pg.Pool` max size (§10: `instances × poolSize` must stay under `max_connections`). */
    readonly poolSize: number;
  };
  readonly redis: {
    readonly url: string;
  };
  readonly booking: {
    /** SET LOCAL lock_timeout inside the allocation transaction (§6.2). */
    readonly lockTimeoutMs: number;
    /** Prisma interactive-transaction timeout; must exceed lock_timeout + loop work (§6.2). */
    readonly txTimeoutMs: number;
    /** Bounded whole-transaction restarts on 40P01 deadlock_detected (§6.2). */
    readonly deadlockRetries: number;
  };
  readonly idempotency: {
    /** Cached 201 replay window (§6.3). */
    readonly createdTtlSeconds: number;
    /** Cached 409 replay window — deliberately short; availability is time-sensitive (§6.3). */
    readonly conflictTtlSeconds: number;
  };
  readonly outbox: {
    readonly relayEnabled: boolean;
    readonly pollIntervalMs: number;
    readonly batchSize: number;
    readonly leaseSeconds: number;
    readonly maxAttempts: number;
  };
  readonly reminder: {
    readonly enabled: boolean;
    readonly leadHours: number;
    readonly bandHours: number;
  };
  readonly auth: {
    readonly enabled: boolean;
    /**
     * Dev/local convenience only: the dealership every request is treated as when `enabled` is
     * false, so protected routes still have a tenant to scope on instead of every
     * `@CurrentPrincipal()` handler throwing 403 with no principal ever set (§14). Empty when
     * `enabled` is true — nothing reads it in that case. Guaranteed non-empty when `enabled` is
     * false; `loadConfiguration` throws at boot otherwise rather than failing per-request.
     */
    readonly devDealershipId: string;
  };
  readonly rateLimit: {
    /** Off by default under NODE_ENV=test so the concurrency suite's parallel bursts and the
     *  e2e suite's sequential-retry loops are never throttled without every test file having to
     *  know that. Explicit RATE_LIMIT_ENABLED still wins, so a suite can opt back in. */
    readonly enabled: boolean;
    /** API-wide default window, applied per client IP. */
    readonly windowMs: number;
    readonly max: number;
  };
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected an integer, received "${value}"`);
  }
  return parsed;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

function authConfig(): AppConfig['auth'] {
  const enabled = bool(process.env.AUTH_ENABLED, true);
  const devDealershipId = process.env.AUTH_DEV_DEALERSHIP_ID ?? '';
  if (!enabled && devDealershipId === '') {
    throw new Error(
      'AUTH_DEV_DEALERSHIP_ID is required when AUTH_ENABLED=false (see .env.example)',
    );
  }
  return { enabled, devDealershipId };
}

export function loadConfiguration(): AppConfig {
  const nodeEnv = (process.env.NODE_ENV ?? 'development') as AppConfig['nodeEnv'];

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (see .env.example)');
  }

  return {
    nodeEnv,
    port: int(process.env.PORT, 3000),
    logLevel: process.env.LOG_LEVEL ?? (nodeEnv === 'production' ? 'info' : 'debug'),
    database: { url: databaseUrl, poolSize: int(process.env.DATABASE_POOL_SIZE, 20) },
    redis: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' },
    booking: {
      lockTimeoutMs: int(process.env.BOOKING_LOCK_TIMEOUT_MS, 2000),
      txTimeoutMs: int(process.env.BOOKING_TX_TIMEOUT_MS, 10_000),
      deadlockRetries: int(process.env.BOOKING_DEADLOCK_RETRIES, 3),
    },
    idempotency: {
      createdTtlSeconds: int(process.env.IDEMPOTENCY_TTL_CREATED_SECONDS, 86_400),
      conflictTtlSeconds: int(process.env.IDEMPOTENCY_TTL_CONFLICT_SECONDS, 60),
    },
    outbox: {
      relayEnabled: bool(process.env.OUTBOX_RELAY_ENABLED, true),
      pollIntervalMs: int(process.env.OUTBOX_POLL_INTERVAL_MS, 1000),
      batchSize: int(process.env.OUTBOX_BATCH_SIZE, 100),
      leaseSeconds: int(process.env.OUTBOX_LEASE_SECONDS, 30),
      maxAttempts: int(process.env.OUTBOX_MAX_ATTEMPTS, 8),
    },
    reminder: {
      enabled: bool(process.env.REMINDER_CRON_ENABLED, true),
      leadHours: int(process.env.REMINDER_LEAD_HOURS, 24),
      bandHours: int(process.env.REMINDER_BAND_HOURS, 1),
    },
    auth: authConfig(),
    rateLimit: {
      enabled: bool(process.env.RATE_LIMIT_ENABLED, nodeEnv !== 'test'),
      windowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
      max: int(process.env.RATE_LIMIT_MAX, 120),
    },
  };
}

export const CONFIG_NAMESPACE = 'app';
