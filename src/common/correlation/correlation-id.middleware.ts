import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { resolveCorrelationId, runWithCorrelationId } from './correlation';

/**
 * Opens the AsyncLocalStorage scope every downstream handler, the exception filter and every
 * emitted event read their correlation id from. A client-supplied `x-correlation-id` is honoured
 * so a caller can stitch its own trace across services.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const correlationId = resolveCorrelationId(req, res);
    runWithCorrelationId(correlationId, () => next());
  }
}
