import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../errors/app.exception';
import { PRINCIPAL_REQUEST_KEY, type Principal } from './principal';

/**
 * The only sanctioned way for a handler to learn its tenant. There is deliberately no
 * `dealershipId` field on any request DTO — a client cannot name a tenant (§7, §14).
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const request = ctx.switchToHttp().getRequest<Request & { principal?: Principal }>();
    const principal = request[PRINCIPAL_REQUEST_KEY];
    if (!principal) {
      throw AppException.forbidden('No authenticated principal on this request');
    }
    return principal;
  },
);
