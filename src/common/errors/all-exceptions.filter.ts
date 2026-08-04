import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { getCorrelationId } from '../correlation/correlation';
import { AppException } from './app.exception';
import { ErrorCode, type ErrorCodeValue } from './error-codes';

export interface ErrorEnvelope {
  code: ErrorCodeValue;
  message: string;
  details: Record<string, unknown>;
  correlationId: string;
}

/**
 * Every error leaves the process through this filter in the envelope
 * `{code, message, details, correlationId}` (§7.1). Internals are never leaked: an unexpected
 * throw is logged in full with its correlation id and answered with a generic INTERNAL_ERROR.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId = getCorrelationId();

    const { status, envelope } = this.toEnvelope(exception, correlationId);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { correlationId, method: request.method, url: request.url, err: exception },
        'Unhandled error',
      );
    } else {
      this.logger.warn(
        {
          correlationId,
          method: request.method,
          url: request.url,
          code: envelope.code,
          status,
        },
        'Request rejected',
      );
    }

    response.status(status).json(envelope);
  }

  private toEnvelope(
    exception: unknown,
    correlationId: string,
  ): { status: HttpStatus; envelope: ErrorEnvelope } {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        envelope: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
          correlationId,
        },
      };
    }

    if (exception instanceof HttpException) {
      return {
        status: exception.getStatus(),
        envelope: {
          ...mapHttpException(exception),
          correlationId,
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      envelope: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'An unexpected error occurred',
        details: {},
        correlationId,
      },
    };
  }
}

/**
 * Framework-raised HttpExceptions (ValidationPipe, 404 route, throttler) are re-shaped into the
 * catalog rather than passed through, so clients only ever see documented codes.
 */
function mapHttpException(exception: HttpException): Omit<ErrorEnvelope, 'correlationId'> {
  const status: HttpStatus = exception.getStatus();
  const body = exception.getResponse();

  if (status === HttpStatus.BAD_REQUEST) {
    const fieldErrors = extractValidationMessages(body);
    return {
      code: ErrorCode.VALIDATION_ERROR,
      message: 'Request validation failed',
      details: fieldErrors.length > 0 ? { fieldErrors } : {},
    };
  }

  const code: ErrorCodeValue =
    status === HttpStatus.NOT_FOUND
      ? ErrorCode.NOT_FOUND
      : status === HttpStatus.FORBIDDEN
        ? ErrorCode.FORBIDDEN
        : status === HttpStatus.TOO_MANY_REQUESTS
          ? ErrorCode.RATE_LIMITED
          : status === HttpStatus.UNAUTHORIZED
            ? ErrorCode.FORBIDDEN
            : status >= HttpStatus.INTERNAL_SERVER_ERROR
              ? ErrorCode.INTERNAL_ERROR
              : ErrorCode.VALIDATION_ERROR;

  return { code, message: exception.message, details: {} };
}

function extractValidationMessages(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const message = (body as { message?: unknown }).message;
  if (Array.isArray(message)) return message.map(String);
  if (typeof message === 'string') return [message];
  return [];
}
