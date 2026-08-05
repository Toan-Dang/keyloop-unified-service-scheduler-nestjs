import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { TenantGuard, encodePrincipal, parseBearerToken } from '../../src/common/auth/tenant.guard';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { AppException } from '../../src/common/errors/app.exception';
import {
  PRINCIPAL_REQUEST_KEY,
  PrincipalRole,
  type Principal,
} from '../../src/common/auth/principal';
import type { AppConfig } from '../../src/config/configuration';

/**
 * The tenant must come from the token and nowhere else (§7, §14). These tests pin the *shape* of
 * that guarantee; swapping the stub for a real IdP should leave them meaningful.
 */
describe('tenant resolution from the access token', () => {
  const dealershipId = '0190aaaa-0000-7000-8000-000000000001';

  it('resolves a STAFF principal from the bearer token', () => {
    const token = encodePrincipal({ dealershipId, role: PrincipalRole.STAFF });

    const principal = parseBearerToken(`Bearer ${token}`);

    expect(principal.dealershipId).toBe(dealershipId);
    expect(principal.role).toBe(PrincipalRole.STAFF);
    expect(principal.customerId).toBeUndefined();
  });

  it('requires a customerId on a CUSTOMER token so RBAC can scope reads to their own rows', () => {
    const token = encodePrincipal({ dealershipId, role: PrincipalRole.CUSTOMER });

    expect(() => parseBearerToken(`Bearer ${token}`)).toThrow(AppException);
  });

  it.each([
    ['no header', undefined],
    ['wrong scheme', 'Basic abc'],
    ['garbage token', 'Bearer not-base64-json'],
  ])('rejects %s with FORBIDDEN', (_label, header) => {
    try {
      parseBearerToken(header);
      throw new Error('expected the guard to reject this token');
    } catch (err) {
      expect(err).toBeInstanceOf(AppException);
      expect((err as AppException).code).toBe(ErrorCode.FORBIDDEN);
    }
  });

  it('rejects a token with no dealership claim — there is no default tenant', () => {
    const token = Buffer.from(JSON.stringify({ role: 'STAFF' })).toString('base64url');

    expect(() => parseBearerToken(`Bearer ${token}`)).toThrow(AppException);
  });
});

/**
 * `AUTH_ENABLED=false` must actually resolve a principal, not merely skip token parsing — the
 * previous behaviour left `request.principal` unset, so every `@CurrentPrincipal()` handler threw
 * 403 regardless of the flag (§14: the guarantee is "exactly one principal, tenant-scoped",
 * not "no principal at all").
 */
describe('TenantGuard — AUTH_ENABLED=false dev bypass', () => {
  const devDealershipId = '0190aaaa-0000-7000-8000-000000000099';

  function fakeContext(request: Record<string, unknown>): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
  }

  function guardWith(auth: AppConfig['auth']): TenantGuard {
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const config = { getOrThrow: () => auth } as unknown as ConfigService;
    return new TenantGuard(reflector, config);
  }

  it('injects a fixed STAFF principal for the configured dealership, with no header needed', () => {
    const guard = guardWith({ enabled: false, devDealershipId });
    const request: Record<string, unknown> = { headers: {} };

    expect(guard.canActivate(fakeContext(request))).toBe(true);
    expect((request as { [PRINCIPAL_REQUEST_KEY]?: Principal })[PRINCIPAL_REQUEST_KEY]).toEqual({
      dealershipId: devDealershipId,
      role: PrincipalRole.STAFF,
      subject: 'dev-bypass',
    });
  });

  it('still requires a real bearer token when auth is enabled', () => {
    const guard = guardWith({ enabled: true, devDealershipId: '' });
    const request: Record<string, unknown> = { headers: {} };

    expect(() => guard.canActivate(fakeContext(request))).toThrow(AppException);
  });
});
