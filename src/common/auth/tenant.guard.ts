import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../errors/app.exception';
import { PRINCIPAL_REQUEST_KEY, type Principal, PrincipalRole } from './principal';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { AppConfig } from '../../config/configuration';

/**
 * **Stubbed** authentication (§14, R-4) — the seam where a real IdP plugs in. What matters for
 * this iteration is the *shape* of the guarantee, not the crypto: a token is presented, a
 * `Principal` is resolved from it, and the tenant is taken from that principal and nowhere else.
 *
 * Token format for local runs / tests:
 *   Authorization: Bearer <base64url of {"dealershipId":"...","role":"STAFF"|"CUSTOMER","customerId":"..."}>
 *
 * Replacing this with JWT verification changes this file only; no caller learns the difference.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const auth = this.config.get<AppConfig['auth']>('auth');
    if (auth && !auth.enabled) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const principal = parseBearerToken(request.headers.authorization);

    (request as Request & { principal?: Principal })[PRINCIPAL_REQUEST_KEY] = principal;
    return true;
  }
}

export function parseBearerToken(header: string | undefined): Principal {
  if (!header?.startsWith('Bearer ')) {
    throw AppException.forbidden('Missing or malformed Authorization header');
  }

  const token = header.slice('Bearer '.length).trim();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw AppException.forbidden('Malformed access token');
  }

  if (typeof decoded !== 'object' || decoded === null) {
    throw AppException.forbidden('Malformed access token');
  }

  const claims = decoded as Record<string, unknown>;
  const dealershipId = claims.dealershipId;
  const role = claims.role;

  if (typeof dealershipId !== 'string' || dealershipId.length === 0) {
    throw AppException.forbidden('Token does not carry a dealership claim');
  }
  if (role !== PrincipalRole.STAFF && role !== PrincipalRole.CUSTOMER) {
    throw AppException.forbidden('Token does not carry a valid role claim');
  }

  const customerId = typeof claims.customerId === 'string' ? claims.customerId : undefined;
  if (role === PrincipalRole.CUSTOMER && !customerId) {
    throw AppException.forbidden('A CUSTOMER token must carry a customerId claim');
  }

  return {
    dealershipId,
    role,
    customerId,
    subject: typeof claims.sub === 'string' ? claims.sub : `${role}:${dealershipId}`,
  };
}

/** Test/demo helper — mints the stub token the guard above accepts. */
export function encodePrincipal(principal: Omit<Principal, 'subject'>): string {
  return Buffer.from(JSON.stringify(principal), 'utf8').toString('base64url');
}
