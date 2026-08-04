/**
 * SQLSTATE extraction.
 *
 * The allocation loop dispatches entirely on the SQLSTATE PostgreSQL raised (§6.2), so getting
 * this wrong would silently turn "try the next candidate" into "500". Prisma 7 wraps a driver
 * error as `PrismaClientKnownRequestError` with its own code `P2010` and buries the real code at
 * `meta.driverAdapterError.cause.code`; a plain `pg` error carries `.code` directly. Both shapes
 * are unwrapped here so no call site has to know which client raised it.
 */

/** The SQLSTATEs the design names and handles (§6.2). */
export const SQLSTATE = {
  /** exclusion_violation — another request won the race for this technician/bay window. */
  EXCLUSION_VIOLATION: '23P01',
  /** unique_violation — the (dealership_id, idempotency_key) backstop, i.e. a concurrent retry. */
  UNIQUE_VIOLATION: '23505',
  /** lock_timeout — waited too long on an uncommitted conflicting row (a hot slot). */
  LOCK_TIMEOUT: '55P03',
  /** deadlock_detected — restart the whole transaction, by choice (§6.2). */
  DEADLOCK_DETECTED: '40P01',
  /** in_failed_sql_transaction — a statement issued after an unrecovered error. */
  IN_FAILED_TRANSACTION: '25P02',
  /** check_violation. */
  CHECK_VIOLATION: '23514',
  /** serialization_failure. */
  SERIALIZATION_FAILURE: '40001',
} as const;

export type SqlState = (typeof SQLSTATE)[keyof typeof SQLSTATE];

/** Constraint names, so the loop can tell a technician conflict from a bay conflict. */
export const CONSTRAINT = {
  NO_TECHNICIAN_OVERLAP: 'no_technician_overlap',
  NO_BAY_OVERLAP: 'no_bay_overlap',
  IDEMPOTENCY_KEY_UNIQUE: 'appointments_idempotency_key_uniq',
} as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Returns the PostgreSQL SQLSTATE behind an error, whatever client produced it. */
export function sqlStateOf(error: unknown): string | undefined {
  const err = asRecord(error);
  if (!err) return undefined;

  // Plain `pg` error.
  if (typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) && err.code !== 'P2010') {
    return err.code;
  }

  // Prisma 7 driver-adapter wrapping.
  const cause = asRecord(asRecord(asRecord(err.meta)?.driverAdapterError)?.cause);
  const nested = cause?.code ?? cause?.originalCode;
  if (typeof nested === 'string') return nested;

  // Last resort: Prisma renders it into the message as `Code: `23P01``.
  const message = typeof err.message === 'string' ? err.message : '';
  return /Code: `([0-9A-Z]{5})`/.exec(message)?.[1];
}

/**
 * Returns the violated constraint's name. Prisma does not surface it as a field, so for the
 * wrapped case it is read out of the driver message.
 */
export function constraintOf(error: unknown): string | undefined {
  const err = asRecord(error);
  if (!err) return undefined;

  if (typeof err.constraint === 'string') return err.constraint;

  const cause = asRecord(asRecord(asRecord(err.meta)?.driverAdapterError)?.cause);
  const text = [cause?.message, cause?.originalMessage, err.message]
    .filter((v): v is string => typeof v === 'string')
    .join(' ');

  return /constraint "([^"]+)"/.exec(text)?.[1] ?? /index "([^"]+)"/.exec(text)?.[1];
}

export function isSqlState(error: unknown, ...states: readonly string[]): boolean {
  const state = sqlStateOf(error);
  return state !== undefined && states.includes(state);
}
