import { HttpException } from '@nestjs/common';
import { ERROR_STATUS, ErrorCode, type ErrorCodeValue } from './error-codes';

export type ErrorDetails = Record<string, unknown>;

/**
 * The single domain error type. Carries a catalog code (§7.1); the HTTP status is derived
 * from the code so a code can never be mapped inconsistently across call sites.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCodeValue,
    message: string,
    readonly details: ErrorDetails = {},
  ) {
    super({ code, message, details }, ERROR_STATUS[code]);
  }

  static validation(message: string, details: ErrorDetails = {}): AppException {
    return new AppException(ErrorCode.VALIDATION_ERROR, message, details);
  }

  /**
   * Out-of-tenant references funnel here too: from the caller's view the row does not exist,
   * so there is no existence leak across dealerships (§14).
   */
  static notFound(resource: string, id?: string): AppException {
    return new AppException(
      ErrorCode.NOT_FOUND,
      `${resource} not found`,
      id === undefined ? { resource } : { resource, id },
    );
  }

  static vehicleOwnershipMismatch(vehicleId: string, customerId: string): AppException {
    return new AppException(
      ErrorCode.VEHICLE_OWNERSHIP_MISMATCH,
      'The vehicle is not owned by the given customer',
      { vehicleId, customerId },
    );
  }

  static noQualifiedTechnician(serviceTypeId: string, requiredSkills: string[]): AppException {
    return new AppException(
      ErrorCode.NO_QUALIFIED_TECHNICIAN,
      'No technician at this dealership holds the skills required by this service',
      { serviceTypeId, requiredSkills },
    );
  }

  static outsideWorkingHours(details: ErrorDetails = {}): AppException {
    return new AppException(
      ErrorCode.OUTSIDE_WORKING_HOURS,
      'The requested window is outside the dealership opening hours',
      details,
    );
  }

  static noAvailability(details: ErrorDetails = {}): AppException {
    return new AppException(
      ErrorCode.NO_AVAILABILITY,
      'No technician and service bay pair is free for the requested window',
      details,
    );
  }

  static idempotencyKeyReuse(idempotencyKey: string): AppException {
    return new AppException(
      ErrorCode.IDEMPOTENCY_KEY_REUSE,
      'This Idempotency-Key was already used with a different request body',
      { idempotencyKey },
    );
  }

  static forbidden(message = 'Insufficient permissions for this action'): AppException {
    return new AppException(ErrorCode.FORBIDDEN, message);
  }
}
