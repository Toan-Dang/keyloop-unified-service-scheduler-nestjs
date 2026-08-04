import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { type Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

/**
 * RED instrumentation for the HTTP path (§13). Labels use the *route template*
 * (`/v1/appointments/:id`), never the raw URL — a per-id label would blow up Prometheus
 * cardinality.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const stopTimer = this.metrics.httpRequestDuration.startTimer();

    const record = (status: number): void => {
      const labels = {
        route: routeTemplate(request),
        method: request.method,
        status: String(status),
      };
      this.metrics.httpRequestsTotal.inc(labels);
      stopTimer(labels);
    };

    return next.handle().pipe(
      tap({
        complete: () => record(response.statusCode),
        error: (err: unknown) => record(statusOf(err, response.statusCode)),
      }),
    );
  }
}

function statusOf(err: unknown, fallback: number): number {
  if (typeof err === 'object' && err !== null && 'getStatus' in err) {
    const { getStatus } = err;
    if (typeof getStatus === 'function') {
      const status = Number(getStatus.call(err));
      if (Number.isFinite(status)) return status;
    }
  }
  return fallback >= 400 ? fallback : 500;
}

function routeTemplate(request: Request): string {
  // Express types `req.route` as `any`; narrow it explicitly rather than trusting it.
  const route: unknown = (request as unknown as { route?: { path?: unknown } }).route?.path;
  if (typeof route !== 'string' || route.length === 0) return request.path;
  const base = request.baseUrl.replace(/\/$/, '');
  return `${base}${route}`;
}
