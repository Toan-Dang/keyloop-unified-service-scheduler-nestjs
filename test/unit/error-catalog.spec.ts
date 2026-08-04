import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../src/common/errors/app.exception';
import { ERROR_STATUS, ErrorCode } from '../../src/common/errors/error-codes';

/**
 * The error catalog is part of the API contract (§7.1). These assertions pin the
 * code → status mapping so a refactor cannot quietly turn a 409 into a 422 — the distinction
 * between "genuine state conflict" and "deterministic pre-check failure" is load-bearing.
 */
describe('error catalog (§7.1)', () => {
  it('maps every catalog code to its documented HTTP status', () => {
    expect(ERROR_STATUS[ErrorCode.VALIDATION_ERROR]).toBe(HttpStatus.BAD_REQUEST);
    expect(ERROR_STATUS[ErrorCode.NOT_FOUND]).toBe(HttpStatus.NOT_FOUND);
    expect(ERROR_STATUS[ErrorCode.VEHICLE_OWNERSHIP_MISMATCH]).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect(ERROR_STATUS[ErrorCode.NO_QUALIFIED_TECHNICIAN]).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(ERROR_STATUS[ErrorCode.OUTSIDE_WORKING_HOURS]).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(ERROR_STATUS[ErrorCode.IDEMPOTENCY_KEY_REUSE]).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(ERROR_STATUS[ErrorCode.NO_AVAILABILITY]).toBe(HttpStatus.CONFLICT);
    expect(ERROR_STATUS[ErrorCode.FORBIDDEN]).toBe(HttpStatus.FORBIDDEN);
    expect(ERROR_STATUS[ErrorCode.RATE_LIMITED]).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(ERROR_STATUS[ErrorCode.INTERNAL_ERROR]).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it('carries the code, message and details on the exception body', () => {
    const err = AppException.noAvailability({ candidatesTried: 4 });

    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.code).toBe(ErrorCode.NO_AVAILABILITY);
    expect(err.details).toEqual({ candidatesTried: 4 });
    expect(err.getResponse()).toMatchObject({ code: ErrorCode.NO_AVAILABILITY });
  });

  it('reports an out-of-tenant reference as NOT_FOUND, never FORBIDDEN (no existence leak)', () => {
    const err = AppException.notFound('Customer', 'some-id');

    expect(err.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(err.code).toBe(ErrorCode.NOT_FOUND);
  });
});
