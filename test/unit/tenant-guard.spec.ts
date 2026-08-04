import { encodePrincipal, parseBearerToken } from '../../src/common/auth/tenant.guard';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { AppException } from '../../src/common/errors/app.exception';
import { PrincipalRole } from '../../src/common/auth/principal';

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
