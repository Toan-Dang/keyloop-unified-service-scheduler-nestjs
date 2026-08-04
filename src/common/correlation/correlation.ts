import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Correlation id, generated per request and propagated through the call stack *and onto emitted
 * events* (§13) so an async notification traces back to the booking that produced it.
 */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

interface RequestContext {
  correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

/** Returns the ambient correlation id, or a fresh one outside a request (cron, relay, tests). */
export function getCorrelationId(): string {
  return storage.getStore()?.correlationId ?? randomUUID();
}

export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Resolves *the* correlation id for a request and pins it to the request itself.
 *
 * Two independent consumers need this value — the pino request logger and the
 * AsyncLocalStorage middleware — and Nest offers no reliable way to order a dynamic module's
 * middleware against another's. So instead of depending on who runs first, whoever runs first
 * **seeds the header**, and the other reads it back. Both then agree, in either order, and the
 * value a client sees on the response is the value in the logs.
 */
export function resolveCorrelationId(req: IncomingMessage, res?: ServerResponse): string {
  const existing = req.headers[CORRELATION_ID_HEADER];
  const correlationId =
    (Array.isArray(existing) ? existing[0] : existing)?.trim() || newCorrelationId();

  req.headers[CORRELATION_ID_HEADER] = correlationId;
  if (res && !res.headersSent) {
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
  }
  return correlationId;
}
