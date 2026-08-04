import { HttpStatus } from '@nestjs/common';

/**
 * The error catalog — system-design.md §7.1, verbatim.
 * Codes are part of the API contract; do not rename without a /v2.
 */
export const ErrorCode = {
  /** Malformed body / invalid fields, incl. a past `desiredStartTime` or a missing Idempotency-Key. */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Referenced resource does not exist *within the caller's dealership* — out-of-tenant also 404. */
  NOT_FOUND: 'NOT_FOUND',
  /** Vehicle exists in the tenant but is not owned by the given customer. */
  VEHICLE_OWNERSHIP_MISMATCH: 'VEHICLE_OWNERSHIP_MISMATCH',
  /** No technician in the dealership holds the required skills at all — a configuration miss. */
  NO_QUALIFIED_TECHNICIAN: 'NO_QUALIFIED_TECHNICIAN',
  /** Window not within the *dealership's* opening hours — a property of the request alone. */
  OUTSIDE_WORKING_HOURS: 'OUTSIDE_WORKING_HOURS',
  /** Qualified technicians exist, but no (technician + bay) pair is free — a genuine state conflict. */
  NO_AVAILABILITY: 'NO_AVAILABILITY',
  /** Known Idempotency-Key reused with a different body (fingerprint mismatch). */
  IDEMPOTENCY_KEY_REUSE: 'IDEMPOTENCY_KEY_REUSE',
  /** Authenticated but the role lacks permission. Never used for cross-tenant refs (those are 404). */
  FORBIDDEN: 'FORBIDDEN',
  /** Rate limit exceeded; carries Retry-After. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Unexpected server error — logged with correlationId, never leaks internals. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_STATUS: Readonly<Record<ErrorCodeValue, HttpStatus>> = {
  [ErrorCode.VALIDATION_ERROR]: HttpStatus.BAD_REQUEST,
  [ErrorCode.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.VEHICLE_OWNERSHIP_MISMATCH]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.NO_QUALIFIED_TECHNICIAN]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.OUTSIDE_WORKING_HOURS]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.NO_AVAILABILITY]: HttpStatus.CONFLICT,
  [ErrorCode.IDEMPOTENCY_KEY_REUSE]: HttpStatus.UNPROCESSABLE_ENTITY,
  [ErrorCode.FORBIDDEN]: HttpStatus.FORBIDDEN,
  [ErrorCode.RATE_LIMITED]: HttpStatus.TOO_MANY_REQUESTS,
  [ErrorCode.INTERNAL_ERROR]: HttpStatus.INTERNAL_SERVER_ERROR,
};
